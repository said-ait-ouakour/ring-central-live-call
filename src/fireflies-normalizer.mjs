export function createFirefliesTranscriptNormalizer(options = {}) {
  const state = {
    sessionId: options.sessionId || '',
    currentChunkId: '',
    nextTurnOrder: 1,
    firstReceiveAt: null,
    firstAudioStart: 0,
    chunks: new Map(),
  };

  function normalize(event) {
    const data = event?.payload && typeof event.payload === 'object' ? event.payload : event;
    const receiveAt = new Date();
    const sessionId = stringOr(data?.transcript_id, state.sessionId);
    const chunkId = stringOr(
      data?.chunk_id,
      `${sessionId}:${data?.start_time || ''}:${data?.end_time || ''}`
    );
    const text = stringOr(data?.text, '').trim();
    if (!sessionId || !chunkId || !text) return null;

    const audioStart = optionalNumber(data?.start_time);
    const audioEnd = optionalNumber(data?.end_time);

    if (!state.firstReceiveAt) {
      state.firstReceiveAt = receiveAt;
      state.firstAudioStart = audioStart ?? 0;
    }

    const existing = state.chunks.get(chunkId);
    const previousChunkId = state.currentChunkId;
    const finalizedPrevious =
      previousChunkId && previousChunkId !== chunkId
        ? state.chunks.get(previousChunkId)
        : null;

    const current = {
      provider: 'fireflies',
      providerChunkId: chunkId,
      sessionId,
      text,
      isFinal: false,
      speaker: optionalString(data?.speaker_name),
      speakerRole: 'unknown',
      turnOrder: existing?.turnOrder ?? state.nextTurnOrder++,
      confidence: optionalNumber(data?.confidence),
      audioStart,
      audioEnd,
      timestamp: receiveAt.toISOString(),
      providerReceivedAt: receiveAt.toISOString(),
      latencyEstimateMs: estimateLatencyMs(state, receiveAt, audioEnd ?? audioStart),
      isUpdate: Boolean(existing),
      raw: event,
    };

    state.sessionId = sessionId;
    state.currentChunkId = chunkId;
    state.chunks.set(chunkId, current);

    return {
      finalizedPrevious: finalizedPrevious
        ? { ...finalizedPrevious, isFinal: true, timestamp: receiveAt.toISOString() }
        : null,
      current,
    };
  }

  function flushFinal() {
    if (!state.currentChunkId) return null;
    const current = state.chunks.get(state.currentChunkId);
    return current ? { ...current, isFinal: true, timestamp: new Date().toISOString() } : null;
  }

  return {
    normalize,
    flushFinal,
    getState: () => state,
  };
}

export function toBridgeTranscriptEvent(line) {
  return {
    type: 'meeting_transcript',
    sessionId: line.sessionId,
    text: line.text,
    isFinal: line.isFinal,
    speaker: line.speaker,
    speakerRole: line.speakerRole || 'unknown',
    confidence: line.confidence,
    audioStart: line.audioStart,
    audioEnd: line.audioEnd,
    timestamp: line.timestamp,
  };
}

function stringOr(value, fallback) {
  if (value == null) return fallback;
  return String(value);
}

function optionalString(value) {
  if (value == null || value === '') return undefined;
  return String(value);
}

function optionalNumber(value) {
  if (value == null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function estimateLatencyMs(state, receiveAt, audioTimeSeconds) {
  if (!state.firstReceiveAt || audioTimeSeconds == null) return undefined;
  const elapsedWallMs = receiveAt.getTime() - state.firstReceiveAt.getTime();
  const elapsedAudioMs = (audioTimeSeconds - (state.firstAudioStart || 0)) * 1000;
  return Math.round(elapsedWallMs - elapsedAudioMs);
}
