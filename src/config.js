import 'dotenv/config';

/** Trim secrets — hosting dashboards often append newlines when pasting. */
function t(key) {
  const v = process.env[key];
  return v === undefined || v === null ? '' : String(v).trim();
}

function intEnv(key, fallback) {
  const parsed = parseInt(process.env[key] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const required = [
  'RC_CLIENT_ID',
  'RC_CLIENT_SECRET',
  'RC_SERVER_URL',
  'RC_JWT_TOKEN',
  'RC_SUPERVISOR_EXTENSION_ID',
  'RC_SUPERVISOR_DEVICE_ID',
  'ASSEMBLYAI_API_KEY',
  'BRIDGE_API_KEY',
];

const missing = required.filter((key) => !t(key));
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  console.error('\nCopy .env.example to .env and fill in all values.');
  process.exit(1);
}

const config = {
  rc: {
    clientId: t('RC_CLIENT_ID'),
    clientSecret: t('RC_CLIENT_SECRET'),
    serverUrl: t('RC_SERVER_URL'),
    jwtToken: t('RC_JWT_TOKEN'),
    restMinSpacingMs: intEnv('RC_REST_MIN_SPACING_MS', 1200),
    rest429PauseMs: intEnv('RC_REST_429_PAUSE_MS', 30000),
    superviseInitialDelayMs: intEnv('RC_SUPERVISE_INITIAL_DELAY_MS', 1500),
    superviseMaxAttempts: Math.max(1, intEnv('RC_SUPERVISE_MAX_ATTEMPTS', 5)),
  },
  sip: {
    domain: t('SIP_INFO_DOMAIN'),
    outboundProxy: t('SIP_INFO_OUTBOUND_PROXY'),
    username: t('SIP_INFO_USERNAME'),
    password: t('SIP_INFO_PASSWORD'),
    authorizationId: t('SIP_INFO_AUTHORIZATION_ID'),
    registrationTimeoutMs: intEnv('SIP_REGISTRATION_TIMEOUT_MS', 15000),
    maxRegistrationAgeMs: intEnv('SIP_MAX_REGISTRATION_AGE_MS', 4 * 60 * 1000),
  },
  supervisor: {
    extensionId: t('RC_SUPERVISOR_EXTENSION_ID'),
    deviceId: t('RC_SUPERVISOR_DEVICE_ID'),
    monitoredExtensionId: t('RC_MONITORED_EXTENSION_ID'),
  },
  assemblyai: {
    apiKey: t('ASSEMBLYAI_API_KEY'),
  },
  supabase: {
    url: t('SUPABASE_URL') || t('NEXT_PUBLIC_SUPABASE_URL'),
    serviceRoleKey: t('SUPABASE_SERVICE_ROLE_KEY') || t('SUPBASE_SERVICE_API_KEY') || t('SUPABASE_SERVICE_API_KEY'),
  },
  server: {
    port: parseInt(process.env.PORT || '3100', 10),
    apiKey: t('BRIDGE_API_KEY'),
    crmUrl: t('CRM_URL') || 'http://localhost:3000',
    webhookUrl: t('RC_WEBHOOK_URL'),
    endedCallWebhookUrl: t('ENDED_CALL_WEBHOOK_URL'),
    endedCallWebhookBearerToken: t('ENDED_CALL_WEBHOOK_BEARER_TOKEN'),
    endedCallWebhookTimeoutMs: intEnv('ENDED_CALL_WEBHOOK_TIMEOUT_MS', 5000),
    endedCallWebhookDedupeTtlMs: intEnv('ENDED_CALL_WEBHOOK_DEDUPE_TTL_MS', 30 * 60 * 1000),
  },
};

export default config;
