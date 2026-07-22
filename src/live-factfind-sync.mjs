/**
 * Debounced CRM handoff for live Fact Find extraction.
 * Transcript persistence/broadcasting remains independent: failures here are
 * logged and swallowed so extraction can never stop the meeting stream.
 */
export function createLiveFactFindSync(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = String(options.baseUrl || options.env?.CRM_BASE_URL || '').replace(/\/$/, '');
  const secret = options.secret || options.env?.AUTOMATION_WEBHOOK_SECRET || '';
  const debounceMs = Number(options.debounceMs || options.env?.LIVE_FACTFIND_DEBOUNCE_MS || 20_000);
  const maxLines = Number(options.maxLines || options.env?.LIVE_FACTFIND_MAX_LINES || 200);
  const requestTimeoutMs = Number(options.requestTimeoutMs || options.env?.LIVE_FACTFIND_REQUEST_TIMEOUT_MS || 15_000);
  const vercelProtectionBypassSecret = String(
    options.vercelProtectionBypassSecret || options.env?.VERCEL_AUTOMATION_BYPASS_SECRET || ''
  ).trim();
  const logger = options.logger || console;
  const sessions = new Map();

  if (!baseUrl || !secret || typeof fetchImpl !== 'function') {
    throw new Error('CRM_BASE_URL, AUTOMATION_WEBHOOK_SECRET, and fetch are required for live Fact Find sync');
  }

  function recordFinalTranscript(meeting, line) {
    if (!line?.isFinal || !line.text?.trim()) return;
    const sessionId = meeting?.sessionId || line.sessionId;
    if (!sessionId) return;

    const state = sessions.get(sessionId) || { lines: [], meeting, timer: null, inFlight: Promise.resolve() };
    state.meeting = meeting || state.meeting;
    state.lines.push({
      speaker: line.speaker ?? null,
      speakerRole: line.speakerRole || 'unknown',
      text: line.text.trim(),
      timestamp: line.timestamp ?? null,
    });
    state.lines = state.lines.slice(-maxLines);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void enqueueCycle(sessionId, state), debounceMs);
    sessions.set(sessionId, state);
  }

  function recordFinalTranscriptBatch(meeting, lines = []) {
    for (const line of lines) recordFinalTranscript(meeting, line);
  }

  function enqueueCycle(sessionId, state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.inFlight = state.inFlight.then(() => post(sessionId, cyclePayload(state))).catch((error) => {
      logger.error?.('[live-factfind-sync] extraction cycle failed', error, { sessionId });
    });
    return state.inFlight;
  }

  async function finalize(sessionId) {
    const state = sessions.get(sessionId);
    if (state?.timer) await enqueueCycle(sessionId, state);
    if (state) await state.inFlight;
    try {
      await post(sessionId, { finalize: true });
    } catch (error) {
      logger.error?.('[live-factfind-sync] finalize failed', error, { sessionId });
    } finally {
      sessions.delete(sessionId);
    }
  }

  function cyclePayload(state) {
    const meeting = state.meeting || {};
    return {
      advisor_id: meeting.advisorId ?? null,
      lead_id: meeting.leadId ?? null,
      contact_id: meeting.contactId ?? null,
      meeting_id: meeting.meetingId ?? null,
      transcript: state.lines,
      prefill: meeting.prefill || {},
      meta: { advisorName: meeting.advisorName, clientName: meeting.clientName },
    };
  }

  async function post(sessionId, body) {
    const response = await fetchImpl(`${baseUrl}/api/live-meetings/${encodeURIComponent(sessionId)}/factfind`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-automation-secret': secret,
        ...(vercelProtectionBypassSecret
          ? { 'x-vercel-protection-bypass': vercelProtectionBypassSecret }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.error || `CRM Fact Find endpoint returned ${response.status}`);
    }
    return result;
  }

  return { recordFinalTranscript, recordFinalTranscriptBatch, finalize };
}
