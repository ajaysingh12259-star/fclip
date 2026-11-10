#!/usr/bin/env bash
# fclip 4K lane E2E: start server, fire a 2160p clip job, poll to completion.
set -u
PORT=3999
BASE="http://localhost:$PORT"
DATA=/tmp/fclip-e2e

# 1. fresh server (setsid so it can outlive this shell if needed)
# NOTE: Next.js renames the process to "next-server (v…)" — pkill by that
# title (or fall back to the port owner), NOT by server.js path.
pkill -f "next-server" 2>/dev/null; sleep 1
PID=$(ss -tlnp 2>/dev/null | grep :3999 | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${PID:-}" ] && kill "$PID" 2>/dev/null && sleep 1
cd /home/z/my-project/.next/standalone
setsid env PORT=$PORT FCLIP_DATA_DIR=$DATA NODE_ENV=production \
  nohup node server.js > /tmp/fclip-e2e.log 2>&1 < /dev/null &

for i in $(seq 1 15); do
  sleep 1
  curl -sf --max-time 3 "$BASE/api/health" > /dev/null 2>&1 && break
done
echo "health: $(curl -s --max-time 5 $BASE/api/health | head -c 120)"

# 2. fire the 4K job
JOB=$(curl -s --max-time 20 -X POST "$BASE/api/clip" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","start":5,"end":15,"maxHeight":2160,"title":"e2e-4k"}')
JID=$(echo "$JOB" | jq -r '.job.id // empty')
[ -z "$JID" ] && { echo "JOB START FAILED: $JOB"; exit 1; }
echo "job: $JID"

# 3. poll to completion (max ~8 min)
for i in $(seq 1 48); do
  sleep 10
  J=$(curl -sf --max-time 8 "$BASE/api/clip?jobId=$JID" 2>/dev/null) || { echo "[$i] poll failed (server down?)"; continue; }
  S=$(echo "$J" | jq -r '.job.status'); ST=$(echo "$J" | jq -r '.job.stage'); P=$(echo "$J" | jq -r '.job.progress')
  echo "[$i] $S | $ST | ${P}%"
  if [ "$S" = "done" ] || [ "$S" = "error" ]; then
    echo "--- log tail ---"
    echo "$J" | jq -r '.job.logTail[]?'
    echo "$J" | jq -c '{status:.job.status, filename:.job.filename, filesize:.job.filesize, error:.job.error}'
    exit $([ "$S" = "done" ] && echo 0 || echo 1)
  fi
done
echo "TIMEOUT waiting for job"
exit 2
