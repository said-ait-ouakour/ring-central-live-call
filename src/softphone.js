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
  getOldestPendingCall,
  setCallSession,
  removeCall,
} from './call-store.js';
import { loadSipCredentials } from './sip-credentials.js';
import { connectTranscriber, closeTranscriber, sendAudioChunk } from './transcriber.js';
import { broadcast } from './ws-broadcaster.js';

let softphone = null;

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

  await softphone.register();
  console.log('[softphone] Registered with RingCentral SIP proxy');

  return softphone;
}

async function handleIncomingCall(inviteMessage) {
  let callId = null;
  let callSession = null;

  try {
    const pendingCall = getOldestPendingCall();
    if (!pendingCall) {
      console.warn('[softphone] Received INVITE but no pending supervision — declining');
      await softphone.decline(inviteMessage);
      return;
    }

    callId = pendingCall.callId;
    console.log(`[softphone] Answering supervised call for callId=${callId}`);

    callSession = await softphone.answer(inviteMessage);

    let sipSessionId = null;
    try {
      sipSessionId = callSession.sessionId;
    } catch {
      // sessionId may not be available on inbound — that's OK
    }

    setCallSession(callId, callSession);

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
      removeCall(callId);
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
