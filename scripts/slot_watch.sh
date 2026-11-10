#!/usr/bin/env bash
# Slot watcher: gentle probes (~every 150s) for a free savenow quota slot.
# On first success: fire the app-level 4K job immediately and print its id.
set -u
BASE="http://localhost:3999"
K="dfcb6d76f2f6a9894gjkege8a4ab232222"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# server up?
curl -sf --max-time 4 "$BASE/api/health" > /dev/null 2>&1 || {
  pkill -f "standalone/server.js" 2>/dev/null; sleep 1
  cd /home/z/my-project/.next/standalone
  setsid env PORT=3999 FCLIP_DATA_DIR=/tmp/fclip-e2e NODE_ENV=production \
    nohup node server.js > /tmp/fclip-e2e.log 2>&1 < /dev/null &
  sleep 4
}

for i in 1 2 3 4; do
  R=$(curl -sS --max-time 20 "https://p.savenow.to/api/v2/download?format=4k&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ&apikey=$K" \
      -H "User-Agent: $UA" -H "Origin: https://en.loader.to" -H "Referer: https://en.loader.to/" 2>/dev/null)
  if echo "$R" | grep -q '"success":true'; then
    echo "SLOT OPEN at probe $i — firing app job"
    JOB=$(curl -s --max-time 20 -X POST "$BASE/api/clip" -H "Content-Type: application/json" \
      -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","start":5,"end":15,"maxHeight":2160,"title":"e2e-4k-final"}')
    JID=$(echo "$JOB" | jq -r '.job.id // empty')
    echo "JOBID=$JID"
    exit $([ -n "$JID" ] && echo 0 || echo 1)
  fi
  echo "probe $i: $(echo "$R" | grep -oE '"error_code":"[a-z_]+"' || echo '?')"
  [ $i -lt 4 ] && sleep 150
done
echo "NO SLOT in watch window"
exit 2
