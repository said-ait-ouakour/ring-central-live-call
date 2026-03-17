/**
 * RingCentral OAuth authentication using JWT grant.
 * Manages access token lifecycle (obtain + refresh).
 */

import config from './config.js';

let accessToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }
  await authenticate();
  return accessToken;
}

async function authenticate() {
  const { clientId, clientSecret, serverUrl, jwtToken } = config.rc;
  const tokenUrl = `${serverUrl}/restapi/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtToken,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`RC auth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log('[rc-auth] Authenticated with RingCentral successfully');
}

/**
 * Make an authenticated GET/POST/DELETE to RingCentral REST API.
 */
export async function rcFetch(path, options = {}) {
  const token = await getAccessToken();
  const url = `${config.rc.serverUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    throw new Error(`RC API ${options.method || 'GET'} ${path} failed (${res.status}): ${errorText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}
