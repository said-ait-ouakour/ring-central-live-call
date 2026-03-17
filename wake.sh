#!/bin/bash
# Wake up the Render bridge and wait for it to be ready (SIP registered)
# Usage: ./wake.sh
# Or:    ./wake.sh https://your-bridge.onrender.com

BRIDGE_URL="${1:-https://your-bridge-name.onrender.com}"

echo "Waking up bridge at $BRIDGE_URL ..."

# First request wakes Render from sleep (~30-60s cold start)
curl -s "$BRIDGE_URL/health" > /dev/null 2>&1

echo "Waiting for cold start (this takes ~60 seconds on Render free tier)..."
sleep 5

# Poll until the bridge responds with status "ok"
MAX_ATTEMPTS=24
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))
  RESPONSE=$(curl -s --max-time 5 "$BRIDGE_URL/health" 2>/dev/null)

  if echo "$RESPONSE" | grep -q '"status":"ok"'; then
    echo ""
    echo "Bridge is UP and ready!"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    echo ""
    echo "You can now make a test call. The bridge will stay up during the call."
    exit 0
  fi

  echo "  Attempt $ATTEMPT/$MAX_ATTEMPTS — not ready yet, waiting 5s..."
  sleep 5
done

echo ""
echo "Bridge did not respond after $MAX_ATTEMPTS attempts."
echo "Check: $BRIDGE_URL/health"
exit 1
