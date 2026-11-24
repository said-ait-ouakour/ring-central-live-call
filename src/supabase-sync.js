import config from './config.js';
import { reportError } from './crm-alerts.js';
import { getCall } from './call-store.js';
import { rcFetch } from './rc-auth.js';

let warnedMissingConfig = false;
const extensionProfileCache = new Map();
const clientCache = new Map();
const CLIENT_CACHE_MS = 10 * 60 * 1000;

function enabled() {
  const ok = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
  if (!ok && !warnedMissingConfig) {
    warnedMissingConfig = true;
    console.warn('[supabase-sync] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured; persistence disabled');
  }
  return ok;
}

async function supabaseFetch(path, options = {}) {
  if (!enabled()) return null;

  const baseUrl = config.supabase.url.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.supabase.serviceRoleKey,
      Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

async function getAdvisorByExtension(extensionId) {
  if (!extensionId) return null;
  const numericExtensionId = Number(extensionId);
  if (!Number.isFinite(numericExtensionId)) return null;

  const rows = await supabaseFetch(
    `users?select=id,fullName,ringcentral_id&ringcentral_id=eq.${numericExtensionId}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0 ? { ...rows[0], crmUserId: rows[0].id } : null;
}

function fullNameFromExtensionProfile(profile) {
  const contact = profile?.contact || {};
  return (
    [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
    profile?.name ||
    contact.name ||
    ''
  );
}

async function getRingCentralExtensionProfile(extensionId) {
  if (!extensionId) return null;
  const cacheKey = String(extensionId);
  if (extensionProfileCache.has(cacheKey)) return extensionProfileCache.get(cacheKey);

  try {
    const profile = await rcFetch(`/restapi/v1.0/account/~/extension/${encodeURIComponent(cacheKey)}`);
    const name = fullNameFromExtensionProfile(profile);
    const enriched = name ? { ringCentralExtensionId: profile?.id, fullName: name } : null;
    extensionProfileCache.set(cacheKey, enriched);
    console.log(`[supabase-sync] RC extension profile extensionId=${cacheKey} name=${name || 'unknown'}`);
    return enriched;
  } catch (err) {
    console.warn(`[supabase-sync] Failed to load RC extension profile extensionId=${cacheKey}: ${err.message}`);
    extensionProfileCache.set(cacheKey, null);
    return null;
  }
}

async function resolveAdvisor(extensionId, fallbackName) {
  // A Vonage call has no RingCentral extension: the name the CRM sent is the one.
  if (!extensionId) return fallbackName ? { fullName: fallbackName } : null;
  const advisor = await getAdvisorByExtension(extensionId);
  if (advisor?.fullName) return advisor;

  const rcProfile = await getRingCentralExtensionProfile(extensionId);
  if (rcProfile?.fullName) return rcProfile;

  return fallbackName ? { fullName: fallbackName } : null;
}

export function clientNameFromPerson(person) {
  if (!person) return null;
  const name = [person.first_name, person.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  return name || null;
}

// The caller's number to the CRM person, through the same lookup the Power
// Dialer and the WebPhone use (resolve_person_by_phone: member > contact >
// lead). Without it every bridge call reached the Live Call page as
// "Unknown Caller", even for a member whose number is on file.
async function resolveClient(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  const cached = clientCache.get(digits);
  if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) return cached.person;

  try {
    const rows = await supabaseFetch('rpc/resolve_person_by_phone', {
      method: 'POST',
      body: JSON.stringify({ p_phone_variants: [String(phone)] }),
    });
    const person = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    clientCache.set(digits, { at: Date.now(), person });
    console.log(`[supabase-sync] Caller lookup tail=${digits.slice(-4)} kind=${person?.kind || 'none'}`);
    return person;
  } catch (err) {
    console.warn(`[supabase-sync] Caller lookup failed: ${err.message}`);
    return null;
  }
}

export async function syncActiveCallStarted(callId) {
  const call = getCall(callId);
  if (!call || !enabled()) return;

  try {
    const [advisor, client] = await Promise.all([
      resolveAdvisor(call.extensionId, call.advisorName),
      resolveClient(call.clientPhone),
    ]);
    const payload = {
      session_id: call.callId,
      telephony_session_id: call.telephonySessionId,
      advisor_extension_id: String(call.extensionId || ''),
      advisor_id: advisor?.crmUserId || null,
      advisor_name: advisor?.fullName || call.advisorName || null,
      client_number: call.clientPhone || 'Unknown',
      client_name: clientNameFromPerson(client),
      direction: call.direction || 'Outbound',
      start_time: call.startTime,
      status: 'active',
      event_id: '',
      owner_id: 'bridge',
      updated_at: new Date().toISOString(),
    };

    await supabaseFetch('active_calls?on_conflict=session_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });
    console.log(`[supabase-sync] Active call synced session=${call.callId}`);
  } catch (err) {
    console.error(`[supabase-sync] Failed to sync active call session=${call.callId}:`, err.message);
  }
}

export async function syncTranscriptEntry(callId, entry) {
  const call = getCall(callId);
  if (!call || !entry?.isFinal || !entry?.text || !enabled()) return;

  try {
    const advisor = await resolveAdvisor(call.extensionId, call.advisorName);
    await supabaseFetch('live_call_transcripts', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_id: call.callId,
        telephony_session_id: call.telephonySessionId,
        advisor_extension_id: String(call.extensionId || ''),
        advisor_name: advisor?.fullName || call.advisorName || null,
        client_number: call.clientPhone || null,
        text: entry.text,
        is_final: true,
        turn_order: entry.turnOrder ?? null,
        timestamp: entry.timestamp || new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error(`[supabase-sync] Failed to persist transcript session=${call.callId}:`, err.message);
    void reportError('save-call-transcript', 'could not save a call transcript line', err);
  }
}

export async function syncActiveCallEnded(call) {
  if (!call || !enabled()) return;

  try {
    await supabaseFetch(`active_calls?session_id=eq.${encodeURIComponent(call.callId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'ended',
        updated_at: new Date().toISOString(),
      }),
    });
    console.log(`[supabase-sync] Active call ended session=${call.callId}`);
  } catch (err) {
    console.error(`[supabase-sync] Failed to mark call ended session=${call.callId}:`, err.message);
  }
}
