#!/usr/bin/env bash
# Puts the model connection where the agent will actually look for it.
#
# On current builds `POST /api/ai/connection-strings` stores the connection
# server-wide. `GET /api/apps/<slug>/connection-strings` then lists it under the
# app, which makes it look available, but `setup/agent` reads the app's own
# RavenDB database and rejects it with:
#
#   connection string '<name>' not found in app '<slug>'
#
# There is no app-scoped create route on the HTTP API, so this writes the
# connection straight into the app's database through RavenDB's admin endpoint,
# using the admin certificate that ships inside the appliance's setup package.
#
# Remove this the moment Quill grows an app-scoped route. It reaches around the
# product's own API, which is not somewhere a demo should have to go.
#
#   ./scripts/ensure-ai-connection.sh <app-slug> [connection-name]

set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:?usage: ensure-ai-connection.sh <app-slug> [connection-name]}"
# Derived from the slug by default. RavenDB refuses an app-scoped connection
# whose name collides with a server-wide one, and server-wide entries persist
# and cannot be deleted, so a fixed shared name breaks on the second app ever
# created on an instance.
NAME="${2:-$SLUG-llm}"
MODEL="${QUILL_MODEL:-gpt-5.3-chat-latest}"
KEY=$(grep -E '^OPENAI_API_KEY=' .env | cut -d= -f2-)
[ -n "$KEY" ] || { echo "OPENAI_API_KEY is not set in .env" >&2; exit 1; }

q() { docker compose exec -T quill sh -c "$1"; }

# The admin certificate ships as a .pfx. Split it once, keep it in /tmp.
q 'test -f /tmp/adm.crt -a -f /tmp/adm.key || {
     P=$(ls /var/lib/quill/setup/admin.client.certificate.*.pfx | head -1)
     openssl pkcs12 -in "$P" -passin pass: -nokeys  -out /tmp/adm.crt 2>/dev/null
     openssl pkcs12 -in "$P" -passin pass: -nocerts -nodes -out /tmp/adm.key 2>/dev/null
   }'

# Written unconditionally, on purpose. The database view merges server-wide
# connections into the same list, so a textual match cannot tell "the app owns
# this" from "the cluster owns this and the app can see it". Only the first
# satisfies the agent, and the PUT overwrites, so writing every time is both
# simpler and correct.
cat > .ai-conn.json <<JSON
{"Type":"Ai","Name":"$NAME","Identifier":"$NAME","ModelType":"Chat",
 "OpenAiSettings":{"Model":"$MODEL","ApiKey":"$KEY",
 "Endpoint":"${OPENAI_ENDPOINT:-https://api.openai.com/v1}",
 "EnablePromptCache":true,"EmbeddingsMaxConcurrentBatches":null}}
JSON
docker compose cp .ai-conn.json quill:/tmp/ai-conn.json >/dev/null
rm -f .ai-conn.json

CODE=$(q "curl -sk --cert /tmp/adm.crt --key /tmp/adm.key -m 20 -o /dev/null -w '%{http_code}' \
          -X PUT -H 'Content-Type: application/json' --data-binary @/tmp/ai-conn.json \
          https://127.0.0.1:8443/databases/$SLUG/admin/connection-strings")
q 'rm -f /tmp/ai-conn.json'

case "$CODE" in
    20*) echo "     connection '$NAME' written into app '$SLUG' ($MODEL)" ;;
    *)   echo "     failed to write the connection, HTTP $CODE" >&2; exit 1 ;;
esac
