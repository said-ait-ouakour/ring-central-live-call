import 'dotenv/config';

const required = [
  'RC_CLIENT_ID',
  'RC_CLIENT_SECRET',
  'RC_SERVER_URL',
  'RC_JWT_TOKEN',
  'SIP_INFO_DOMAIN',
  'SIP_INFO_OUTBOUND_PROXY',
  'SIP_INFO_USERNAME',
  'SIP_INFO_PASSWORD',
  'SIP_INFO_AUTHORIZATION_ID',
  'RC_SUPERVISOR_EXTENSION_ID',
  'RC_SUPERVISOR_DEVICE_ID',
  'ASSEMBLYAI_API_KEY',
  'BRIDGE_API_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  console.error('\nCopy .env.example to .env and fill in all values.');
  process.exit(1);
}

const config = {
  rc: {
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
    serverUrl: process.env.RC_SERVER_URL,
    jwtToken: process.env.RC_JWT_TOKEN,
  },
  sip: {
    domain: process.env.SIP_INFO_DOMAIN,
    outboundProxy: process.env.SIP_INFO_OUTBOUND_PROXY,
    username: process.env.SIP_INFO_USERNAME,
    password: process.env.SIP_INFO_PASSWORD,
    authorizationId: process.env.SIP_INFO_AUTHORIZATION_ID,
  },
  supervisor: {
    extensionId: process.env.RC_SUPERVISOR_EXTENSION_ID,
    deviceId: process.env.RC_SUPERVISOR_DEVICE_ID,
  },
  assemblyai: {
    apiKey: process.env.ASSEMBLYAI_API_KEY,
  },
  server: {
    port: parseInt(process.env.PORT || '3100', 10),
    apiKey: process.env.BRIDGE_API_KEY,
    crmUrl: process.env.CRM_URL || 'http://localhost:3000',
  },
};

export default config;
