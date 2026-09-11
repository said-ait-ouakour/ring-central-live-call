import { toBridgeTranscriptEvent } from './fireflies-normalizer.mjs';
import { toBridgeActiveMeeting } from './meeting-store.mjs';

export function broadcastMeetingStarted(broadcaster, meeting) {
  broadcast(broadcaster, {
    type: 'meeting_started',
    meeting: toBridgeActiveMeeting(meeting),
  });
}

export function broadcastMeetingTranscript(broadcaster, line) {
  broadcast(broadcaster, toBridgeTranscriptEvent(line));
}

export function broadcastMeetingEnded(broadcaster, meetingOrSessionId, endedAt = new Date().toISOString()) {
  const sessionId =
    typeof meetingOrSessionId === 'string'
      ? meetingOrSessionId
      : meetingOrSessionId.sessionId;

  broadcast(broadcaster, {
    type: 'meeting_ended',
    sessionId,
    endTime: endedAt,
  });
}

export function broadcastActiveMeetings(broadcaster, meetings) {
  broadcast(broadcaster, {
    type: 'active_meetings',
    meetings: meetings.map(toBridgeActiveMeeting),
  });
}

function broadcast(broadcaster, event) {
  if (typeof broadcaster === 'function') {
    broadcaster(event);
    return;
  }

  if (typeof broadcaster?.broadcast === 'function') {
    broadcaster.broadcast(event);
    return;
  }

  if (typeof broadcaster?.sendToSubscribers === 'function') {
    broadcaster.sendToSubscribers(event);
    return;
  }

  throw new Error('Unsupported broadcaster: pass a function or object with broadcast(event)');
}

