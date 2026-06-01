/**
 * RingCentral OAuth authentication using JWT grant.
 * Manages access token lifecycle (obtain + refresh).
 */

import config from './config.js';

let accessToken = null;
let tokenExpiresAt = 0;
let authPromise = null;

function getTokenStatus() {
  const now = Date.now();
  return {
    hasToken: Boolean(accessToken),
    expiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
    expiresInMs: Math.max(tokenExpiresAt - now, 0),
    valid: Boolean(accessToken && now < tokenExpiresAt - 60_000),
  };
}

export function getAuthStatus() {
  return getTokenStatus();
}

export async function getAccessToken() {
  const status = getTokenStatus();
  if (status.valid) {
    console.log(`[rc-auth] token valid expiresAt=${status.expiresAt}`);
    return accessToken;
  }

  console.log(`[rc-auth] token refresh required hasToken=${status.hasToken} expiresAt=${status.expiresAt}`);
  await authenticate();
  return accessToken;
}

async function authenticate() {
  if (authPromise) return authPromise;

  authPromise = authenticateNow()
    .catch((err) => {
      console.error(`[rc-auth] token refresh failed: ${err.message}`);
      throw err;
    })
    .finally(() => {
      authPromise = null;
    });

  return authPromise;
}

async function authenticateNow() {
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

  console.log(`[rc-auth] Authenticated with RingCentral successfully expiresAt=${new Date(tokenExpiresAt).toISOString()}`);
}

/**
 * Make an authenticated GET/POST/DELETE to RingCentral REST API.
 */
export async function rcFetch(path, options = {}) {
  const url = `${config.rc.serverUrl}${path}`;

  let token = await getAccessToken();
  let res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 401 || res.status === 403) {
    const errorText = await res.text().catch(() => res.statusText);
    const shouldRetry = res.status === 401 || errorText.includes('Token') || errorText.includes('token');
    if (shouldRetry) {
      console.warn(`[rc-auth] RC API auth failure (${res.status}); refreshing token and retrying ${options.method || 'GET'} ${path}: ${errorText}`);
      accessToken = null;
      tokenExpiresAt = 0;
      token = await getAccessToken();
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } else {
      throw new Error(`RC API ${options.method || 'GET'} ${path} failed (${res.status}): ${errorText}`);
    }
  }

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
