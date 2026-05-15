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
const Softphone = require('ringcentral-softphone');
import config from './config.js';
import {
  getOldestPendingCall,
  setCallSession,
  removeCall,
} from './call-store.js';
import { connectTranscriber, closeTranscriber } from './transcriber.js';
import { broadcast } from './ws-broadcaster.js';

let softphone = null;

export async function initSoftphone() {
  const { domain, outboundProxy, username, password, authorizationId } = config.sip;

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
  try {
    const pendingCall = getOldestPendingCall();
    if (!pendingCall) {
      console.warn('[softphone] Received INVITE but no pending supervision — declining');
      await softphone.decline(inviteMessage);
      return;
    }

    const callId = pendingCall.callId;
    console.log(`[softphone] Answering supervised call for callId=${callId}`);

    const callSession = await softphone.answer(inviteMessage);

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

    const assemblyWs = await connectTranscriber(callId);

    callSession.on('audioPacket', (rtpPacket) => {
      if (assemblyWs && assemblyWs.readyState === 1) {
        const pcmPayload = rtpPacket.payload;
        const base64Audio = Buffer.from(pcmPayload).toString('base64');
        assemblyWs.send(JSON.stringify({ audio_data: base64Audio }));
      }
    });

    callSession.once('disposed', () => {
      console.log(`[softphone] Call session disposed for callId=${callId}`);
      handleCallEnd(callId);
    });

    console.log(`[softphone] Audio pipeline active for callId=${callId}`);
  } catch (err) {
    console.error('[softphone] Error handling incoming call:', err);
  }
}

function handleCallEnd(callId) {
  closeTranscriber(callId);

  const call = removeCall(callId);
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
