/**
 * Report this bridge's own failures to the CRM's System Alerts.
 *
 * The CRM already checks the bridge's /health every five minutes and alerts
 * when a call it makes here fails. What it cannot see is what goes wrong in
 * here on its own: SIP registration dropping, AssemblyAI or Fireflies
 * failing mid-call, a transcript not saved. Those are posted to the CRM's
 * POST /api/system-alerts as `service_error`, and land in the same Teams
 * chat under the same rules (one is logged, five in an hour go to the chat,
 * twenty in an hour are urgent). Manager, 10 Nov 2026.
 *
 * Off until CRM_ALERTS_SECRET is set (the CRM's CRM_N8N_SHARED_SECRET).
 * Never throws and never holds a call up: a report that fails is a warning
 * in this log, nothing more. The same fault is sent at most every 30
 * seconds, so a burst costs one request, not hundreds.
 *
 *   CRM_ALERTS_SECRET  the CRM's CRM_N8N_SHARED_SECRET (required to switch on)
 *   CRM_ALERTS_URL     default {CRM_BASE_URL or CRM_URL}/api/system-alerts
 *   CRM_ALERTS_SOURCE  default live-meeting-bridge when BRIDGE_MODE=meetings,
 *                      else live-call-bridge (the names the CRM checks them by)
 */

const THROTTLE_MS = 30_000;
const TIMEOUT_MS = 5_000;

const LABELS = {
  'live-call-bridge': 'RingCentral live bridge',
  'live-meeting-bridge': 'Meeting bridge',
};

function message(error) {
  if (!error) return null;
  if (error instanceof Error) return error.message || error.name;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export function createAlertReporter({ url, secret, source, fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
  const enabled = Boolean(url && secret && source);
  const lastSent = new Map();
  const label = LABELS[source] || source;

  /**
   * key: what failed, stable across occurrences (e.g. "sip-registration"),
   * so the CRM counts them as one incident. title: a short sentence.
   * severity: 'p1' | 'p2' | 'p3', else the CRM's default for service_error.
   */
  async function report(key, title, error, { severity } = {}) {
    if (!enabled) return false;
    const at = now();
    if (at - (lastSent.get(key) || 0) < THROTTLE_MS) return false;
    lastSent.set(key, at);

    const body = {
      source: `service:${source}`,
      rule: 'service_error',
      key,
      title: `${label}: ${title}`,
      detail: (message(error) || title).slice(0, 1500),
    };
    if (severity) body.severity = severity;

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) log.warn(`[crm-alerts] the CRM answered ${response.status} for ${key}`);
      return response.ok;
    } catch (err) {
      log.warn(`[crm-alerts] could not report ${key}: ${message(err)}`);
      return false;
    }
  }

  return { enabled, report };
}

function env(key) {
  return String(process.env[key] || '').trim();
}

function alertsUrl() {
  const own = env('CRM_ALERTS_URL');
  if (own) return own;
  const base = (env('CRM_BASE_URL') || env('CRM_URL')).replace(/\/+$/, '');
  return base ? `${base}/api/system-alerts` : '';
}

const crmAlerts = createAlertReporter({
  url: alertsUrl(),
  secret: env('CRM_ALERTS_SECRET'),
  source: env('CRM_ALERTS_SOURCE') || (env('BRIDGE_MODE').toLowerCase() === 'meetings' ? 'live-meeting-bridge' : 'live-call-bridge'),
});

export function reportError(key, title, error, options) {
  return crmAlerts.report(key, title, error, options);
}

export const crmAlertsEnabled = crmAlerts.enabled;
