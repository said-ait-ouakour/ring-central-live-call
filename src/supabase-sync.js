import config from './config.js';
import { getCall } from './call-store.js';

let warnedMissingConfig = false;

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
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function syncActiveCallStarted(callId) {
  const call = getCall(callId);
  if (!call || !enabled()) return;

  try {
    const advisor = await getAdvisorByExtension(call.extensionId);
    const payload = {
      session_id: call.callId,
      telephony_session_id: call.telephonySessionId,
      advisor_extension_id: String(call.extensionId || ''),
      advisor_id: advisor?.id || null,
      advisor_name: advisor?.fullName || call.advisorName || null,
      client_number: call.clientPhone || 'Unknown',
      client_name: null,
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
    const advisor = await getAdvisorByExtension(call.extensionId);
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
