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

### 1. Get SIP Credentials from RingCentral

1. Login to [RingCentral Admin Portal](https://service.ringcentral.com)
2. Navigate to the supervisor user's **Devices & Numbers**
3. Find or create a device with type **"Existing Phone"**
4. Click **"Set Up and Provision"** → **"Set up manually using SIP"**
5. Note: `SIP Domain`, `Outbound Proxy`, `User Name`, `Password`, `Authorization ID`

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

## Deployment

This service needs an **always-on server** (not serverless). Recommended free options:

- **Render.com** — free tier Web Service
- **Railway.app** — $5/month free credit
- **Fly.io** — free tier with 3 small VMs

Set all environment variables in the hosting platform's dashboard.
