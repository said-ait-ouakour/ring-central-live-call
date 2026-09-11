import config from './config.js';
import { broadcastEvent } from './ws-broadcaster.js';
import { createFirefliesRealtimeSession } from './fireflies-realtime.mjs';
import { createMeetingStore } from './meeting-store.mjs';
import { createSupabaseMeetingSync } from './meeting-sync.mjs';
import {
  broadcastMeetingEnded,
  broadcastMeetingStarted,
  broadcastMeetingTranscript,
} from './meeting-broadcaster.mjs';
import { createLiveFactFindSync } from './live-factfind-sync.mjs';
import { createFirefliesActiveMeetingsMonitor } from './fireflies-active-monitor.mjs';

const meetings = createMeetingStore();
const realtimeSessions = new Map();
let sync;
let factfind;
let activeMonitor;

function dependencies() {
  if (!sync) sync = createSupabaseMeetingSync({ env: process.env, logger: console });
  if (!factfind) {
    factfind = createLiveFactFindSync({
      env: process.env,
      baseUrl: config.meetings.crmBaseUrl,
      secret: config.meetings.automationWebhookSecret,
      vercelProtectionBypassSecret: config.meetings.vercelProtectionBypassSecret,
      debounceMs: config.meetings.factfindDebounceMs,
      requestTimeoutMs: config.meetings.factfindRequestTimeoutMs,
      maxLines: config.meetings.factfindMaxLines,
      logger: console,
    });
  }
  return { sync, factfind };
}

export function getActiveMeetings() {
  return meetings.listActiveMeetings();
}

export async function superviseMeeting(input = {}) {
  const transcriptId = String(input.transcriptId || '').trim();
  if (!transcriptId) throw new Error('transcriptId is required');
  if (!config.meetings.firefliesApiKey) throw new Error('FIREFLIES_API_KEY is not configured');

  const existing = meetings.getMeeting(transcriptId);
  const normalizedInput = {
    ...input,
    meetingId: validPositiveId(input.meetingId),
    advisorId: validPositiveId(input.advisorId),
    leadId: validPositiveId(input.leadId),
    attendeeEmails: Array.isArray(input.attendeeEmails)
      ? [...new Set([...input.attendeeEmails, input.organizerEmail].filter(Boolean))]
      : input.organizerEmail ? [input.organizerEmail] : undefined,
  };
  if (existing && realtimeSessions.has(transcriptId)) {
    const { sync: meetingSync } = dependencies();
    const updated = meetings.upsertMeeting({
      ...normalizedInput,
      sessionId: transcriptId,
      status: existing.status,
      startedAt: input.startedAt || existing.startedAt,
    });
    const metadataChanged = [
      'meetingId', 'advisorId', 'advisorName', 'leadId', 'contactId', 'attendeeEmails', 'title', 'startedAt',
    ].some((field) => updated[field] !== existing[field]);
    if (metadataChanged) {
      await meetingSync.upsertActiveMeeting(updated);
      broadcastMeetingStarted(broadcastEvent, updated);
    }
    return { created: false, meeting: updated };
  }

  const { sync: meetingSync, factfind: factfindSync } = dependencies();
  const meeting = meetings.upsertMeeting({
    ...normalizedInput,
    sessionId: transcriptId,
    status: 'active',
    meetingId: normalizedInput.meetingId,
    advisorId: normalizedInput.advisorId,
    advisorName: normalizedInput.advisorName,
    leadId: normalizedInput.leadId,
    contactId: normalizedInput.contactId,
    title: normalizedInput.title,
    startedAt: normalizedInput.startedAt,
  });

  await meetingSync.upsertActiveMeeting(meeting);
  broadcastMeetingStarted(broadcastEvent, meeting);

  const realtime = createFirefliesRealtimeSession({
    apiKey: config.meetings.firefliesApiKey,
    realtimeUrl: config.meetings.firefliesRealtimeWsUrl,
    transcriptId,
    logger: console,
    onTranscript: async (line) => {
      const current = meetings.recordTranscript(line) || meeting;
      broadcastMeetingTranscript(broadcastEvent, line);
      if (!line.isFinal) return;
      try {
        await meetingSync.persistTranscriptLine(line, current);
        factfindSync.recordFinalTranscript(current, line);
      } catch (error) {
        console.error(`[meeting] Final transcript handling failed session=${transcriptId}:`, error.message);
      }
    },
    onError: (error) => console.error(`[meeting] Fireflies error session=${transcriptId}:`, error.message),
    onEnded: ({ endedAt }) => void finishMeeting(transcriptId, endedAt),
  });

  realtimeSessions.set(transcriptId, realtime);
  realtime.start();

  // A bridge restart can happen while the meeting is still live. Requeue the
  // final transcript already saved in Supabase so FactFind extraction catches
  // up instead of waiting for the next spoken line.
  void meetingSync.listFinalTranscriptLines(transcriptId, config.meetings.factfindMaxLines)
    .then((lines) => {
      if (lines.length) {
        factfindSync.recordFinalTranscriptBatch(meeting, lines);
        console.log(`[meeting] FactFind catch-up queued session=${transcriptId} lines=${lines.length}`);
      }
    })
    .catch((error) => {
      console.error(`[meeting] FactFind catch-up failed session=${transcriptId}:`, error.message);
    });
  return { created: true, meeting };
}

function validPositiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function startMeetingMonitor() {
  if (activeMonitor || !config.meetings.firefliesApiKey) return;

  const { sync: meetingSync } = dependencies();
  let persisted = [];
  try {
    persisted = await meetingSync.listActiveMeetings();
    for (const row of persisted) {
      meetings.upsertMeeting({
        sessionId: row.session_id,
        meetingId: row.meeting_id,
        advisorId: row.advisor_id,
        advisorName: row.advisor_name,
        leadId: row.lead_id,
        contactId: row.contact_id,
        title: row.title,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      });
    }
    console.log(`[fireflies-monitor] Seeded ${persisted.length} active Supabase meetings`);
  } catch (error) {
    console.error('[fireflies-monitor] Failed to seed active Supabase meetings:', error.message);
  }

  activeMonitor = createFirefliesActiveMeetingsMonitor({
    apiKey: config.meetings.firefliesApiKey,
    graphqlUrl: config.meetings.firefliesApiUrl,
    pollMs: config.meetings.activeMeetingsPollMs,
    missesBeforeEnd: config.meetings.activeMeetingsMissesBeforeEnd,
    teamBatchSize: config.meetings.activeMeetingsTeamBatchSize,
    discoveryConcurrency: config.meetings.activeMeetingsDiscoveryConcurrency,
    logger: console,
    onActive: async (active) => {
      const payload = {
        transcriptId: String(active.id),
        title: active.title || null,
        organizerEmail: active.organizer_email || null,
        meetingLink: active.meeting_link || null,
        startedAt: active.start_time || null,
      };

      // Let CRM resolve meeting/lead/contact metadata when configured. The
      // existing notify route is idempotent and then calls this bridge.
      if (config.meetings.crmNotifyApiKey && config.meetings.crmBaseUrl) {
        const response = await fetch(`${config.meetings.crmBaseUrl}/api/live-meetings/notify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.meetings.crmNotifyApiKey,
            ...(config.meetings.vercelProtectionBypassSecret
              ? { 'x-vercel-protection-bypass': config.meetings.vercelProtectionBypassSecret }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
        console.warn(`[fireflies-monitor] CRM notify returned ${response.status}; starting without CRM mapping`);
      }

      await superviseMeeting(payload);
    },
    onMissing: async (sessionId) => {
      console.log(`[fireflies-monitor] Meeting no longer active; ending session=${sessionId}`);
      await stopMeeting(sessionId);
    },
  });
  activeMonitor.seed(persisted.map((row) => row.session_id));
  activeMonitor.start();
  console.log(`[fireflies-monitor] Started poll=${config.meetings.activeMeetingsPollMs}ms missesBeforeEnd=${config.meetings.activeMeetingsMissesBeforeEnd}`);
}

async function finishMeeting(sessionId, endedAt = new Date().toISOString()) {
  const realtime = realtimeSessions.get(sessionId);
  realtimeSessions.delete(sessionId);
  const existing = meetings.getMeeting(sessionId);
  if (!existing || existing.status === 'ended') return existing;
  const meeting = meetings.endMeeting(sessionId, endedAt);

  const { sync: meetingSync, factfind: factfindSync } = dependencies();
  try {
    const reconciliation = await meetingSync.reconcileFirefliesTranscript(sessionId, meeting);
    console.log(`[meeting] Transcript reconciliation session=${sessionId} lines=${reconciliation.count}`);
  } catch (error) {
    console.error(`[meeting] Transcript reconciliation failed session=${sessionId}:`, error.message);
  }
  try {
    await meetingSync.markMeetingEnded(sessionId, endedAt);
  } catch (error) {
    console.error(`[meeting] Failed to mark meeting ended session=${sessionId}:`, error.message);
  }
  broadcastMeetingEnded(broadcastEvent, meeting, endedAt);
  await factfindSync.finalize(sessionId);
  return meeting;
}

export async function stopMeeting(sessionId) {
  const meeting = meetings.getMeeting(sessionId);
  if (!meeting) return null;
  if (meeting.status === 'ended') return meeting;
  const realtime = realtimeSessions.get(sessionId);
  if (realtime) {
    await realtime.stop();
    return meetings.getMeeting(sessionId);
  }
  return finishMeeting(sessionId);
}

export function reconnectMeeting(sessionId) {
  const meeting = meetings.getMeeting(sessionId);
  const realtime = realtimeSessions.get(sessionId);
  if (!meeting || meeting.status === 'ended' || !realtime) return null;
  realtime.reconnect();
  return meeting;
}

export async function stopAllMeetings() {
  activeMonitor?.stop();
  await Promise.all([...realtimeSessions.keys()].map((sessionId) => stopMeeting(sessionId)));
}
