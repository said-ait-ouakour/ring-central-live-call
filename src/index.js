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
import { addCall, getAllCalls, getCall, removeCall, setCallStatus } from './call-store.js';
import { closeTranscriber } from './transcriber.js';
import { registerWebhookSubscription } from './rc-subscription.js';
import { getAuthStatus } from './rc-auth.js';
import { rcFetch } from './rc-auth.js';

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
      direction: 'Outbound',
    });

    const authStatus = getAuthStatus();
    console.log(`[api] Supervise request: session=${telephonySessionId} party=${partyId} agent=${extensionId}`);
    console.log(`[rc-auth] token valid=${authStatus.valid} expiresAt=${authStatus.expiresAt} refreshStatus=${authStatus.valid ? 'not-needed' : 'needed'}`);

    const superviseResult = await startSupervisionWithRetry(telephonySessionId, partyId, extensionId);

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

/**
 * POST /webhook/ringcentral
 * Receives push notification events from RingCentral.
 * RingCentral sends a Validation-Token header on first delivery; echo it back.
 */
app.post('/webhook/ringcentral', express.json(), async (req, res) => {
  // Validation handshake — RC POSTs with this header when subscription is created
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.setHeader('Validation-Token', validationToken);
    return res.status(200).send('OK');
  }

  // Acknowledge immediately — RC expects a fast response
  res.status(200).send('OK');

  try {
    await handleTelephonyEvent(req.body);
  } catch (err) {
    console.error('[webhook] Error processing event:', err.message);
  }
});

// Tracks session/party pairs so repeated webhook events don't duplicate attempts.
const _inFlightSupervisions = new Set();
const _recentSupervisions = new Map();
const SUPERVISION_DEDUPE_TTL_MS = 10 * 60 * 1000;
const INITIAL_SUPERVISE_DELAY_MS = 1500;
const INVITE_WAIT_TIMEOUT_MS = 30_000;
const inviteWaitTimers = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWrongStateError(err) {
  return err?.message?.includes('TAS-102') || err?.message?.includes('WrongState');
}

function isTerminalSessionError(err) {
  return err?.message?.includes('CMN-102') || err?.message?.includes('sessionId] is not found') || err?.message?.includes('failed (404)');
}

function isEndedPartyStatus(statusCode) {
  return ['Disconnected', 'Gone', 'Voicemail', 'Parked'].includes(statusCode);
}

async function assertSessionStillSupervisable(telephonySessionId, partyId) {
  const call = getCall(telephonySessionId);
  if (!call || call.status === 'ended' || call.status === 'failed') {
    throw new Error(`Supervision stopped locally for session=${telephonySessionId}`);
  }

  const session = await rcFetch(`/restapi/v1.0/account/~/telephony/sessions/${telephonySessionId}`);
  const party = session?.parties?.find((p) => p.id === partyId);

  if (!party) {
    throw new Error(`RingCentral party not found for session=${telephonySessionId} party=${partyId}`);
  }

  if (isEndedPartyStatus(party.status?.code)) {
    throw new Error(`RingCentral party is no longer supervisable session=${telephonySessionId} party=${partyId} status=${party.status?.code}`);
  }

  return session;
}

function scheduleInviteWaitTimeout(callId) {
  clearInviteWaitTimeout(callId);
  inviteWaitTimers.set(callId, setTimeout(() => {
    inviteWaitTimers.delete(callId);
    const call = getCall(callId);
    if (!call || !['supervise_pending', 'invite_waiting'].includes(call.status)) return;

    console.warn(`[supervise] SIP INVITE wait timed out session=${call.telephonySessionId} party=${call.partyId}`);
    setCallStatus(callId, 'failed');
    removeCall(callId, 'failed');
  }, INVITE_WAIT_TIMEOUT_MS));
}

function clearInviteWaitTimeout(callId) {
  const timer = inviteWaitTimers.get(callId);
  if (timer) clearTimeout(timer);
  inviteWaitTimers.delete(callId);
}

