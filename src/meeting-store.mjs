const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function createMeetingStore(options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const meetings = new Map();

  function upsertMeeting(input) {
    if (!input?.sessionId) throw new Error('sessionId is required');

    const existing = meetings.get(input.sessionId);
    const now = new Date().toISOString();
    const meeting = {
      sessionId: input.sessionId,
      meetingId: input.meetingId ?? existing?.meetingId ?? null,
      advisorId: input.advisorId ?? existing?.advisorId ?? null,
      advisorName: input.advisorName ?? existing?.advisorName ?? null,
      leadId: input.leadId ?? existing?.leadId ?? null,
      contactId: input.contactId ?? existing?.contactId ?? null,
      attendeeEmails: Array.isArray(input.attendeeEmails) ? [...new Set(input.attendeeEmails.filter(Boolean))] : (existing?.attendeeEmails ?? []),
      title: input.title ?? existing?.title ?? null,
      status: input.status ?? existing?.status ?? 'active',
      startedAt: input.startedAt ?? existing?.startedAt ?? now,
      endedAt: input.endedAt ?? existing?.endedAt ?? null,
      transcriptLength: existing?.transcriptLength ?? 0,
      lastTranscriptAt: existing?.lastTranscriptAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    meetings.set(meeting.sessionId, meeting);
    return meeting;
  }

  function getMeeting(sessionId) {
    return meetings.get(sessionId) || null;
  }

  function listActiveMeetings() {
    return [...meetings.values()]
      .filter((meeting) => meeting.status !== 'ended')
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  function recordTranscript(line) {
    const meeting = meetings.get(line.sessionId);
    if (!meeting) return null;

    const updated = {
      ...meeting,
      transcriptLength: meeting.transcriptLength + (line.isFinal ? 1 : 0),
      lastTranscriptAt: line.timestamp || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    meetings.set(line.sessionId, updated);
    return updated;
  }

  function endMeeting(sessionId, endedAt = new Date().toISOString()) {
    const existing = meetings.get(sessionId);
    if (!existing) return null;

    const ended = {
      ...existing,
      status: 'ended',
      endedAt,
      updatedAt: endedAt,
    };
    meetings.set(sessionId, ended);
    return ended;
  }

  function removeMeeting(sessionId) {
    const existing = meetings.get(sessionId) || null;
    meetings.delete(sessionId);
    return existing;
  }

  function expireStaleMeetings(nowMs = Date.now()) {
    const expired = [];
    for (const meeting of meetings.values()) {
      if (meeting.status === 'ended') continue;
      const updatedMs = new Date(meeting.updatedAt || meeting.startedAt).getTime();
      if (Number.isFinite(updatedMs) && nowMs - updatedMs > maxAgeMs) {
        expired.push(endMeeting(meeting.sessionId, new Date(nowMs).toISOString()));
      }
    }
    return expired.filter(Boolean);
  }

  return {
    upsertMeeting,
    getMeeting,
    listActiveMeetings,
    recordTranscript,
    endMeeting,
    removeMeeting,
    expireStaleMeetings,
  };
}

export function toBridgeActiveMeeting(meeting) {
  return {
    sessionId: meeting.sessionId,
    meetingId: meeting.meetingId,
    advisorId: meeting.advisorId,
    advisorName: meeting.advisorName,
    leadId: meeting.leadId,
    contactId: meeting.contactId,
    attendeeEmails: meeting.attendeeEmails || [],
    title: meeting.title,
    startTime: meeting.startedAt,
    status: meeting.status,
    transcriptLength: meeting.transcriptLength,
  };
}
