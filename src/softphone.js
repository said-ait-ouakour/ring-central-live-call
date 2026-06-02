/**
 * RingCentral SIP Softphone manager.
 *
 * Uses `ringcentral-softphone` (Cloud Phone SDK) which handles:
 *   - SIP over TLS registration
 *   - SRTP encrypted audio
 *   - Automatic OPUS→PCM decoding (16-bit, 16kHz, mono)
 *
 * When the Supervise API is called, RingCentral sends a SIP INVITE to this
 * softphone. We answer it and forward the decoded PCM audio to AssemblyAI.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Softphone = require('ringcentral-softphone').default;
import {
  getInviteWaitingCalls,
  getOldestPendingCall,
  markCallAnswering,
  setCallSession,
  removeCall,
} from './call-store.js';
import { loadSipCredentials } from './sip-credentials.js';
import { connectTranscriber, closeTranscriber, sendAudioChunk } from './transcriber.js';
import { broadcast } from './ws-broadcaster.js';
import { syncActiveCallEnded, syncActiveCallStarted } from './supabase-sync.js';

let softphone = null;
let lastRegisteredAt = 0;
let registrationPromise = null;

export async function initSoftphone() {
  const { domain, outboundProxy, username, password, authorizationId } = await loadSipCredentials();

  softphone = new Softphone({
    domain,
    outboundProxy,
    username,
    password,
    authorizationId,
    codec: 'OPUS/16000',
  });

  softphone.on('invite', async (inviteMessage) => {
    console.log('[softphone] Incoming INVITE (supervised call audio)');
    handleIncomingCall(inviteMessage);
  });

  await registerSoftphone('startup');

  return softphone;
}

async function registerSoftphone(reason) {
  if (!softphone) {
    throw new Error('Softphone is not initialized');
  }

  if (registrationPromise) return registrationPromise;

  registrationPromise = softphone.register()
    .then(() => {
      lastRegisteredAt = Date.now();
      console.log(`[softphone] Registered with RingCentral SIP proxy reason=${reason} registeredAt=${new Date(lastRegisteredAt).toISOString()}`);
      return softphone;
    })
    .catch((err) => {
      console.error(`[softphone] SIP registration failed reason=${reason}: ${err.message}`);
      throw err;
    })
    .finally(() => {
      registrationPromise = null;
    });

  return registrationPromise;
}

export async function ensureSoftphoneRegistered() {
  const maxRegistrationAgeMs = 4 * 60 * 1000;
  const ageMs = lastRegisteredAt ? Date.now() - lastRegisteredAt : Infinity;

  if (softphone && ageMs < maxRegistrationAgeMs) {
    console.log(`[softphone] SIP registration fresh ageMs=${ageMs}`);
    return softphone;
  }

  console.warn(`[softphone] SIP registration stale ageMs=${Number.isFinite(ageMs) ? ageMs : 'unknown'}; refreshing before supervision`);
  return registerSoftphone('pre-supervise');
}

function safeHeaderValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    return value.value || value.uri || value.address || value.raw || null;
  }
  return null;
}

function pickHeader(headers, names) {
  if (!headers) return null;
  for (const name of names) {
    const value = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
    if (Array.isArray(value) && value.length > 0) return safeHeaderValue(value[0]);
    const normalized = safeHeaderValue(value);
    if (normalized) return normalized;
  }
  return null;
}

function getInviteDiagnostics(inviteMessage) {
  const headers = inviteMessage?.headers || inviteMessage?.request?.headers || inviteMessage?.message?.headers;
  return {
    keys: Object.keys(inviteMessage || {}),
    callId: inviteMessage?.callId || inviteMessage?.id || pickHeader(headers, ['Call-ID', 'call-id']),
    sessionId: inviteMessage?.sessionId || pickHeader(headers, ['Session-ID', 'session-id']),
    from: safeHeaderValue(inviteMessage?.from) || pickHeader(headers, ['From', 'from']),
    to: safeHeaderValue(inviteMessage?.to) || pickHeader(headers, ['To', 'to']),
    contact: pickHeader(headers, ['Contact', 'contact']),
    assertedIdentity: pickHeader(headers, ['P-Asserted-Identity', 'p-asserted-identity']),
    replaces: pickHeader(headers, ['Replaces', 'replaces']),
  };
}

function resolvePendingCallForInvite(inviteMessage) {
  const pendingCalls = getInviteWaitingCalls();
  const diagnostics = getInviteDiagnostics(inviteMessage);
  const searchableValues = Object.values(diagnostics).filter((value) => typeof value === 'string');

  console.log('[softphone-debug] INVITE diagnostics:', diagnostics);

  const matchedCalls = pendingCalls.filter((call) =>
    searchableValues.some((value) =>
      value.includes(call.telephonySessionId) || value.includes(call.partyId)
    )
  );

  if (matchedCalls.length === 1) {
    console.log(`[softphone] Correlated INVITE to callId=${matchedCalls[0].callId} correlation=deterministic`);
    return matchedCalls[0];
  }

  if (matchedCalls.length > 1) {
    console.warn(`[softphone] Ambiguous deterministic INVITE correlation matches=${matchedCalls.map((c) => c.callId).join(',')}`);
    return null;
  }

  if (pendingCalls.length === 1) {
    const fallbackCall = getOldestPendingCall();
    console.log(`[softphone] Correlated INVITE to callId=${fallbackCall.callId} correlation=single-pending-fallback`);
    return fallbackCall;
  }

  console.warn(`[softphone] Cannot correlate INVITE pendingCalls=${pendingCalls.length} correlation=ambiguous`);
  return null;
}

async function handleIncomingCall(inviteMessage) {
  let callId = null;
  let callSession = null;

  try {
    const pendingCall = resolvePendingCallForInvite(inviteMessage);
    if (!pendingCall) {
      console.warn('[softphone] Received INVITE but no unambiguous pending supervision — declining');
      await softphone.decline(inviteMessage);
      return;
    }

    callId = pendingCall.callId;
    if (!markCallAnswering(callId)) {
      console.warn(`[softphone] Duplicate or stale INVITE for callId=${callId} — declining`);
      await softphone.decline(inviteMessage);
      return;
    }

    console.log(`[softphone] Answering supervised call for callId=${callId}`);

    callSession = await softphone.answer(inviteMessage);

    let sipSessionId = null;
    try {
      sipSessionId = callSession.sessionId;
    } catch {
      // sessionId may not be available on inbound — that's OK
    }

    setCallSession(callId, callSession);
    syncActiveCallStarted(callId);

    broadcast(callId, {
      type: 'call_started',
      callId,
      advisor: { name: pendingCall.advisorName, extensionId: pendingCall.extensionId },
      client: { phoneNumber: pendingCall.clientPhone },
      startTime: pendingCall.startTime,
    });

    await connectTranscriber(callId);

    callSession.on('audioPacket', (rtpPacket) => {
      sendAudioChunk(callId, rtpPacket.payload);
    });

    callSession.once('disposed', () => {
      console.log(`[softphone] Call session disposed for callId=${callId}`);
      handleCallEnd(callId);
    });

    console.log(`[softphone] Audio pipeline active for callId=${callId}`);
  } catch (err) {
    console.error('[softphone] Error handling incoming call:', err);
    if (callSession) {
      try {
        callSession.hangup();
      } catch {
        // session may already be disposed
      }
    }
    if (callId) {
      closeTranscriber(callId);
      const removedCall = removeCall(callId);
      syncActiveCallEnded(removedCall);
      broadcast(callId, {
        type: 'call_ended',
        callId,
        endTime: new Date().toISOString(),
        duration: 0,
        error: err.message,
      });
    }
  }
}

function handleCallEnd(callId) {
  closeTranscriber(callId);

  const call = removeCall(callId);
  if (!call) {
    console.log(`[softphone] Ignoring duplicate call end for callId=${callId}`);
    return;
  }
  syncActiveCallEnded(call);

  const duration = call
    ? Math.round((Date.now() - new Date(call.startTime).getTime()) / 1000)
    : 0;

  broadcast(callId, {
    type: 'call_ended',
    callId,
    endTime: new Date().toISOString(),
    duration,
  });

  console.log(`[softphone] Call ended: callId=${callId} duration=${duration}s`);
}

export function getSoftphone() {
  return softphone;
}
