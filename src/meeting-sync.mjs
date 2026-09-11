import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { inferClientSpeakerRole } from './speaker-role.mjs';

export function createSupabaseMeetingSync(options = {}) {
  const supabase = options.supabase || createServiceClient(options.env || process.env);
  const logger = options.logger || console;
  const env = options.env || process.env;
  const clientIdentityCache = new Map();

  async function upsertActiveMeeting(meeting) {
    const row = {
      session_id: meeting.sessionId,
      meeting_id: meeting.meetingId ?? null,
      advisor_id: meeting.advisorId ?? null,
      advisor_name: meeting.advisorName ?? null,
      lead_id: meeting.leadId ?? null,
      contact_id: meeting.contactId ?? null,
      attendee_emails: meeting.attendeeEmails ?? [],
      title: meeting.title ?? null,
      status: meeting.status || 'active',
      started_at: meeting.startedAt || new Date().toISOString(),
      ended_at: meeting.endedAt ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('active_meetings')
      .upsert(row, { onConflict: 'session_id' });

    if (error) {
      logger.error?.('[meeting-sync] active_meetings upsert failed', error, {
        sessionId: meeting.sessionId,
      });
      throw error;
    }
  }

  async function markMeetingEnded(sessionId, endedAt = new Date().toISOString()) {
    const { error } = await supabase
      .from('active_meetings')
      .update({
        status: 'ended',
        ended_at: endedAt,
        updated_at: endedAt,
      })
      .eq('session_id', sessionId);

    if (error) {
      logger.error?.('[meeting-sync] active_meetings end update failed', error, {
        sessionId,
      });
      throw error;
    }
  }

  async function listActiveMeetings() {
    const { data, error } = await supabase
      .from('active_meetings')
      .select('*')
      .eq('status', 'active');

    if (error) {
      logger.error?.('[meeting-sync] active_meetings list failed', error);
      throw error;
    }
    return data || [];
  }

  async function listFinalTranscriptLines(sessionId, limit = 200) {
    const { data, error } = await supabase
      .from('live_meeting_transcripts')
      .select('session_id, text, speaker, speaker_role, timestamp, turn_order')
      .eq('session_id', sessionId)
      .eq('is_final', true)
      .order('turn_order', { ascending: true, nullsFirst: false })
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) {
      logger.error?.('[meeting-sync] transcript catch-up read failed', error, { sessionId });
      throw error;
    }
    return (data || []).map((row) => ({
      sessionId: row.session_id,
      isFinal: true,
      text: row.text,
      speaker: row.speaker,
      speakerRole: row.speaker_role || 'unknown',
      timestamp: row.timestamp,
      turnOrder: row.turn_order,
    }));
  }

  async function persistTranscriptLine(line, meeting = null) {
    const clientNames = meeting ? await resolveClientNames(meeting) : [];
    const speakerRole = line.speakerRole && line.speakerRole !== 'unknown'
      ? line.speakerRole
      : inferClientSpeakerRole(line.speaker, clientNames);
    const row = {
      provider: line.provider || 'fireflies',
      provider_chunk_id: line.providerChunkId ?? null,
      session_id: line.sessionId,
      meeting_id: meeting?.meetingId ?? null,
      text: line.text,
      is_final: Boolean(line.isFinal),
      speaker: line.speaker ?? null,
      speaker_role: speakerRole,
      turn_order: line.turnOrder ?? null,
      confidence: line.confidence ?? null,
      audio_start: line.audioStart ?? null,
      audio_end: line.audioEnd ?? null,
      timestamp: line.timestamp || new Date().toISOString(),
    };

    const query = row.provider_chunk_id
      ? supabase
          .from('live_meeting_transcripts')
          .upsert(row, { onConflict: 'provider,provider_chunk_id' })
      : supabase.from('live_meeting_transcripts').insert(row);

    const { error } = await query;

    if (error) {
      logger.error?.('[meeting-sync] live_meeting_transcripts write failed', error, {
        sessionId: line.sessionId,
        providerChunkId: line.providerChunkId,
      });
      throw error;
    }
  }

  async function resolveClientNames(meeting) {
    const leadId = meeting?.leadId ?? meeting?.lead_id ?? null;
    const contactId = meeting?.contactId ?? meeting?.contact_id ?? null;
    const cacheKey = `${contactId || ''}:${leadId || ''}`;
    if (clientIdentityCache.has(cacheKey)) return clientIdentityCache.get(cacheKey);

    const names = [];
    const queries = [];
    if (contactId) {
      queries.push(supabase.from('contacts').select('first_name, last_name').eq('id', contactId).maybeSingle());
    }
    if (leadId) {
      queries.push(supabase.from('leads').select('first_name, last_name').eq('id', leadId).maybeSingle());
    }
    const results = await Promise.all(queries);
    for (const result of results) {
      const row = result.data;
      const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
      if (name) names.push(name);
    }
    const uniqueNames = [...new Set(names)];
    clientIdentityCache.set(cacheKey, uniqueNames);
    return uniqueNames;
  }

  async function reconcileFirefliesTranscript(sessionId, meeting = null) {
    const apiKey = String(env.FIREFLIES_API_KEY || '').trim();
    const graphqlUrl = String(env.FIREFLIES_API_URL || 'https://api.fireflies.ai/graphql').trim();
    if (!apiKey) return { fetched: false, count: 0 };

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `query CompletedTranscript($id: String!) { transcript(id: $id) { sentences { speaker_name text start_time end_time } } }`,
        variables: { id: sessionId },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.errors) {
      throw new Error(`Fireflies transcript reconciliation failed: ${JSON.stringify(body || { status: response.status })}`);
    }

    const sentences = Array.isArray(body?.data?.transcript?.sentences)
      ? body.data.transcript.sentences
      : [];
    let count = 0;
    for (const [index, sentence] of sentences.entries()) {
      const text = String(sentence?.text || '').trim();
      if (!text) continue;
      const providerChunkId = `fireflies-backfill:${createHash('sha1').update(`${sessionId}|${index}|${sentence?.speaker_name || ''}|${text}`).digest('hex')}`;
      await persistTranscriptLine({
        provider: 'fireflies',
        providerChunkId,
        sessionId,
        text,
        isFinal: true,
        speaker: sentence?.speaker_name || null,
        speakerRole: 'unknown',
        turnOrder: index + 1,
        audioStart: Number.isFinite(Number(sentence?.start_time)) ? Number(sentence.start_time) : null,
        audioEnd: Number.isFinite(Number(sentence?.end_time)) ? Number(sentence.end_time) : null,
        timestamp: new Date().toISOString(),
      }, meeting);
      count += 1;
    }
    return { fetched: true, count };
  }

  return {
    upsertActiveMeeting,
    markMeetingEnded,
    listActiveMeetings,
    listFinalTranscriptLines,
    persistTranscriptLine,
    reconcileFirefliesTranscript,
  };
}

function createServiceClient(env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_API_KEY ||
    env.SUPBASE_SERVICE_API_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase URL or service role key for meeting sync');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
