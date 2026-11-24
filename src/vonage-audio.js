/**
 * Live transcript of calls on the Vonage backup phone (CRM service fallback
 * phase 5b, crm-TB docs/calls-on-vonage.md).
 *
 * When a Vonage call is answered, the CRM adds a websocket leg to it whose
 * address is this bridge's /vonage/audio. Vonage then streams the call's
 * audio here: first one text frame (event "websocket:connected", with the
 * headers the CRM set: callId, advisorName, clientPhone, direction), then
 * binary frames of 16-bit linear PCM at 16 kHz, mono, little-endian: the
 * format the transcriber already sends AssemblyAI, so the audio goes
 * straight in. From there everything is as for a RingCentral call: the
 * transcript is broadcast to the CRM by callId (the CRM's "vonage-<conversation
 * id>"), saved to live_call_transcripts, and read by the coaching tips and the
 * booking detection. The CRM keeps the live calls list itself from Vonage's
 * events, so it is not written here.
 *
 * The address carries ?token=<BRIDGE_API_KEY>; anything else is closed.
 */

import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { reportError } from './crm-alerts.js';
import { addCall, getCall, removeCall, setCallStatus } from './call-store.js';
import { closeTranscriber, connectTranscriber, sendAudioChunk } from './transcriber.js';
import { broadcast } from './ws-broadcaster.js';

export const VONAGE_AUDIO_PATH = '/vonage/audio';

/** The token in the address Vonage connects to, checked in constant time. */
export function vonageTokenOk(url, apiKey) {
  if (!apiKey) return false;
  let given = '';
  try {
    given = new URL(url, 'http://bridge').searchParams.get('token') || '';
  } catch {
    return false;
  }
  return given.length === apiKey.length && timingSafeEqual(Buffer.from(given), Buffer.from(apiKey));
}

/**
 * The call's details from Vonage's first frame. Vonage passes the headers
 * the CRM set on the websocket endpoint as top-level fields. Null when the
 * frame is not that, or names no call.
 */
export function readConnectedFrame(text) {
  let frame;
  try {
    frame = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!frame || frame.event !== 'websocket:connected') return null;
  const callId = typeof frame.callId === 'string' ? frame.callId.trim() : '';
  if (!/^vonage-[\w-]+$/.test(callId)) return null;
  const text_ = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  return {
    callId,
    advisorName: text_(frame.advisorName, 'Unknown'),
    clientPhone: text_(frame.clientPhone, 'Unknown'),
    direction: frame.direction === 'Inbound' ? 'Inbound' : 'Outbound',
  };
}

const wss = new WebSocketServer({ noServer: true });

// The open Vonage stream of each call, so the CRM can end it (DELETE /api/calls/:callId).
const streams = new Map();

/** Close a call's Vonage stream; Vonage then hangs up the websocket leg. */
export function closeVonageStream(callId) {
  const ws = streams.get(callId);
  if (!ws) return false;
  streams.delete(callId);
  try {
    ws.close(1000, 'Call ended');
  } catch {
    // already closed
  }
  return true;
}

/** The upgrade handler for /vonage/audio (ws-broadcaster.js routes it here). */
export function handleVonageAudioUpgrade(req, socket, head) {
  if (!vonageTokenOk(req.url || '', config.server.apiKey)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => streamCall(ws));
}

function streamCall(ws) {
  let callId = null;
  let ready = false;
  let ended = false;

  const end = (reason) => {
    if (ended || !callId) return;
    ended = true;
    streams.delete(callId);
    closeTranscriber(callId);
    const call = removeCall(callId);
    const duration = call ? Math.round((Date.now() - new Date(call.startTime).getTime()) / 1000) : 0;
    broadcast(callId, { type: 'call_ended', callId, endTime: new Date().toISOString(), duration });
    console.log(`[vonage-audio] Call ended callId=${callId} reason=${reason} duration=${duration}s`);
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (ready && callId) sendAudioChunk(callId, data);
      return;
    }
    if (callId) return;
    const details = readConnectedFrame(data);
    if (!details) {
      console.warn('[vonage-audio] First frame was not a websocket:connected with a call id; closing');
      ws.close(1008, 'No call id');
      return;
    }
    callId = details.callId;
    if (getCall(callId)) {
      console.warn(`[vonage-audio] Already streaming callId=${callId}; closing the second stream`);
      callId = null;
      ws.close(1008, 'Already streaming');
      return;
    }
    addCall(callId, {
      telephonySessionId: callId,
      partyId: 'vonage',
      // No RingCentral extension: the adviser's name comes from the CRM.
      extensionId: '',
      advisorName: details.advisorName,
      clientPhone: details.clientPhone,
      direction: details.direction,
      status: 'active',
    });
    setCallStatus(callId, 'active');
    streams.set(callId, ws);
    broadcast(callId, {
      type: 'call_started',
      callId,
      advisor: { name: details.advisorName, extensionId: '' },
      client: { phoneNumber: details.clientPhone },
      startTime: getCall(callId)?.startTime || new Date().toISOString(),
    });
    try {
      await connectTranscriber(callId);
      ready = true;
      console.log(`[vonage-audio] Audio pipeline active callId=${callId}`);
    } catch (err) {
      console.error(`[vonage-audio] Transcriber did not start callId=${callId}:`, err.message);
      void reportError('vonage-transcript', 'could not start the live transcript of a Vonage call', err);
      ws.close(1011, 'Transcriber unavailable');
    }
  });

  ws.on('close', () => end('closed'));
  ws.on('error', (err) => {
    console.error(`[vonage-audio] Stream error callId=${callId}:`, err.message);
    end('error');
  });
}
