/**
 * RingCentral Call Supervise API.
 * Silently taps into a live call so the bridge's softphone receives the audio.
 */

import { rcFetch } from './rc-auth.js';
import config from './config.js';

/**
 * Start supervising (silently listening to) a live call.
 *
 * @param {string} telephonySessionId - The telephony session to supervise
 * @param {string} partyId - The party that triggered supervision; kept for logging
 * @param {string} agentExtensionId - The advisor's extension ID (the person on the call)
 * @returns {Promise<object>} - The supervised party info from RingCentral
 */
export async function startSupervision(telephonySessionId, partyId, agentExtensionId) {
  const path = `/restapi/v1.0/account/~/telephony/sessions/${telephonySessionId}/supervise`;

  console.log(`[supervise] Starting session supervision for session=${telephonySessionId} triggerParty=${partyId} agent=${agentExtensionId}`);

  const result = await rcFetch(path, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'Listen',
      supervisorDeviceId: config.supervisor.deviceId,
      agentExtensionId: agentExtensionId,
    }),
  });

  console.log(`[supervise] Supervision started. Supervisor party:`, result?.party?.id || 'unknown');
  return result;
}

/**
 * List devices for the supervisor extension to find the correct device ID.
 * Useful for initial setup / debugging.
 */
export async function listSupervisorDevices() {
  const extId = config.supervisor.extensionId;
  const path = `/restapi/v1.0/account/~/extension/${extId}/device`;
  const data = await rcFetch(path);
  return (data.records || []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    status: d.status,
    serial: d.serial,
  }));
}
