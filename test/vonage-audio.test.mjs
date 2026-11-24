import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.BRIDGE_API_KEY = 'test-bridge-key';
process.env.DISABLE_RINGCENTRAL = 'true';

const WebSocket = (await import('ws')).default;
const { readConnectedFrame, vonageTokenOk, VONAGE_AUDIO_PATH, handleVonageAudioUpgrade } = await import('../src/vonage-audio.js');
const { setupWsServer } = await import('../src/ws-broadcaster.js');

test('only the address with the bridge key is let in', () => {
  assert.equal(vonageTokenOk('/vonage/audio?token=test-bridge-key', 'test-bridge-key'), true);
  assert.equal(vonageTokenOk('/vonage/audio?token=wrong-bridge-key', 'test-bridge-key'), false);
  assert.equal(vonageTokenOk('/vonage/audio', 'test-bridge-key'), false);
  assert.equal(vonageTokenOk('/vonage/audio?token=', ''), false);
});

test("Vonage's first frame names the call, its adviser, client and direction", () => {
  const frame = JSON.stringify({
    event: 'websocket:connected',
    'content-type': 'audio/l16;rate=16000',
    callId: 'vonage-CON-1234-abcd',
    advisorName: 'Shannon Murphy',
    clientPhone: '+447700900123',
    direction: 'Inbound',
  });
  assert.deepEqual(readConnectedFrame(frame), {
    callId: 'vonage-CON-1234-abcd',
    advisorName: 'Shannon Murphy',
    clientPhone: '+447700900123',
    direction: 'Inbound',
  });
  assert.equal(readConnectedFrame(JSON.stringify({ event: 'websocket:connected', callId: 'not-a-crm-id' })), null);
  assert.equal(readConnectedFrame(JSON.stringify({ event: 'other', callId: 'vonage-1' })), null);
  assert.equal(readConnectedFrame('not json'), null);
  assert.equal(readConnectedFrame(JSON.stringify({ event: 'websocket:connected', callId: 'vonage-1' })).direction, 'Outbound');
});

test('the CRM websocket and the Vonage audio share one server, each on its own path', async () => {
  const server = createServer();
  setupWsServer(server, { [VONAGE_AUDIO_PATH]: handleVonageAudioUpgrade });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const opens = (path) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });

  assert.equal(await opens('/ws?apiKey=test-bridge-key'), 'open');
  assert.equal(await opens('/vonage/audio?token=test-bridge-key'), 'open');
  assert.equal(await opens('/vonage/audio?token=nope'), 401);
  assert.equal(await opens('/elsewhere'), 404);
  server.close();
});
