/**
 * RingCentral Webhook Subscription manager.
 *
 * Registers a push notification subscription so RingCentral automatically
 * POSTs telephony session events to /webhook/ringcentral whenever a call
 * starts on the monitored extension. Handles renewal before expiry.
 */

import { rcFetch } from './rc-auth.js';
import config from './config.js';

let subscriptionId = null;
let renewalTimer = null;
let subscriptionExpiresAt = null;

export async function registerWebhookSubscription() {
  let webhookUrl = config.server.webhookUrl;
  if (!webhookUrl) {
    console.warn('[rc-sub] RC_WEBHOOK_URL not set — auto-detection disabled. Use POST /api/supervise manually.');
    return null;
  }
  if (!webhookUrl.startsWith('https://') && !webhookUrl.startsWith('http://')) {
    webhookUrl = `https://${webhookUrl}`;
    console.warn(`[rc-sub] RC_WEBHOOK_URL missing protocol — assuming ${webhookUrl}`);
  }

  const monitoredExtId = config.supervisor.monitoredExtensionId;
  const eventFilter = monitoredExtId
    ? `/restapi/v1.0/account/~/extension/${monitoredExtId}/telephony/sessions`
    : `/restapi/v1.0/account/~/telephony/sessions`;

  const deliveryAddress = `${webhookUrl}/webhook/ringcentral`;

  console.log(`[rc-sub] Registering webhook subscription → ${deliveryAddress}`);
  console.log(`[rc-sub] Monitoring event filter: ${eventFilter}`);

  try {
    if (subscriptionId) {
      await _deleteSubscription();
    }

    const data = await rcFetch('/restapi/v1.0/subscription', {
      method: 'POST',
      body: JSON.stringify({
        eventFilters: [eventFilter],
        deliveryMode: {
          transportType: 'WebHook',
          address: deliveryAddress,
        },
        expiresIn: 86400,
      }),
    });

    subscriptionId = data.id;
    subscriptionExpiresAt = data.expirationTime || null;
    console.log(`[rc-subscription] subscription id=${subscriptionId} expiresAt=${subscriptionExpiresAt} renewalStatus=created`);
    _scheduleRenewal(data.expirationTime);
    return data;
  } catch (err) {
    console.error('[rc-sub] Failed to create webhook subscription:', err.message);
    console.error('[rc-sub] Ensure RC_WEBHOOK_URL is publicly reachable and the RC app has the "Telephony" permission');
    return null;
  }
}

function _scheduleRenewal(expirationTime) {
  if (renewalTimer) clearTimeout(renewalTimer);

  const expiresAt = new Date(expirationTime).getTime();
  // Renew 1 hour before expiry; minimum delay of 60 seconds
  const delay = Math.max(expiresAt - Date.now() - 3_600_000, 60_000);

  renewalTimer = setTimeout(async () => {
    try {
      await _renewSubscription();
    } catch (err) {
      console.error('[rc-sub] Renewal failed, re-registering:', err.message);
      await registerWebhookSubscription();
    }
  }, delay);
}

async function _renewSubscription() {
  const data = await rcFetch(`/restapi/v1.0/subscription/${subscriptionId}`, {
    method: 'PUT',
    body: JSON.stringify({ expiresIn: 86400 }),
  });
  subscriptionExpiresAt = data.expirationTime || null;
  console.log(`[rc-subscription] subscription id=${subscriptionId} expiresAt=${subscriptionExpiresAt} renewalStatus=renewed`);
  _scheduleRenewal(data.expirationTime);
  return data;
}

export async function ensureWebhookSubscriptionActive() {
  if (!config.server.webhookUrl) {
    console.log('[rc-subscription] subscription id=none expiresAt=null renewalStatus=disabled');
    return null;
  }

  if (!subscriptionId) {
    console.warn('[rc-subscription] subscription id=none expiresAt=null renewalStatus=missing; registering');
    return registerWebhookSubscription();
  }

  try {
    const data = await rcFetch(`/restapi/v1.0/subscription/${subscriptionId}`);
    subscriptionExpiresAt = data.expirationTime || subscriptionExpiresAt;
    const expiresAtMs = subscriptionExpiresAt ? new Date(subscriptionExpiresAt).getTime() : 0;
    const expiresSoon = expiresAtMs && expiresAtMs - Date.now() < 3_600_000;

    console.log(`[rc-subscription] subscription id=${subscriptionId} expiresAt=${subscriptionExpiresAt} renewalStatus=${expiresSoon ? 'renewing-soon' : 'active'}`);

    if (expiresSoon) {
      return _renewSubscription();
    }

    return data;
  } catch (err) {
    console.error(`[rc-subscription] subscription id=${subscriptionId} expiresAt=${subscriptionExpiresAt} renewalStatus=invalid; re-registering: ${err.message}`);
    subscriptionId = null;
    subscriptionExpiresAt = null;
    return registerWebhookSubscription();
  }
}

async function _deleteSubscription() {
  try {
    await rcFetch(`/restapi/v1.0/subscription/${subscriptionId}`, { method: 'DELETE' });
  } catch {
    // ignore stale subscription
  }
  subscriptionId = null;
  subscriptionExpiresAt = null;
}