async function startSupervisionWithRetry(telephonySessionId, partyId, extensionId) {
  const maxAttempts = 7;
  const delayMs = 2500;

  setCallStatus(telephonySessionId, 'supervise_pending');
  scheduleInviteWaitTimeout(telephonySessionId);
  await sleep(INITIAL_SUPERVISE_DELAY_MS);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await assertSessionStillSupervisable(telephonySessionId, partyId);
      if (attempt > 1) {
        console.log(`[webhook] Retrying supervision attempt=${attempt}/${maxAttempts} session=${telephonySessionId}`);
      }
      const authStatus = getAuthStatus();
      console.log(`[rc-auth] token valid=${authStatus.valid} expiresAt=${authStatus.expiresAt} refreshStatus=${authStatus.valid ? 'not-needed' : 'needed'}`);
      const result = await startSupervision(telephonySessionId, partyId, extensionId, attempt);
      setCallStatus(telephonySessionId, 'invite_waiting');
      return result;
    } catch (err) {
      if (isTerminalSessionError(err) || !isWrongStateError(err) || attempt === maxAttempts) {
        throw err;
      }
      console.warn(`[webhook] RingCentral session not ready yet attempt=${attempt}/${maxAttempts} session=${telephonySessionId}: ${err.message}`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Supervision retry exhausted for session=${telephonySessionId}`);
}

async function handleTelephonyEvent(event) {
  const body = event?.body;
  if (!body?.telephonySessionId) return;

  const { telephonySessionId, parties } = body;
  const monitoredExtId = config.supervisor.monitoredExtensionId;
  const supervisorExtId = config.supervisor.extensionId;

  // Find the agent's party that just got answered.
  // Require extensionId to be present — external callers have no extensionId.
  const agentParty = parties?.find((p) =>
    p.status?.code === 'Answered' &&
    p.extensionId &&
    p.extensionId !== supervisorExtId &&
    (!monitoredExtId || p.extensionId === monitoredExtId)
  );

  if (!agentParty) return;

  const partyId = agentParty.id;
  const supervisionKey = `${telephonySessionId}:${partyId}`;
  const recentUntil = _recentSupervisions.get(supervisionKey) || 0;
  if (recentUntil <= Date.now()) {
    _recentSupervisions.delete(supervisionKey);
  }

  // Avoid duplicate attempts for the same session across multiple webhook events.
  if (_recentSupervisions.has(supervisionKey) || _inFlightSupervisions.has(supervisionKey)) return;
  if (getCall(telephonySessionId)) return;

  _inFlightSupervisions.add(supervisionKey);

  const extensionId = agentParty.extensionId || monitoredExtId;
  const clientPhone =
    agentParty.direction === 'Inbound'
      ? agentParty.from?.phoneNumber
      : agentParty.to?.phoneNumber;

  console.log(`[webhook] Auto-supervising call: session=${telephonySessionId} party=${partyId} ext=${extensionId}`);

  addCall(telephonySessionId, {
    telephonySessionId,
    partyId,
    extensionId,
    advisorName: `Extension ${extensionId}`,
    clientPhone: clientPhone || 'Unknown',
    direction: agentParty.direction || 'Outbound',
  });

  try {
    await startSupervisionWithRetry(telephonySessionId, partyId, extensionId);
    _recentSupervisions.set(supervisionKey, Date.now() + SUPERVISION_DEDUPE_TTL_MS);
    setTimeout(() => _recentSupervisions.delete(supervisionKey), SUPERVISION_DEDUPE_TTL_MS);
  } catch (err) {
    console.error('[webhook] Auto-supervision failed:', err.message);
    setCallStatus(telephonySessionId, 'failed');
    clearInviteWaitTimeout(telephonySessionId);
    removeCall(telephonySessionId, 'failed');
  } finally {
    _inFlightSupervisions.delete(supervisionKey);
  }
}

// ── Start ──────────────────────────────────────────────────────

async function start() {
  try {
    setupWsServer(server);

    console.log('[bridge] Registering SIP softphone with RingCentral...');
    await initSoftphone();

    await new Promise((resolve) => {
      server.listen(config.server.port, resolve);
    });

    console.log('═══════════════════════════════════════════════════');
    console.log(' RC Audio Bridge is running');
    console.log(`   HTTP    →  http://0.0.0.0:${config.server.port}`);
    console.log(`   WS      →  ws://0.0.0.0:${config.server.port}/ws`);
    console.log(`   Health  →  http://0.0.0.0:${config.server.port}/health`);
    console.log(`   Webhook →  http://0.0.0.0:${config.server.port}/webhook/ringcentral`);
    console.log('═══════════════════════════════════════════════════');

    // Register RC webhook subscription so calls are auto-detected
    await registerWebhookSubscription();
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
