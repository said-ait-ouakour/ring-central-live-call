import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAlertReporter, loggerReporting } from '../src/crm-alerts.js';
import { createLiveFactFindSync } from '../src/live-factfind-sync.mjs';

function fakeFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status };
  };
  return { calls, fetchImpl };
}

const quiet = { warn() {} };

test('posts a service_error to the CRM with the shared secret, named for the bridge', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const reporter = createAlertReporter({ url: 'https://crm/api/system-alerts', secret: 's3cret', source: 'live-call-bridge', fetchImpl, log: quiet });
  assert.equal(reporter.enabled, true);
  assert.equal(await reporter.report('sip-registration', 'SIP registration with RingCentral failed', new Error('timeout'), { severity: 'p2' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://crm/api/system-alerts');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer s3cret');
  assert.deepEqual(calls[0].body, {
    source: 'service:live-call-bridge',
    rule: 'service_error',
    key: 'sip-registration',
    title: 'RingCentral live bridge: SIP registration with RingCentral failed',
    detail: 'timeout',
    severity: 'p2',
  });
});

test('the meeting bridge reports under its own name', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const reporter = createAlertReporter({ url: 'https://crm/api/system-alerts', secret: 's', source: 'live-meeting-bridge', fetchImpl, log: quiet });
  await reporter.report('fireflies-realtime', 'the Fireflies live transcript connection failed', 'socket closed');
  assert.equal(calls[0].body.source, 'service:live-meeting-bridge');
  assert.equal(calls[0].body.title, 'Meeting bridge: the Fireflies live transcript connection failed');
  assert.equal(calls[0].body.severity, undefined);
});

test('off without a secret or an address: nothing is sent', async () => {
  const { calls, fetchImpl } = fakeFetch();
  for (const options of [{ url: 'https://crm/api/system-alerts', secret: '' }, { url: '', secret: 's' }]) {
    const reporter = createAlertReporter({ ...options, source: 'live-call-bridge', fetchImpl, log: quiet });
    assert.equal(reporter.enabled, false);
    assert.equal(await reporter.report('x', 'y', new Error('z')), false);
  }
  assert.equal(calls.length, 0);
});

test('an address that is not https is refused, so the secret never goes in clear text', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const warned = [];
  const log = { warn: (line) => warned.push(line) };
  for (const url of ['http://crm.example.com/api/system-alerts', 'crm.example.com/api/system-alerts']) {
    const reporter = createAlertReporter({ url, secret: 's', source: 'live-call-bridge', fetchImpl, log });
    assert.equal(reporter.enabled, false);
    assert.equal(await reporter.report('x', 'y', new Error('z')), false);
  }
  assert.equal(calls.length, 0);
  assert.equal(warned.length, 2);
  // a service on the same machine may use http
  assert.equal(createAlertReporter({ url: 'http://localhost:3000/api/system-alerts', secret: 's', source: 'live-call-bridge', fetchImpl, log: quiet }).enabled, true);
});

test('the same fault is sent at most every 30 seconds; a different one is not held back', async () => {
  const { calls, fetchImpl } = fakeFetch();
  let clock = 1_000_000;
  const reporter = createAlertReporter({ url: 'https://crm/api/system-alerts', secret: 's', source: 'live-call-bridge', fetchImpl, now: () => clock, log: quiet });
  await reporter.report('assemblyai', 't', 'e');
  await reporter.report('assemblyai', 't', 'e');
  await reporter.report('rc-auth', 't', 'e');
  clock += 30_000;
  await reporter.report('assemblyai', 't', 'e');
  assert.deepEqual(calls.map((call) => call.body.key), ['assemblyai', 'rc-auth', 'assemblyai']);
});

test('a CRM that refuses or cannot be reached never throws', async () => {
  const refused = createAlertReporter({ url: 'https://crm/api/system-alerts', secret: 's', source: 'live-call-bridge', fetchImpl: fakeFetch(403).fetchImpl, log: quiet });
  assert.equal(await refused.report('a', 't', 'e'), false);
  const down = createAlertReporter({ url: 'https://crm/api/system-alerts', secret: 's', source: 'live-call-bridge', fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log: quiet });
  assert.equal(await down.report('a', 't', 'e'), false);
});

test('a logged failure named in the map is also reported; others are only logged', () => {
  const logged = [];
  const reported = [];
  const logger = loggerReporting(
    { '[mod] poll failed': { key: 'mod-poll', title: 'could not poll' } },
    { log: { error: (...args) => logged.push(args), info: () => {} }, report: (...args) => reported.push(args) },
  );
  const error = new Error('boom');
  logger.error('[mod] poll failed', error);
  logger.error('[mod] something else failed', error);
  logger.info('[mod] fine');
  assert.equal(logged.length, 2);
  assert.deepEqual(reported, [['mod-poll', 'could not poll', error]]);
});

test('the live fact find reports an update and a finish the CRM refused', async () => {
  const reported = [];
  const factfind = createLiveFactFindSync({
    baseUrl: 'https://crm',
    secret: 's',
    debounceMs: 1,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    logger: loggerReporting(
      {
        '[live-factfind-sync] extraction cycle failed': { key: 'live-factfind-update', title: 'u' },
        '[live-factfind-sync] finalize failed': { key: 'live-factfind-finalize', title: 'f' },
      },
      { log: { error() {} }, report: (key) => reported.push(key) },
    ),
  });
  factfind.recordFinalTranscript({ sessionId: 'm1' }, { isFinal: true, text: 'We have a house worth 500k' });
  await factfind.finalize('m1');
  assert.deepEqual(reported, ['live-factfind-update', 'live-factfind-finalize']);
});
