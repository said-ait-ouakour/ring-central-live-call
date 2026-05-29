/**
 * WebSocket server for pushing live transcription to CRM clients.
 *
 * Protocol:
 *   Client → Bridge:
 *     { "type": "subscribe",   "callId": "..." }
 *     { "type": "unsubscribe", "callId": "..." }
 *
 *   Bridge → Client:
 *     { "type": "call_started",  "callId": "...", ... }
 *     { "type": "transcript",    "callId": "...", "text": "...", "isFinal": true/false }
 *     { "type": "call_ended",    "callId": "...", "duration": 120 }
 *     { "type": "error",         "message": "..." }
 *     { "type": "active_calls",  "calls": [...] }
 */

import { WebSocketServer } from 'ws';
import { parse } from 'url';
import config from './config.js';
import { getAllCalls } from './call-store.js';

let wss = null;
let heartbeatInterval = null;

// Map<callId, Set<WebSocket>>
const subscriptions = new Map();

// All connected clients
const clients = new Set();

export function setupWsServer(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const query = parse(req.url || '', true).query;
    if (query.apiKey !== config.server.apiKey) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    clients.add(ws);
    ws.isAlive = true;
    console.log(`[ws] Client connected (total: ${clients.size})`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(JSON.stringify({
      type: 'active_calls',
      calls: getAllCalls(),
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleClientMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      for (const [, subs] of subscriptions) {
        subs.delete(ws);
      }
      console.log(`[ws] Client disconnected (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[ws] Client error:', err.message);
    });
  });

  heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        for (const [, subs] of subscriptions) {
          subs.delete(ws);
        }
        console.log(`[ws] Terminated stale client (total: ${clients.size})`);
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  });

  console.log('[ws] WebSocket server ready on /ws');
}

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'subscribe': {
      const callId = msg.callId;
      if (!callId) return;
      if (!subscriptions.has(callId)) subscriptions.set(callId, new Set());
      subscriptions.get(callId).add(ws);
      console.log(`[ws] Client subscribed to callId=${callId}`);
      break;
    }
    case 'unsubscribe': {
      const callId = msg.callId;
      if (!callId) return;
      subscriptions.get(callId)?.delete(ws);
      break;
    }
    default:
      break;
  }
}

/**
 * Broadcast a message to all clients subscribed to a specific call,
 * AND to all connected clients for call_started / call_ended events.
 */
export function broadcast(callId, data) {
  const json = JSON.stringify(data);

  if (data.type === 'call_started' || data.type === 'call_ended') {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(json);
    }
    return;
  }

  const subs = subscriptions.get(callId);
  if (!subs || subs.size === 0) return;

  for (const ws of subs) {
    if (ws.readyState === 1) ws.send(json);
  }
}
