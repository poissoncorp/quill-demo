#!/usr/bin/env bash
# Brings a fresh checkout to a working demo.
#
#   ./scripts/setup.sh
#
# Asks for any key it is missing and writes .env itself, so nothing has to be
# edited by hand. Safe to re-run: the provisioning steps are idempotent and
# skip anything that already exists.
#
# If .env is already complete, plain `docker compose up -d` does the same job:
# the setup service provisions Quill and the app discovers the result. This
# script exists for the first run, when the keys are not on disk yet.

set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n\n' "$*" >&2; exit 1; }

[ -f .env ] || cp .env.example .env

# Reads a key from .env, prompting for it if it is empty. Input is hidden,
# because these are credentials and terminals keep scrollback.
ensure_key() {
    local name="$1" prompt="$2" value
    value=$(grep -E "^$name=" .env | cut -d= -f2- || true)
    case "$value" in ''|QUILL-...|QUILLDASH-...|sk-...) value='' ;; esac
    [ -n "$value" ] && return 0

    [ -t 0 ] || fail "$name is not set in .env, and there is no terminal to ask on."

    printf '\n  %s\n  %s: ' "$prompt" "$name"
    read -rs value
    printf '\n'
    [ -n "$value" ] || fail "$name cannot be empty."

    if grep -qE "^$name=" .env; then
        # A literal replacement, so a key containing / or & survives intact.
        python3 - "$name" "$value" <<'PY' 2>/dev/null || sed -i.bak "s|^$name=.*|$name=$value|" .env && rm -f .env.bak
import io, sys
name, value = sys.argv[1], sys.argv[2]
lines = io.open('.env', encoding='utf-8').read().splitlines()
out = [f'{name}={value}' if l.startswith(name + '=') else l for l in lines]
io.open('.env', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
PY
    else
        printf '%s=%s\n' "$name" "$value" >> .env
    fi
}

say "Checking credentials"
ensure_key QUILL_LICENSE_KEY "Quill licence key, from RavenDB (starts with QUILL-)"
ensure_key QUILL_API_KEY     "Quill dashboard API key (starts with QUILLDASH-)"
ensure_key OPENAI_API_KEY    "OpenAI API key (starts with sk-)"
echo "     all three present"

say "Starting everything"
# The setup service waits for Quill to bootstrap, provisions it, and exits.
docker compose up -d
echo "     Quill takes a couple of minutes to bootstrap on a cold volume."

say "Provisioning Quill"
docker compose logs -f setup 2>&1 | sed -u 's/^forkly-setup[^|]*| /     /' &
LOGS=$!
docker compose wait setup >/dev/null 2>&1 || true
kill $LOGS 2>/dev/null || true
wait $LOGS 2>/dev/null || true

code=$(docker inspect forkly-setup --format '{{.State.ExitCode}}' 2>/dev/null || echo 1)
[ "$code" = "0" ] || fail "provisioning failed. Full output: docker compose logs setup"

# The app exists now, so the model connection can be put where the agent will
# look for it. This has to happen before finish-setup runs, not after it fails:
# RavenDB rejects an app-scoped connection whose name collides with a
# server-wide one, and finish-setup would create exactly such a collision.
say "Linking the model connection to the app"
SLUG=$(grep -E '^QUILL_APP_SLUG=' .env | cut -d= -f2-)
SLUG=${SLUG:-forkly-demo}
CONN="${QUILL_CONNECTION_NAME:-$SLUG-llm}"
./scripts/ensure-ai-connection.sh "$SLUG" "$CONN"     || fail "could not attach the model connection"

say "Creating the agent and the widget channel"
docker compose run --rm -e QUILL_CONNECTION_NAME="$CONN" configure 2>&1 | sed 's/^/     /'     || fail "agent setup failed. Full output: docker compose logs configure"

say "Waiting for the app to pick it up"
for _ in $(seq 1 30); do
    if curl -sf http://localhost:3000/api/quill/status 2>/dev/null | grep -q '"configured":true'; then
        say "Ready. Open http://localhost:8080 and press the button."
        exit 0
    fi
    sleep 2
done

fail "the app still reports missing configuration. Check: docker compose logs app"
