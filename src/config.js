import 'dotenv/config';

/** Trim secrets — hosting dashboards often append newlines when pasting. */
function t(key) {
  const v = process.env[key];
  return v === undefined || v === null ? '' : String(v).trim();
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
  },
  sip: {
    domain: t('SIP_INFO_DOMAIN'),
    outboundProxy: t('SIP_INFO_OUTBOUND_PROXY'),
    username: t('SIP_INFO_USERNAME'),
    password: t('SIP_INFO_PASSWORD'),
    authorizationId: t('SIP_INFO_AUTHORIZATION_ID'),
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
  },
};

export default config;
