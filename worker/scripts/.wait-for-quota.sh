#!/usr/bin/env bash
# Waits for Cloudflare D1's daily row-read cap to reset (midnight UTC), then
# confirms with a real query before exiting. Exit 0 = quota clear, ready to
# migrate. Temporary helper for the one-time cutover; not part of the app.
set -u
cd /e/Projects/card-scanner/worker

ACCOUNT=541d9063453516ba295a2c1cbf298129
DB=32265ad6-4e1d-4ef8-8086-899962fcdb1f
TOKEN=$(grep -m1 '^CF_API_TOKEN=' .dev.vars.local | cut -d= -f2- | tr -d '"'\'' \r')

probe() {
  curl -s -m 30 -X POST \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data '{"sql":"SELECT COUNT(*) AS n FROM expansions","params":[]}' \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/d1/database/$DB/query"
}

target=$(date -u -d 'tomorrow 00:05' +%s)
now=$(date -u +%s)
wait_s=$(( target - now ))
echo "[wait-for-quota] sleeping ${wait_s}s until $(date -u -d @"$target")"
[ "$wait_s" -gt 0 ] && sleep "$wait_s"

# Poll every 5 min for up to 2h in case the reset lands late.
for i in $(seq 1 24); do
  resp=$(probe)
  if echo "$resp" | grep -q '"code":7500'; then
    echo "[wait-for-quota] attempt $i: still capped at $(date -u)"
    sleep 300
    continue
  fi
  if echo "$resp" | grep -q '"success":true'; then
    echo "[wait-for-quota] QUOTA CLEAR at $(date -u)"
    echo "$resp" | head -c 300
    exit 0
  fi
  echo "[wait-for-quota] attempt $i: unexpected response"
  echo "$resp" | head -c 300
  sleep 300
done

echo "[wait-for-quota] still capped after 2h of polling"
exit 1
