/**
 * RC Audio Bridge — Main Entry Point
 *
 * Express server + WebSocket server for:
 *   1. Receiving "start supervision" requests from the CRM
 *   2. Managing RingCentral softphone and call supervision
 *   3. Streaming audio to AssemblyAI for real-time transcription
 *   4. Pushing live transcripts to CRM clients via WebSocket
 */

import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import config from './config.js';
import { initSoftphone } from './softphone.js';
import { startSupervision, listSupervisorDevices } from './supervise.js';
import { setupWsServer } from './ws-broadcaster.js';
import { addCall, getAllCalls, getCall, removeCall } from './call-store.js';
import { closeTranscriber } from './transcriber.js';

const app = express();
const server = createServer(app);

// ── Middleware ──────────────────────────────────────────────────
app.use(cors({
  origin: [config.server.crmUrl, 'http://localhost:3000', 'http://localhost:3001'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json());

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.server.apiKey) {
    return res.status(401).json({ error: 'Unauthorized — invalid API key' });
  }
  next();
}

// ── Routes ─────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeCalls: getAllCalls().length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/supervise
 * CRM calls this when a call is answered. Triggers supervision.
 *
 * Body: {
 *   telephonySessionId: string,
 *   partyId: string,
 *   extensionId: string,
 *   advisorName?: string,
 *   clientPhone?: string
 * }
 */
app.post('/api/supervise', authMiddleware, async (req, res) => {
  try {
    const { telephonySessionId, partyId, extensionId, advisorName, clientPhone } = req.body;

    if (!telephonySessionId || !partyId) {
      return res.status(400).json({ error: 'telephonySessionId and partyId are required' });
    }

    if (!extensionId) {
      return res.status(400).json({ error: 'extensionId (advisor extension) is required' });
    }

    const callId = telephonySessionId;

    if (getCall(callId)) {
      return res.status(409).json({ error: 'Call is already being monitored', callId });
    }

    addCall(callId, {
      telephonySessionId,
      partyId,
      extensionId,
      advisorName: advisorName || 'Unknown Advisor',
      clientPhone: clientPhone || 'Unknown',
    });

    console.log(`[api] Supervise request: session=${telephonySessionId} party=${partyId} agent=${extensionId}`);

    const superviseResult = await startSupervision(telephonySessionId, partyId, extensionId);

    res.json({
      success: true,
      callId,
      message: 'Supervision started — waiting for audio connection',
      supervisedPartyId: superviseResult?.party?.id || null,
    });
  } catch (err) {
    console.error('[api] Supervise error:', err);
    const callId = req.body?.telephonySessionId;
    if (callId) removeCall(callId);

    res.status(500).json({
      error: 'Failed to start supervision',
      details: err.message,
    });
  }
});

/**
 * GET /api/calls
 * Returns all active monitored calls.
 */
app.get('/api/calls', authMiddleware, (_req, res) => {
  res.json({ calls: getAllCalls() });
});

/**
 * DELETE /api/calls/:callId
 * Stop monitoring a specific call.
 */
app.delete('/api/calls/:callId', authMiddleware, (req, res) => {
  const { callId } = req.params;
  const call = getCall(callId);

  if (!call) {
    return res.status(404).json({ error: 'Call not found' });
  }

  closeTranscriber(callId);

  if (call.callSession) {
    try {
      call.callSession.hangup();
    } catch {
      // session might already be disposed
    }
  }

  removeCall(callId);
  res.json({ success: true, message: `Stopped monitoring callId=${callId}` });
});

/**
 * GET /api/devices
 * Debug endpoint: list supervisor's devices for finding the right device ID.
 */
app.get('/api/devices', authMiddleware, async (_req, res) => {
  try {
    const devices = await listSupervisorDevices();
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────

async function start() {
  try {
    setupWsServer(server);

    console.log('[bridge] Registering SIP softphone with RingCentral...');
    await initSoftphone();

    server.listen(config.server.port, () => {
      console.log('═══════════════════════════════════════════════════');
      console.log(' RC Audio Bridge is running');
      console.log(`   HTTP  →  http://0.0.0.0:${config.server.port}`);
      console.log(`   WS    →  ws://0.0.0.0:${config.server.port}/ws`);
      console.log(`   Health → http://0.0.0.0:${config.server.port}/health`);
      console.log('═══════════════════════════════════════════════════');
    });
  } catch (err) {
    console.error('[bridge] Fatal startup error:', err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[bridge] Unhandled rejection:', err);
});

process.on('SIGTERM', () => {
  console.log('[bridge] SIGTERM received — shutting down');
  server.close();
  process.exit(0);
});

start();
