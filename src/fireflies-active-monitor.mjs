const DEFAULT_GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

/**
 * Reconciles Fireflies active_meetings with bridge realtime sessions.
 * A failed poll is never treated as a meeting end; a meeting must be absent
 * for several successful polls before it is considered ended.
 */
export function createFirefliesActiveMeetingsMonitor(options = {}) {
  const {
    apiKey,
    graphqlUrl = DEFAULT_GRAPHQL_URL,
    pollMs = 20_000,
    missesBeforeEnd = 3,
    onActive,
    onMissing,
    logger = console,
    teamBatchSize = 3,
    discoveryConcurrency = 2,
  } = options;

  if (!apiKey) throw new Error('apiKey is required');
  const tracked = new Map();
  const trackedOrganizers = new Map();
  let timer = null;
  let polling = false;
  let stopped = false;
  let teamEmails = null;
  let teamEmailsFetchedAt = 0;
  let teamBatchIndex = 0;
  let cycleActiveIds = new Set();
  let cycleMeetingsById = new Map();

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const trackedEmails = [...new Set([...trackedOrganizers.values()].filter(Boolean))];
      const trackedResult = trackedEmails.length
        ? await fetchTrackedActiveMeetings({ apiKey, graphqlUrl, emails: trackedEmails })
        : { ok: true, meetings: [], meetingsById: new Map() };

      let teamResult;
      try {
        teamResult = await fetchTeamActiveMeetings({
          apiKey,
          graphqlUrl,
          batchSize: teamBatchSize,
          concurrency: discoveryConcurrency,
          batchIndex: teamBatchIndex,
          getTeamEmails: async () => {
            const now = Date.now();
            if (teamEmails && now - teamEmailsFetchedAt < 15 * 60 * 1000) return teamEmails;
            teamEmails = await fetchTeamEmails({ apiKey, graphqlUrl });
            teamEmailsFetchedAt = now;
            logger.info?.(`[fireflies-monitor] Team users loaded count=${teamEmails.length}`);
            return teamEmails;
          },
        });
      } catch (error) {
        logger.error?.('[fireflies-monitor] team discovery poll failed', error);
        for (const sessionId of reconcileTracked({ activeIds: new Set(trackedResult.meetingsById.keys()), trackedResultOk: trackedResult.ok, teamCycleComplete: false })) {
          await onMissing?.(sessionId);
        }
        return;
      }
      teamBatchIndex = teamResult.nextBatchIndex;
      cycleActiveIds = new Set([...cycleActiveIds, ...teamResult.meetings.map((meeting) => meeting.id)]);
      for (const [id, meeting] of teamResult.meetingsById) cycleMeetingsById.set(id, meeting);
      const meetings = teamResult.cycleComplete
        ? [...cycleActiveIds].map((id) => cycleMeetingsById.get(id)).filter(Boolean)
        : teamResult.meetings;
      if (teamResult.cycleComplete) {
        cycleActiveIds = new Set();
        cycleMeetingsById = new Map();
      }
      const activeIds = new Set([...trackedResult.meetingsById.keys()]);

      for (const meeting of meetings) {
        const id = String(meeting?.id || '').trim();
        if (!id) continue;
        activeIds.add(id);
        tracked.set(id, 0);
        if (meeting.organizer_email) trackedOrganizers.set(id, String(meeting.organizer_email).trim().toLowerCase());
        await onActive?.(meeting);
      }

      // A known meeting is checked by organizer on every poll, independently
      // of the slower organization-wide discovery cycle.
      for (const meeting of trackedResult.meetings) {
        const id = String(meeting?.id || '').trim();
        if (!id || meetings.some((candidate) => String(candidate?.id || '') === id)) continue;
        tracked.set(id, 0);
        if (meeting.organizer_email) trackedOrganizers.set(id, String(meeting.organizer_email).trim().toLowerCase());
        await onActive?.(meeting);
      }

      if (!teamResult.cycleComplete) {
        for (const sessionId of reconcileTracked({ activeIds, trackedResultOk: trackedResult.ok, teamCycleComplete: false })) {
          await onMissing?.(sessionId);
        }
        return;
      }

      for (const sessionId of reconcileTracked({ activeIds, trackedResultOk: trackedResult.ok, teamCycleComplete: true })) {
        await onMissing?.(sessionId);
      }
    } catch (error) {
      logger.error?.('[fireflies-monitor] active_meetings poll failed', error);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer || stopped) return;
    stopped = false;
    void poll();
    timer = setInterval(() => void poll(), pollMs);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function seed(sessionIds = []) {
    for (const sessionId of sessionIds) {
      const id = String(sessionId || '').trim();
      if (id && !tracked.has(id)) tracked.set(id, 0);
    }
  }

  function reconcileTracked({ activeIds, trackedResultOk, teamCycleComplete }) {
    const missing = [];
    for (const [sessionId, misses] of tracked) {
      // Organizer-level polling is authoritative for known meetings. Meetings
      // without an organizer are reconciled only after a complete team cycle.
      const hasOrganizer = trackedOrganizers.has(sessionId);
      if (activeIds.has(sessionId) || (hasOrganizer && !trackedResultOk) || (!hasOrganizer && !teamCycleComplete)) continue;
      const nextMisses = misses + 1;
      if (nextMisses >= missesBeforeEnd) {
        tracked.delete(sessionId);
        trackedOrganizers.delete(sessionId);
        missing.push(sessionId);
      } else {
        tracked.set(sessionId, nextMisses);
      }
    }
    return missing;
  }

  return { start, stop, poll, seed, tracked };
}

