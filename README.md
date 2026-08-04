# Forkly: a live Quill demo

An ordinary app on Postgres gains conversational AI over its own data, in one click, in front of the audience.

Forkly is a food delivery marketplace operations console. Tables, filters, exports, no AI anywhere in it. Quill mirrors its database, an agent is configured over the mirror, and a single button hands the app a chat widget. Nothing in Forkly is rebuilt or redeployed.

The whole demo is driven from one page: **http://localhost:8080**

## Before you start

You need four things:

| | |
|---|---|
| **Docker** | with Compose. Ports `3000`, `5432`, `8080` and `443` free. |
| **A Quill licence key** | `QUILL-…`, from RavenDB. |
| **A Quill dashboard key** | `QUILLDASH-…`, created in the Quill dashboard. |
| **An OpenAI API key** | `sk-…`. Pick a non-reasoning model, see [Choosing a model](#choosing-a-model). |

`setup.sh` starts Quill for you, so you do not need an instance running beforehand.

> **Back up the Quill volume.** On first start Quill downloads a one-time setup package, tied to your licence, and keeps it in the `quill-data` volume. The licence API will not issue it a second time: starting fresh with the same key fails with `license API returned 404 Not Found retrieving the setup package` and bootstrap never leaves `NeedsActivation`. Treat that volume like a certificate, not a cache.

## Quick start

```bash
./scripts/setup.sh
```

It asks for the three keys if it does not find them, and writes `.env` itself. Nothing needs editing by hand. Once `.env` is complete, plain `docker compose up -d` does the same job.

Then open **http://localhost:8080** and press the button.

`setup.sh` is safe to re-run; every step checks whether it has already been done. It takes a few minutes on a cold start, most of it Quill bootstrapping. In order it:

1. Starts Postgres, the app, the pilot deck and Quill. Postgres runs `db/init/*.sql` on first boot: schema, grants, and the data generator.
2. Waits for Quill to bootstrap. It derives its own domain from your licence key.
3. Connects Quill to Postgres, maps the tables into a document model, and waits for the initial mirror.
4. Creates the model connection, the agent with its query tools, and the widget channel.
5. Waits for the app to discover all of it and report itself configured.

If a status dot at the top of the pilot is not green, check `docker compose ps` and `docker compose logs quill`.

### Already running a Quill instance?

`docker compose up` will collide with it on port 443. Either stop yours first, or leave the `quill` service out and point the existing one at the demo network under that name:

```bash
docker compose up -d postgres app pilot
docker network connect --alias quill quill-demo_default <your-container>
```

Then run the provisioning service on its own:

```bash
docker compose run --rm setup
```

## Presenter runbook

1. **Open the pilot.** All three status dots green. If not, stop and fix it before an audience is watching.
2. **Beat 1, the app.** Open Forkly. Scroll the orders, open Reviews. Point out there is nowhere to type a question.
3. **Beat 2, enable.** Press **Enable Quill**. The timing appears under the button. That is the moment the room sees it is live.
4. **Beat 3, ask.** The chat is now embedded in the pilot page. Ask one of the suggested questions. Then switch to the Forkly tab: a bubble has appeared in the corner on its own, no reload. Same agent, two independent links.
5. **Beat 4, the reveal.** Only now open the dashboard. Show the mapping and the agent. Stress that the model never touches the database, only named queries.

There is a **reset demo** control at the bottom of the pilot. Use it before presenting: it revokes the links and hides the bubble, so the audience sees the app before the AI, not after.

## What the demo asks

Three questions, none of which any screen in the app answers:

- *Why do Friday deliveries fall apart in Riverside?*
- *Which dish gets great reviews but loses us money?*
- *Any courier who needs a word, despite good times?*

They work because the data is planted, not random. Three truths are seeded, each needing a different kind of reasoning:

**Friday in Riverside.** Average delivery is 68 minutes on Friday evenings against 38.8 elsewhere. The cause is split across three tables and no single one explains it: two restaurants take two thirds of the zone's Friday traffic and miss their promised prep time by half an hour, courier staffing drops from 9 to 5 on Fridays, and the reviews say outright that the courier stood waiting.

**The trap dish.** Wild Mushroom Risotto: $64 at a $43 cost, 32 minutes of kitchen time against a typical 14, in 40% of its restaurant's orders, and the best reviews on the menu. A bestseller that costs money.

**The two-faced courier.** Mark Wolfe delivers in 11.4 minutes against a 17.6 average and carries a 2.81 rating. Every complaint is about behaviour, none about speed.

The generator is deterministic (hashing rather than `random()`), so the same data comes out every time, and it self-checks: if a planted story fails to appear, `RAISE EXCEPTION` fails the load rather than leaving you with a demo that quietly does not work.

Verify at any time:

```bash
docker exec -i forkly-postgres psql -U postgres -d zjadlo < db/verify-stories.sql
```

All data is synthetic. Names, restaurants, reviews and the city are invented.

## Choosing a model

**Reasoning models do not work.** Quill sends `reasoning_effort` alongside tool definitions, which reasoning models reject, and the agent returns an empty answer.

Verified working: `gpt-5.3-chat-latest` (the default here), `gpt-5.2-chat-latest`, `gpt-4.1`, `gpt-4o`. Accuracy varies between them noticeably, so prefer the default unless you have a reason not to.

Override with `-e QUILL_MODEL=…` on the `finish-setup.mjs` run.

## Iterating on the agent

To change the prompt or the query tools without creating another channel and invalidating the widget id:

```bash
docker run --rm --network quill-demo_default -v "$PWD:/w" -w /w --env-file .env -e AGENT_ONLY=1 node:20-alpine node quill/finish-setup.mjs
```

The system prompt in `quill/finish-setup.mjs` carries several workarounds for behaviour that fails silently. They are commented in place. Removing them makes the agent answer confidently and wrongly, so read the comment before deleting one.

## Layout

```
docker-compose.yml           postgres + app + pilot + quill
.env.example                 template for the keys, copy to .env
db/init/01-schema.sql        schema, users, CDC grants
db/init/02-seed.sql          data generator with the planted stories
db/verify-stories.sql        proves the stories are visible in the data
app/                         Forkly: Node + Express, the console with no AI
app/server.js                app API, plus the one section that knows Quill exists
pilot/                       the deck that drives the demo
quill/build-mapping.mjs      turns a discovered schema into a Quill mapping
quill/provision.mjs          connect, discover, map, provision, wait for ingest
quill/finish-setup.mjs       model connection + agent + channel
scripts/setup.sh             asks for keys, starts everything, one command
quill/widget-forkly.css      widget theme, matched to the app
```

Forkly is deliberately Node and Express, not RavenDB and not .NET. The audience should see somebody else's ordinary app, not the product wearing a costume.

[ARCHITECTURE.md](ARCHITECTURE.md) is the map: the four processes, how a question gets answered, and what crosses which trust boundary. [PLAN.md](PLAN.md) explains why the demo is shaped this way.

## Licence

MIT, see [LICENSE](LICENSE).
