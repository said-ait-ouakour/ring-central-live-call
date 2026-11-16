import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.BRIDGE_API_KEY = 'test-bridge-key';
process.env.DISABLE_RINGCENTRAL = 'true';

const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  requests.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
  let json = '';
  if (String(url).includes('rpc/resolve_person_by_phone')) {
    const { p_phone_variants } = JSON.parse(opts.body);
    json = p_phone_variants[0].endsWith('7957787593')
      ? [{ kind: 'member', first_name: 'Mr Anjan Kumar', last_name: 'Gupta' }]
      : [];
  } else if (String(url).includes('users?')) {
    json = [{ id: 7, fullName: 'Nicholas Alvarez', ringcentral_id: 101 }];
  }
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => json,
    text: async () => '',
  };
};

const { addCall } = await import('../src/call-store.js');
const { syncActiveCallStarted, clientNameFromPerson } = await import('../src/supabase-sync.js');

function savedRow(sessionId) {
  const save = requests.find(
    (r) => r.method === 'POST' && r.url.includes('active_calls') && JSON.parse(r.body).session_id === sessionId
  );
  return save && JSON.parse(save.body);
}

test('a known caller is saved on the live call with their CRM name', async () => {
  addCall('s-known', { extensionId: '101', clientPhone: '+447957787593', direction: 'Inbound' });
  await syncActiveCallStarted('s-known');
  assert.equal(savedRow('s-known').client_name, 'Mr Anjan Kumar Gupta');
});

test('a number not in the CRM stays unnamed', async () => {
  addCall('s-unknown', { extensionId: '101', clientPhone: '+441234567890' });
  await syncActiveCallStarted('s-unknown');
  assert.equal(savedRow('s-unknown').client_name, null);
});

test('no lookup for a missing number', async () => {
  const before = requests.filter((r) => r.url.includes('rpc/')).length;
  addCall('s-none', { extensionId: '101' });
  await syncActiveCallStarted('s-none');
  assert.equal(requests.filter((r) => r.url.includes('rpc/')).length, before);
  assert.equal(savedRow('s-none').client_name, null);
});

test('clientNameFromPerson joins the parts and ignores blanks', () => {
  assert.equal(clientNameFromPerson({ first_name: ' Jane ', last_name: null }), 'Jane');
  assert.equal(clientNameFromPerson(null), null);
});
