/**
 * AssemblyAI real-time transcription via raw WebSocket.
 *
 * Uses AssemblyAI's v2 streaming API:
 *   - Connect to wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000
 *   - Send base64-encoded PCM audio chunks
 *   - Receive partial and final transcripts
 *
 * Each supervised call gets its own AssemblyAI WebSocket session.
 */

import WebSocket from 'ws';
import config from './config.js';
import { setAssemblyWs, addTranscriptEntry } from './call-store.js';
import { broadcast } from './ws-broadcaster.js';

const ASSEMBLYAI_WS_URL = 'wss://api.assemblyai.com/v2/realtime/ws';
const SAMPLE_RATE = 16000;

const activeTranscribers = new Map();

/**
 * Create and connect an AssemblyAI real-time transcription session for a call.
 * Returns the WebSocket so the softphone can push audio to it.
 */
export function connectTranscriber(callId) {
  return new Promise((resolve, reject) => {
    const url = `${ASSEMBLYAI_WS_URL}?sample_rate=${SAMPLE_RATE}&token=${config.assemblyai.apiKey}`;

    const ws = new WebSocket(url);
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
      console.log(`[transcriber] WebSocket closed for callId=${callId} code=${code}`);
      activeTranscribers.delete(callId);
      if (!resolved) {
        resolved = true;
        reject(new Error(`AssemblyAI WS closed before open: ${code}`));
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

function handleTranscriptMessage(callId, msg) {
  const { message_type, text, audio_start, audio_end, confidence, words, created } = msg;

  if (message_type === 'SessionBegins') {
    console.log(`[transcriber] Session started for callId=${callId}, sessionId=${msg.session_id}`);
    return;
  }

  if (message_type === 'PartialTranscript' && text) {
    broadcast(callId, {
      type: 'transcript',
      callId,
      text,
      isFinal: false,
      audioStart: audio_start,
      audioEnd: audio_end,
      timestamp: created || new Date().toISOString(),
    });
    return;
  }

  if (message_type === 'FinalTranscript' && text) {
    const entry = {
      type: 'transcript',
      callId,
      text,
      isFinal: true,
      confidence,
      words: words || [],
      audioStart: audio_start,
      audioEnd: audio_end,
      timestamp: created || new Date().toISOString(),
    };

    addTranscriptEntry(callId, entry);
    broadcast(callId, entry);
    return;
  }

  if (message_type === 'SessionTerminated') {
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
      ws.send(JSON.stringify({ terminate_session: true }));
    }
    ws.close();
  } catch (err) {
    console.error(`[transcriber] Error closing transcriber for callId=${callId}:`, err.message);
  }

  activeTranscribers.delete(callId);
}
