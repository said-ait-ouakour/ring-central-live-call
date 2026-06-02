/**
 * RingCentral OAuth authentication using JWT grant.
 * Manages access token lifecycle (obtain + refresh).
 */

import config from './config.js';

let accessToken = null;
let tokenExpiresAt = 0;
let authPromise = null;
let restQueue = Promise.resolve();
let nextRestAllowedAt = 0;
let lastRestRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(res) {
  const retryAfter = res.headers.get('retry-after');
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0);

  const dateMs = new Date(retryAfter).getTime();
  if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), 0);

  return null;
}

function scheduleGlobalRateLimitPause(res) {
  const retryAfterMs = parseRetryAfter(res);
  const pauseMs = retryAfterMs ?? config.rc.rest429PauseMs;
  nextRestAllowedAt = Math.max(nextRestAllowedAt, Date.now() + pauseMs);
  console.warn(`[rc-rate] 429 received; pausing RingCentral REST queue pauseMs=${pauseMs}`);
  return pauseMs;
}

async function runWithRestRateLimit(method, path, fn) {
  const run = restQueue.then(async () => {
    const now = Date.now();
    const spacingWaitMs = Math.max(0, config.rc.restMinSpacingMs - (now - lastRestRequestAt));
    const pauseWaitMs = Math.max(0, nextRestAllowedAt - now);
    const waitMs = Math.max(spacingWaitMs, pauseWaitMs);

    if (waitMs > 0) {
      console.log(`[rc-rate] waiting method=${method} path=${path} waitMs=${waitMs}`);
      await sleep(waitMs);
    }

    try {
      console.log(`[rc-rate] acquired method=${method} path=${path}`);
      return await fn();
    } finally {
      lastRestRequestAt = Date.now();
    }
  });

  restQueue = run.catch(() => {});
  return run;
}

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

  let response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: body.toString(),
  });

  if (response.status === 429) {
    const pauseMs = scheduleGlobalRateLimitPause(response);
    console.warn(`[rc-auth] token request rate limited; retrying after pauseMs=${pauseMs}`);
    await sleep(pauseMs);
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    });
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`RC auth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log(`[rc-auth] Authenticated with RingCentral successfully expiresAt=${new Date(tokenExpiresAt).toISOString()}`);
}

async function rcFetchOnce(path, options = {}) {
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
    if (res.status === 429) scheduleGlobalRateLimitPause(res);
    const err = new Error(`RC API ${options.method || 'GET'} ${path} failed (${res.status}): ${errorText}`);
    err.status = res.status;
    err.retryAfterMs = res.status === 429 ? parseRetryAfter(res) || config.rc.rest429PauseMs : null;
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

function shouldRetryAfter429(options) {
  const method = String(options.method || 'GET').toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE'].includes(method);
}

/**
 * Make an authenticated GET/POST/PUT/DELETE to RingCentral REST API.
 * All calls share one queue so bursty webhook events cannot fan out into 429 storms.
 */
export async function rcFetch(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const maxAttempts = shouldRetryAfter429(options) ? 2 : 1;

  return runWithRestRateLimit(method, path, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await rcFetchOnce(path, options);
      } catch (err) {
        const is429 = err?.status === 429 || err?.message?.includes('failed (429)') || err?.message?.includes('CMN-301');
        if (!is429 || attempt === maxAttempts) throw err;

        const pauseMs = err?.retryAfterMs ?? config.rc.rest429PauseMs;
        nextRestAllowedAt = Math.max(nextRestAllowedAt, Date.now() + pauseMs);
        console.warn(`[rc-rate] retrying after 429 method=${method} path=${path} attempt=${attempt + 1}/${maxAttempts} pauseMs=${pauseMs}`);
        await sleep(pauseMs);
      }
    }

    throw new Error(`RC API ${method} ${path} failed after ${maxAttempts} attempts`);
  });
}
