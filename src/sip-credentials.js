/**
 * Resolve SIP registration credentials for ringcentral-softphone.
 *
 * Prefer RingCentral's device SIP-info REST API so domain, proxy, and digest
 * secrets always match the account (production vs sandbox, region, etc.).
 * PaaS deployments often see SIP/2.0 401 when SIP_INFO_* was copied with
 * whitespace or does not match the JWT account environment.
 */

import { rcFetch } from './rc-auth.js';
import config from './config.js';

function pickTlsProxy(outboundProxies, region) {
  if (!Array.isArray(outboundProxies) || outboundProxies.length === 0) {
    return null;
  }
  const r = region || 'NA';
  let p = outboundProxies.find((x) => x.region === r);
  if (!p) {
    p = outboundProxies[0];
  }
  return p.proxyTLS || p.proxy || null;
}

/**
 * @returns {Promise<{ domain: string, outboundProxy: string, username: string, password: string, authorizationId: string }>}
 */
export async function loadSipCredentials() {
  const region = (process.env.SIP_OUTBOUND_REGION || 'NA').trim();
  const manual = config.sip;

  try {
    const deviceId = config.supervisor.deviceId;
    const data = await rcFetch(`/restapi/v1.0/account/~/device/${deviceId}/sip-info`);
    const outboundProxy = pickTlsProxy(data.outboundProxies, region);

    if (!data.domain || !data.userName || !data.password || !data.authorizationId || !outboundProxy) {
      throw new Error('RingCentral sip-info response missing domain, userName, password, authorizationId, or outbound proxy');
    }

    console.log('[sip] Loaded credentials from RingCentral device sip-info API');
    return {
      domain: data.domain,
      outboundProxy,
      username: data.userName,
      password: data.password,
      authorizationId: data.authorizationId,
    };
  } catch (err) {
    if (
      manual.domain
      && manual.outboundProxy
      && manual.username
      && manual.password
      && manual.authorizationId
    ) {
      console.warn('[sip] Device sip-info API failed; using SIP_INFO_* env vars:', err.message);
      return {
        domain: manual.domain,
        outboundProxy: manual.outboundProxy,
        username: manual.username,
        password: manual.password,
        authorizationId: manual.authorizationId,
      };
    }

    throw new Error(
      `${err.message}. Either fix API access to GET /device/{id}/sip-info for this JWT app, `
        + 'or set all of SIP_INFO_DOMAIN, SIP_INFO_OUTBOUND_PROXY, SIP_INFO_USERNAME, SIP_INFO_PASSWORD, SIP_INFO_AUTHORIZATION_ID.',
    );
  }
}
