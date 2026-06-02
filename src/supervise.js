/**
 * RingCentral Call Supervise API.
 * Silently taps into a live call so the bridge's softphone receives the audio.
 */

import { rcFetch } from './rc-auth.js';
import config from './config.js';
import { ensureSoftphoneRegistered } from './softphone.js';

let supervisorUserCache = null;
let supervisorDeviceCache = null;
let supervisorDeviceCacheLoadedAt = 0;
const SUPERVISOR_DEVICE_CACHE_TTL_MS = 60 * 60 * 1000;

function normalizeDevice(device) {
  return {
    id: String(device.id),
    name: device.name,
    type: device.type,
    status: device.status,
    serial: device.serial,
  };
}

function isDeviceCacheFresh() {
  return (
    supervisorDeviceCache &&
    Date.now() - supervisorDeviceCacheLoadedAt < SUPERVISOR_DEVICE_CACHE_TTL_MS
  );
}

export function invalidateSupervisorDeviceCache(reason = 'unknown') {
  supervisorDeviceCache = null;
  supervisorDeviceCacheLoadedAt = 0;
  console.warn(`[rc-cache] device cache invalidated reason=${reason}`);
}

async function resolveSupervisorDeviceId({ forceRefresh = false } = {}) {
  const extId = config.supervisor.extensionId;
  const configuredDeviceId = String(config.supervisor.deviceId);

  if (!forceRefresh && isDeviceCacheFresh()) {
    console.log(`[rc-cache] device cache hit supervisorExtensionId=${extId} selectedDeviceId=${supervisorDeviceCache.id} deviceStatus=${supervisorDeviceCache.status || 'unknown'}`);
    return supervisorDeviceCache.id;
  }

  const path = `/restapi/v1.0/account/~/extension/${extId}/device`;
  const data = await rcFetch(path);
  const devices = (data.records || []).map(normalizeDevice);
  const selected = devices.find((d) => d.id === configuredDeviceId);

  console.log(`[rc-device] supervisorExtensionId=${extId} selectedDeviceId=${configuredDeviceId} deviceStatus=${selected?.status || 'missing'}`);

  if (!selected) {
    throw new Error(`Supervisor deviceId ${configuredDeviceId} was not found for supervisor extension ${extId}`);
  }

  supervisorDeviceCache = selected;
  supervisorDeviceCacheLoadedAt = Date.now();
  console.log(`[rc-cache] device cache refresh supervisorExtensionId=${extId} selectedDeviceId=${selected.id} deviceStatus=${selected.status || 'unknown'}`);

  return selected.id;
}

export async function getCurrentRingCentralUser({ forceRefresh = false } = {}) {
  if (!forceRefresh && supervisorUserCache) {
    console.log(`[rc-cache] user cache hit extensionId=${supervisorUserCache.id || 'unknown'}`);
    return supervisorUserCache;
  }

  const data = await rcFetch('/restapi/v1.0/account/~/extension/~');
  console.log(`[rc-user] currentUserId=${data.contact?.id || data.id || 'unknown'} extensionId=${data.id || 'unknown'} accountId=${data.account?.id || 'unknown'} extensionNumber=${data.extensionNumber || 'unknown'}`);
  supervisorUserCache = data;
  console.log(`[rc-cache] user cache refresh extensionId=${data.id || 'unknown'}`);
  return data;
}

/**
 * Start supervising (silently listening to) a live call.
 *
 * @param {string} telephonySessionId - The telephony session to supervise
 * @param {string} partyId - The party that triggered supervision; kept for logging
 * @param {string} agentExtensionId - The advisor's extension ID (the person on the call)
 * @returns {Promise<object>} - The supervised party info from RingCentral
 */
export async function startSupervision(telephonySessionId, partyId, agentExtensionId, attempt = 1) {
  const path = `/restapi/v1.0/account/~/telephony/sessions/${telephonySessionId}/supervise`;

  await ensureSoftphoneRegistered();
  const supervisorDeviceId = await resolveSupervisorDeviceId();

  console.log(`[supervise] sessionId=${telephonySessionId} partyId=${partyId} attempt=${attempt} agentExtensionId=${agentExtensionId}`);

  const result = await rcFetch(path, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'Listen',
      supervisorDeviceId,
      agentExtensionId: agentExtensionId,
    }),
  });

  console.log(`[supervise] Supervision started. Supervisor party:`, result?.party?.id || 'unknown');
  return result;
}

export async function warmSupervisorCache() {
  await getCurrentRingCentralUser();
  await resolveSupervisorDeviceId({ forceRefresh: true });
}

/**
 * List devices for the supervisor extension to find the correct device ID.
 * Useful for initial setup / debugging.
 */
export async function listSupervisorDevices() {
  const extId = config.supervisor.extensionId;
  const path = `/restapi/v1.0/account/~/extension/${extId}/device`;
  const data = await rcFetch(path);
  return (data.records || []).map(normalizeDevice);
}
