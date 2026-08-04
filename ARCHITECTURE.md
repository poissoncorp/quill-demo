# Architecture

Four processes. Forkly is an ordinary app that happens to have a chat widget bolted on; everything Quill-specific lives in one section of one file.

```
                        ┌─────────────────────────────────────────┐
                        │  Quill        thegoldenplatypus/quill    │
   ┌────────────┐ CDC   │                                          │
   │  Postgres  ├──────▶│  mirror ──▶ agent ──▶ channel (widget)    │
   │  :5432     │       │  9.9k docs   12 RQL    wgt_…              │
   └─────┬──────┘       │              tools                        │
         │ SELECT       └───────┬──────────────────┬────────────────┘
         │                      │ api.<domain>     │ public.<domain>
         │                      │ (X-Api-Key)      │ (token in URL)
   ┌─────▼──────────────────────┴───┐              │
   │  Forkly app        :3000       │              │
   │  Express + static frontend     │              │
   └─────▲──────────────────────┬───┘              │
         │ /api/quill/*         │ iframe src ──────┤
   ┌─────┴──────────┐           │                  │
   │  Pilot  :8080  │           └── bubble in the app
   │  static page   │──────────────── chat embedded in the deck
   └────────────────┘
```

## The four pieces

**Postgres** holds Forkly's data. The only thing done for Quill is `wal_level=logical`, plus a read-only account with `REPLICATION` and `REFERENCES`. No schema changes, no triggers, no writes back.

**Quill** mirrors that database over CDC into its own document store, and exposes an agent over the mirror. It runs as a separate container on 443 with its own `*.myquill.ai` domain.

**The Forkly app** serves the console and its API. One section at the bottom of `app/server.js` is the entire Quill integration.

**The pilot deck** is a static page that drives the demo. It talks only to Forkly's backend, never to Quill.

## How a question gets answered

The model never touches the database and never writes SQL:

```
prompt ─▶ model ─▶ "call ordersInWindow(zoneId: 2, from: …, to: …)"
                        │
                  Quill runs the named RQL query against its mirror
                        │
                  rows ─▶ model ─▶ answer
```

The agent holds twelve named queries with descriptions and parameter schemas. It chooses which to run and with what arguments; Quill executes them and returns rows. That is the difference between "AI with database access" and "AI allowed to ask twelve specific questions", and it is what makes the thing safe to expose.

Practical consequence: the agent is only as good as its tool set. Most of the tuning in this demo went into the tools and the system prompt, not the model choice.

## The attach path

Pressing **Enable Quill** does one real thing:

1. The pilot calls `POST /api/quill/attach` on Forkly's backend.
2. Forkly calls Quill's `POST /api/apps/{slug}/embed-links` twice, with `X-Api-Key` **server side**, and gets back two `https://public.<domain>/embed/{token}` URLs.
3. One is stored and picked up by the app's frontend, which polls `/api/quill/status` every two seconds and grows a bubble. The other is returned to the pilot, which embeds it directly.

Same agent, two independent links, two surfaces. Nothing in Forkly is rebuilt or redeployed.

## What crosses which boundary

| | |
|---|---|
| `QUILLDASH-…` API key | server side only, never reaches a browser |
| `OPENAI_API_KEY` | only ever handed to Quill during setup, never at runtime by the app |
| Embed URL | the only thing the browser receives |
| Postgres credentials | app and Quill each have their own read-only account |

The embed token is a **bearer credential**: no auth header, no cookie, no origin binding. Whoever holds the link can talk to the agent until the TTL expires or `maxInvocations` runs out. That is why links are minted server side, per session, and short lived. The demo uses one hour and 100 invocations; in production, use minutes and a low cap.

## Setup, done once before the demo

```
setup/connect ──▶ setup/discover ──▶ setup/map ──▶ setup/provision ──▶ ingest
                                                                          │
                        ai/connection-strings ──▶ setup/agent ──▶ setup/channel
```

The first row is `quill/provision.mjs`, the second `quill/finish-setup.mjs`. Both run automatically in the one-shot `setup` service on `docker compose up`. `setup/map` must run before `provision`, otherwise the wizard reuses configuration from a previous session.

## Versions

The compose file pins the Quill image **by digest**, not by `:latest`. That is deliberate. During development the tag moved and the new build renamed API fields (`widgetId` became `channelId`) and changed the embed URL path, which broke the demo without a single line changing in this repo.

To move to a newer build on purpose:

```bash
docker pull thegoldenplatypus/quill:latest
docker image inspect thegoldenplatypus/quill:latest --format '{{index .RepoDigests 0}}'
```

Put the result in `docker-compose.yml` and re-run the demo end to end before trusting it. The app already sends and accepts both `channelId` and `widgetId`, and rewrites the embed URL origin, so those two changes are covered.
