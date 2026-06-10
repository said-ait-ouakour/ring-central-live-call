# RingCentral Live Call Audio Bridge

A standalone Node.js microservice that bridges RingCentral live call audio to AssemblyAI for real-time transcription, then pushes transcripts to the CRM via WebSocket.

## Architecture

```
RingCentral Call → Supervise API → SIP Softphone (this bridge)
                                        ↓
                                  Audio Packets (PCM 16-bit, 16kHz)
                                        ↓
                                  AssemblyAI Real-Time WebSocket
                                        ↓
                                  Transcript Events
                                        ↓
                                  WebSocket → CRM Frontend
```

## Prerequisites

1. **RingCentral Account** with Call Monitoring / Supervise permission enabled
2. **"Existing Phone" device** set up in RingCentral Admin (for SIP credentials)
3. **AssemblyAI account** with API key
4. **Node.js 18+**

## Setup

### 1. SIP device (supervisor)

The bridge loads SIP registration details from the RingCentral **device sip-info** API using `RC_SUPERVISOR_DEVICE_ID`, so you usually do **not** need to paste `SIP_INFO_*` variables. The supervisor must still have an **Existing Phone** (Other Phone) device in Admin → **Devices & Numbers** — the same device ID you use for supervision.

If the sip-info API is unavailable for your app, set the five `SIP_INFO_*` values from **Set up manually using SIP** on that device.

### 2. Get Supervisor Device ID

The device ID can be found via the RingCentral API:
```
GET /restapi/v1.0/account/~/extension/{supervisorExtensionId}/device
```
Look for the device with `type: "OtherPhone"`.

### 3. Install & Configure

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
```

### 4. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/supervise` | Start monitoring a live call |
| `GET` | `/api/calls` | List all active monitored calls |
| `DELETE` | `/api/calls/:callId` | Stop monitoring a specific call |
| `GET` | `/health` | Health check |

### POST /api/supervise

```json
{
  "telephonySessionId": "s-abc123",
  "partyId": "p-def456",
  "extensionId": "12345",
  "advisorName": "John Smith",
  "clientPhone": "+1234567890"
}
```

All requests require `x-api-key` header matching `BRIDGE_API_KEY`.

## WebSocket Protocol

Connect to `ws://bridge-host:3100/ws?apiKey=YOUR_BRIDGE_API_KEY`

### Client → Bridge

```json
{ "type": "subscribe", "callId": "s-abc123" }
{ "type": "unsubscribe", "callId": "s-abc123" }
```

### Bridge → Client

```json
{ "type": "call_started", "callId": "...", "advisor": {...}, "client": {...} }
{ "type": "transcript", "callId": "...", "text": "...", "isFinal": false }
{ "type": "call_ended", "callId": "...", "duration": 120 }
{ "type": "error", "message": "..." }
```

## Optional Ended-Call Forwarding

If `ENDED_CALL_WEBHOOK_URL` is configured, the bridge also forwards deduped RingCentral terminal call events to an external webhook such as n8n. This is separate from `RC_WEBHOOK_URL`:

- `RC_WEBHOOK_URL` is the public base URL RingCentral calls into.
- `ENDED_CALL_WEBHOOK_URL` is the full outbound n8n webhook URL the bridge calls after an ended call is detected.

The bridge responds to RingCentral immediately, then forwards the ended-call event asynchronously so live coaching is not blocked.

Example payload:

```json
{
  "eventType": "ringcentral.call_ended",
  "source": "rc-audio-bridge",
  "dedupeKey": "s-abc123:p-def456:ended",
  "telephonySessionId": "s-abc123",
  "partyId": "p-def456",
  "extensionId": "12345",
  "direction": "Inbound",
  "statusCode": "Disconnected",
  "eventTime": "2026-06-10T10:15:00.000Z",
  "from": { "phoneNumber": "+1234567890", "extensionId": null, "name": null },
  "to": { "phoneNumber": null, "extensionId": "12345", "name": "Agent Name" },
  "bridgeCallKnown": true
}
```

Recommended n8n flow:

- Accept the webhook and persist the `dedupeKey`.
- Push the event into a durable queue.
- Delay processing before fetching RingCentral call records or recordings.
- Apply throttling and retry in the worker path to avoid RingCentral rate limits.

## Deployment

This service needs an **always-on server** (not serverless). Recommended free options:

- **Render.com** — free tier Web Service
- **Railway.app** — $5/month free credit
- **Fly.io** — free tier with 3 small VMs

Set the required environment variables in the hosting platform's dashboard (see `.env.example`). SIP fields are optional when the RingCentral app can read device sip-info.

Optional SIP resilience tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `SIP_REGISTRATION_TIMEOUT_MS` | `15000` | Max time to wait for SIP registration before recreating the softphone and retrying |
| `SIP_MAX_REGISTRATION_AGE_MS` | `240000` | Age after which SIP registration is refreshed before a supervision request |
