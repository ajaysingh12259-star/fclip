#!/bin/bash
# Poll Railway fclip service until the build finishes, then hit /api/health
export RAILWAY_TOKEN=rlwy_proj_MgsdSUk1oBMBIvDlUTmJb38wuW8b190ug80U4THs

for i in $(seq 1 18); do
  STATUS=$(railway status 2>/dev/null | grep -E "^\s+- fclip:" | head -1)
  echo "[poll $i] $STATUS"
  if echo "$STATUS" | grep -qE "Online$|Crashed|Failed"; then
    # "Online" alone = build done; "Online · Building" = still building
    if echo "$STATUS" | grep -qv "Building"; then
      echo ">>> Build finished."
      break
    fi
  fi
  sleep 30
done

echo "--- final status ---"
railway status 2>/dev/null | grep -E "^\s+- fclip:"
echo "--- health check ---"
curl -s -m 20 -o /tmp/health.json -w "HTTP %{http_code} in %{time_total}s\n" https://fclip-production.up.railway.app/api/health
cat /tmp/health.json 2>/dev/null; echo
