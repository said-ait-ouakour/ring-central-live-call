import { io } from 'socket.io-client';
import { createFirefliesTranscriptNormalizer } from './fireflies-normalizer.mjs';

const DEFAULT_REALTIME_URL = 'wss://api.fireflies.ai';

export function createFirefliesRealtimeSession(options) {
  const {
    apiKey,
    transcriptId,
    realtimeUrl = DEFAULT_REALTIME_URL,
    logger = console,
    onConnected,
    onAuthSuccess,
    onTranscript,
    onError,
    onEnded,
  } = options || {};

  if (!apiKey) throw new Error('apiKey is required');
  if (!transcriptId) throw new Error('transcriptId is required');

  const normalizer = createFirefliesTranscriptNormalizer({ sessionId: transcriptId });
  let socket = null;
  let closed = false;

  function start() {
    socket = io(realtimeUrl, {
      path: '/ws/realtime',
      transports: ['websocket'],
      auth: {
        token: bearerToken(apiKey),
        transcriptId,
      },
    });

    socket.on('connect', () => {
      logger.info?.('[fireflies-realtime] socket connected', { transcriptId, socketId: socket.id });
      onConnected?.({ transcriptId, socketId: socket.id });
    });

    socket.on('auth.success', (data) => {
      logger.info?.('[fireflies-realtime] auth success', { transcriptId });
      onAuthSuccess?.(data);
    });

    socket.on('connection.established', (data) => {
      logger.info?.('[fireflies-realtime] connection established', { transcriptId });
      onConnected?.({ transcriptId, data });
    });

    socket.on('transcription.broadcast', async (event) => {
      const result = normalizer.normalize(event);
      if (!result) return;

      if (result.finalizedPrevious) {
        await onTranscript?.(result.finalizedPrevious);
      }

      await onTranscript?.(result.current);
    });

    socket.on('auth.failed', (error) => handleError('auth.failed', error));
    socket.on('connection.error', (error) => handleError('connection.error', error));
    socket.on('connect_error', (error) => handleError('connect_error', error));

    socket.on('disconnect', (reason) => {
      logger.warn?.('[fireflies-realtime] socket disconnected', { transcriptId, reason });
      if (!closed) onError?.(new Error(`Fireflies realtime disconnected: ${reason}`));
    });

    return socket;
  }

  async function stop() {
    closed = true;
    const finalLine = normalizer.flushFinal();
    if (finalLine) await onTranscript?.(finalLine);
    socket?.disconnect();
    await onEnded?.({ transcriptId, endedAt: new Date().toISOString() });
  }

  function reconnect() {
    closed = true;
    socket?.disconnect();
    socket = null;
    closed = false;
    return start();
  }

  function handleError(label, error) {
    logger.error?.(`[fireflies-realtime] ${label}`, error, { transcriptId });
    onError?.(error instanceof Error ? error : new Error(`${label}: ${JSON.stringify(error)}`));
  }

  return {
    start,
    reconnect,
    stop,
    get socket() {
      return socket;
    },
  };
}

function bearerToken(token) {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}
