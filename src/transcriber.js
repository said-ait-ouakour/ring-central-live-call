/**
 * AssemblyAI real-time transcription via raw WebSocket.
 *
 * Uses AssemblyAI's v3 streaming API:
 *   - Connect to wss://streaming.assemblyai.com/v3/ws
 *   - Send binary PCM audio chunks
 *   - Receive turn-based transcript messages
 *
 * Each supervised call gets its own AssemblyAI WebSocket session.
 */

import WebSocket from 'ws';
import config from './config.js';
import { setAssemblyWs, addTranscriptEntry } from './call-store.js';
import { broadcast } from './ws-broadcaster.js';
import { syncTranscriptEntry } from './supabase-sync.js';

const ASSEMBLYAI_WS_URL = 'wss://streaming.assemblyai.com/v3/ws';
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHANNELS = 1;
const TARGET_CHUNK_MS = 100;
const TARGET_CHUNK_BYTES = Math.floor((SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * TARGET_CHUNK_MS) / 1000);
const SPEECH_MODEL = process.env.ASSEMBLYAI_SPEECH_MODEL || 'universal-streaming-english';

const activeTranscribers = new Map();
const audioBuffers = new Map();
const audioStats = new Map();

function getAudioStats(callId) {
  if (!audioStats.has(callId)) {
    audioStats.set(callId, {
      receivedBytes: 0,
      sentBytes: 0,
      sentChunks: 0,
      transcriptTurns: 0,
      firstAudioLogged: false,
      lastStatsLogAt: 0,
    });
  }
  return audioStats.get(callId);
}

/**
 * Create and connect an AssemblyAI real-time transcription session for a call.
 * Returns the WebSocket so the softphone can push audio to it.
 */
export function connectTranscriber(callId) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      speech_model: SPEECH_MODEL,
      format_turns: 'true',
    });

    const ws = new WebSocket(`${ASSEMBLYAI_WS_URL}?${params.toString()}`, {
      headers: {
        Authorization: config.assemblyai.apiKey,
      },
    });
    let resolved = false;

    ws.on('open', () => {
      console.log(`[transcriber] AssemblyAI WebSocket connected for callId=${callId}`);
      activeTranscribers.set(callId, ws);
      setAssemblyWs(callId, ws);
      resolved = true;
      resolve(ws);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleTranscriptMessage(callId, msg);
      } catch (err) {
        console.error(`[transcriber] Parse error for callId=${callId}:`, err.message);
      }
    });

    ws.on('error', (err) => {
      console.error(`[transcriber] WebSocket error for callId=${callId}:`, err.message);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ws.on('close', (code, reason) => {
      const closeReason = reason?.toString?.() || '';
      console.log(`[transcriber] WebSocket closed for callId=${callId} code=${code} reason=${closeReason}`);
      activeTranscribers.delete(callId);
      audioBuffers.delete(callId);
      audioStats.delete(callId);
      if (!resolved) {
        resolved = true;
        reject(new Error(`AssemblyAI WS closed before open: ${code} ${closeReason}`.trim()));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('AssemblyAI WebSocket connection timeout'));
      }
    }, 10_000);
  });
}

export function sendAudioChunk(callId, chunk) {
  const ws = activeTranscribers.get(callId);
  if (!ws || ws.readyState !== WebSocket.OPEN || !chunk?.length) return;

  const stats = getAudioStats(callId);
  stats.receivedBytes += chunk.length;

  const buffered = audioBuffers.get(callId);
  const nextBuffer = buffered ? Buffer.concat([buffered, Buffer.from(chunk)]) : Buffer.from(chunk);

  let offset = 0;
  while (nextBuffer.length - offset >= TARGET_CHUNK_BYTES) {
    ws.send(nextBuffer.subarray(offset, offset + TARGET_CHUNK_BYTES), { binary: true });
    stats.sentBytes += TARGET_CHUNK_BYTES;
    stats.sentChunks += 1;
    if (!stats.firstAudioLogged) {
      stats.firstAudioLogged = true;
      console.log(`[transcriber] First audio sent callId=${callId} chunkBytes=${TARGET_CHUNK_BYTES}`);
    }
    offset += TARGET_CHUNK_BYTES;
  }

  audioBuffers.set(callId, nextBuffer.subarray(offset));

  const now = Date.now();
  if (now - stats.lastStatsLogAt > 10_000 && stats.sentChunks > 0) {
    stats.lastStatsLogAt = now;
    console.log(`[transcriber] Audio stats callId=${callId} receivedBytes=${stats.receivedBytes} sentChunks=${stats.sentChunks} sentBytes=${stats.sentBytes}`);
  }
}

function handleTranscriptMessage(callId, msg) {
  const { type, transcript, end_of_turn, turn_order } = msg;

  if (type === 'Begin') {
    console.log(`[transcriber] Session started for callId=${callId}, sessionId=${msg.id}`);
    return;
  }

  if (type === 'Turn' && transcript) {
    const stats = getAudioStats(callId);
    stats.transcriptTurns += 1;
    console.log(`[transcriber] Transcript turn callId=${callId} final=${Boolean(end_of_turn)} chars=${transcript.length} turns=${stats.transcriptTurns}`);

    const entry = {
      type: 'transcript',
      callId,
      text: transcript,
      isFinal: Boolean(end_of_turn),
      turnOrder: turn_order,
      timestamp: new Date().toISOString(),
    };

    if (entry.isFinal) {
      addTranscriptEntry(callId, entry);
      syncTranscriptEntry(callId, entry);
    }
    broadcast(callId, entry);
    return;
  }

  if (type === 'Turn') {
    const stats = getAudioStats(callId);
    stats.transcriptTurns += 1;
    console.log(`[transcriber] Empty transcript turn callId=${callId} final=${Boolean(end_of_turn)} turns=${stats.transcriptTurns}`);
    return;
  }

  if (type === 'Termination') {
    console.log(`[transcriber] Session terminated for callId=${callId}`);
    return;
  }
}

/**
 * Gracefully close the AssemblyAI session for a call.
 */
export function closeTranscriber(callId) {
  const ws = activeTranscribers.get(callId);
  if (!ws) return;

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'Terminate' }));
    }
    ws.close();
  } catch (err) {
    console.error(`[transcriber] Error closing transcriber for callId=${callId}:`, err.message);
  }

  activeTranscribers.delete(callId);
  audioBuffers.delete(callId);
  audioStats.delete(callId);
}
