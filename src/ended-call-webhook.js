import config from './config.js';

let warnedMissingWebhookUrl = false;

export function endedCallWebhookEnabled() {
  const enabled = Boolean(config.server.endedCallWebhookUrl);
  if (!enabled && !warnedMissingWebhookUrl) {
    warnedMissingWebhookUrl = true;
    console.log('[ended-call] ENDED_CALL_WEBHOOK_URL not set; ended-call forwarding disabled');
  }
  return enabled;
}

export async function forwardEndedCall(payload) {
  if (!endedCallWebhookEnabled()) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.server.endedCallWebhookTimeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (config.server.endedCallWebhookBearerToken) {
      headers.Authorization = `Bearer ${config.server.endedCallWebhookBearerToken}`;
    }

    const response = await fetch(config.server.endedCallWebhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`n8n webhook failed (${response.status}): ${text}`);
    }

    console.log(`[ended-call] Forwarded ended call dedupeKey=${payload.dedupeKey} session=${payload.telephonySessionId}`);
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`n8n webhook timed out after ${config.server.endedCallWebhookTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
