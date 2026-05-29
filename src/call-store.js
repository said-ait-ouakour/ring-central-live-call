/**
 * In-memory store for active supervised calls.
 * Each entry tracks the call session, transcriber, and metadata.
 */

const activeCalls = new Map();

export function addCall(callId, data) {
  activeCalls.set(callId, {
    callId,
    telephonySessionId: data.telephonySessionId,
    partyId: data.partyId,
    extensionId: data.extensionId,
    advisorName: data.advisorName || 'Unknown',
    clientPhone: data.clientPhone || 'Unknown',
    callSession: null,
    assemblyWs: null,
    transcript: [],
    startTime: new Date().toISOString(),
    status: 'supervising',
  });
  return activeCalls.get(callId);
}

export function getCall(callId) {
  return activeCalls.get(callId);
}

export function setCallSession(callId, callSession) {
  const call = activeCalls.get(callId);
  if (call) {
    call.callSession = callSession;
    call.status = 'connected';
  }
}

export function setAssemblyWs(callId, assemblyWs) {
  const call = activeCalls.get(callId);
  if (call) {
    call.assemblyWs = assemblyWs;
    call.status = 'transcribing';
  }
}

export function addTranscriptEntry(callId, entry) {
  const call = activeCalls.get(callId);
  if (call) {
    if (entry.isFinal) {
      call.transcript.push(entry);
    }
  }
}

export function removeCall(callId) {
  const call = activeCalls.get(callId);
  if (call) {
    call.status = 'ended';
    activeCalls.delete(callId);
  }
  return call;
}

export function getAllCalls() {
  return Array.from(activeCalls.values()).map((c) => ({
    callId: c.callId,
    telephonySessionId: c.telephonySessionId,
    partyId: c.partyId,
    extensionId: c.extensionId,
    advisorName: c.advisorName,
    clientPhone: c.clientPhone,
    startTime: c.startTime,
    status: c.status,
    transcriptLength: c.transcript.length,
  }));
}

export function getCallBySessionId(sessionId) {
  for (const call of activeCalls.values()) {
    if (call.telephonySessionId === sessionId) return call;
  }
  return null;
}

export function getPendingCallCount() {
  let count = 0;
  for (const call of activeCalls.values()) {
    if (call.status === 'supervising') {
      count += 1;
    }
  }
  return count;
}

/**
 * Returns the oldest call in "supervising" state (waiting for SIP INVITE).
 * Used to match incoming INVITEs to pending supervisions.
 */
export function getOldestPendingCall() {
  let oldest = null;
  for (const call of activeCalls.values()) {
    if (call.status === 'supervising') {
      if (!oldest || call.startTime < oldest.startTime) {
        oldest = call;
      }
    }
  }
  return oldest;
}