async function fetchTeamActiveMeetings({ apiKey, graphqlUrl, getTeamEmails, batchSize, batchIndex, concurrency = 2 }) {
  const emails = await getTeamEmails();
  if (!emails.length) {
    const meetings = await fetchActiveMeetings({ apiKey, graphqlUrl });
    return {
      meetings,
      meetingsById: new Map(meetings.map((meeting) => [meeting.id, meeting])),
      nextBatchIndex: 0,
      cycleComplete: true,
    };
  }

  const batchCount = Math.ceil(emails.length / batchSize);
  const startBatch = batchIndex >= batchCount ? 0 : batchIndex;
  const endBatch = Math.min(startBatch + Math.max(1, concurrency), batchCount);
  const batchIndexes = Array.from({ length: endBatch - startBatch }, (_, offset) => startBatch + offset);
  const batchResults = await Promise.all(batchIndexes.map((index) => fetchActiveMeetingsForEmails({ apiKey, graphqlUrl, emails: emails.slice(index * batchSize, (index + 1) * batchSize) })));
  const meetings = [...new Map(batchResults.flat().map((meeting) => [meeting.id, meeting])).values()];
  const nextBatchIndex = startBatch + batchIndexes.length;
  const cycleComplete = nextBatchIndex >= batchCount;
  return {
    meetings,
    meetingsById: new Map(meetings.map((meeting) => [meeting.id, meeting])),
    nextBatchIndex: cycleComplete ? 0 : nextBatchIndex,
    cycleComplete,
  };
}

async function fetchActiveMeetingsForEmails({ apiKey, graphqlUrl, emails }) {
  if (!emails.length) return [];
  const batchEmails = emails;

  const aliases = batchEmails.map((_email, index) => `m${index}`);
  const variables = Object.fromEntries(batchEmails.map((email, index) => [`email${index}`, email]));
  const definitions = batchEmails.map((_email, index) => `$email${index}: String!`).join(', ');
  const selections = aliases.map((alias) => `${alias}: active_meetings(input: { email: $${alias.replace('m', 'email')}, states: $states }) { id title organizer_email meeting_link start_time end_time state }`).join('\n');

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearerToken(apiKey),
    },
    body: JSON.stringify({
      query: `query TeamActive($states: [MeetingState!], ${definitions}) { ${selections} }`,
      variables: { ...variables, states: ['active', 'paused'] },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors) {
    throw new Error(`team active_meetings failed: ${JSON.stringify(body || { status: response.status })}`);
  }

  const meetings = [];
  for (const alias of aliases) {
    if (Array.isArray(body?.data?.[alias])) meetings.push(...body.data[alias]);
  }
  return [...new Map(meetings.map((meeting) => [meeting.id, meeting])).values()];
}

async function fetchTrackedActiveMeetings({ apiKey, graphqlUrl, emails }) {
  try {
    const meetings = await fetchActiveMeetingsForEmails({ apiKey, graphqlUrl, emails });
    return { ok: true, meetings, meetingsById: new Map(meetings.map((meeting) => [String(meeting.id), meeting])) };
  } catch (error) {
    return { ok: false, meetings: [], meetingsById: new Map(), error };
  }
}

async function fetchTeamEmails({ apiKey, graphqlUrl }) {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearerToken(apiKey),
    },
    body: JSON.stringify({
      query: '{ users { email is_admin } }',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors) {
    throw new Error(`team users failed: ${JSON.stringify(body || { status: response.status })}`);
  }
  return [...new Set((body?.data?.users || [])
    .map((user) => String(user?.email || '').trim().toLowerCase())
    .filter(Boolean))];
}

async function fetchActiveMeetings({ apiKey, graphqlUrl }) {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearerToken(apiKey),
    },
    body: JSON.stringify({
      query: `query ActiveMeetings($states: [MeetingState!]) {
        active_meetings(input: { states: $states }) {
          id title organizer_email meeting_link start_time end_time state
        }
      }`,
      variables: { states: ['active', 'paused'] },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors) {
    throw new Error(`active_meetings failed: ${JSON.stringify(body || { status: response.status })}`);
  }
  return Array.isArray(body?.data?.active_meetings) ? body.data.active_meetings : [];
}

function bearerToken(token) {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}
