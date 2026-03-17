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
 * @param {string} partyId - The party within the session to supervise
 * @returns {Promise<object>} - The supervised party info from RingCentral
 */
export async function startSupervision(telephonySessionId, partyId) {
  const path = `/restapi/v1.0/account/~/telephony/sessions/${telephonySessionId}/parties/${partyId}/supervise`;

  console.log(`[supervise] Starting supervision for session=${telephonySessionId} party=${partyId}`);

  const result = await rcFetch(path, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'Listen',
      supervisorDeviceId: config.supervisor.deviceId,
      agentExtensionId: config.supervisor.extensionId,
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
