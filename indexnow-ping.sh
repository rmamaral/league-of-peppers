#!/usr/bin/env bash
# Ping IndexNow so Bing / Copilot, Yandex, Seznam, and other participating
# engines re-crawl the site immediately. Run this after you update data.js and
# redeploy (esp. picks.html), so search + AI engines see the new content fast.
#
# Usage:
#   ./indexnow-ping.sh                      # pings the default URLs below
#   ./indexnow-ping.sh https://.../foo.html # pings only the URLs you pass
set -euo pipefail

HOST="league-of-peppers.com"
KEY="e5512bca5298715d054a8b7697c00fb6"           # matches ${KEY}.txt in the web root
KEY_URL="https://${HOST}/${KEY}.txt"

# Default URL set = the two indexed pages. Override by passing URLs as arguments.
if [ "$#" -gt 0 ]; then
  URLS=("$@")
else
  URLS=("https://${HOST}/" "https://${HOST}/picks.html")
fi

# Build the JSON urlList
list=""
for u in "${URLS[@]}"; do list="${list}\"${u}\","; done
list="${list%,}"

body=$(cat <<JSON
{"host":"${HOST}","key":"${KEY}","keyLocation":"${KEY_URL}","urlList":[${list}]}
JSON
)

echo "Submitting ${#URLS[@]} URL(s) to IndexNow…"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" --data "${body}")
echo "IndexNow response: HTTP ${code}  (200/202 = accepted)"
