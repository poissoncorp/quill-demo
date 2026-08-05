// Finishes the Quill configuration over the Forkly database: model connection,
// agent, web widget channel. Everything before this (source, mapping, ingest)
// is already done by the provisioning step.
//
// Run from the quill-demo directory:
//   docker run --rm --network quill-demo_default \
//     -v "$PWD:/w" -w /w --env-file .env \
//     -e QUILL_MODEL=gpt-5.3-chat-latest -e QUILL_CONNECTION_NAME=demo-gpt53 \
//     node:20-alpine node quill/finish-setup.mjs
//
// AGENT_ONLY=1 stops after the agent, so the prompt and tools can be iterated
// without creating another channel and invalidating the widget id.
//
// On success it writes QUILL_APP_SLUG, QUILL_WIDGET_ID and QUILL_AGENT_ID
// back into .env. Then `docker compose up -d app` and the pilot button works.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE     = process.env.QUILL_BASE  || 'http://quill:5000';
const ENV_PATH = process.env.ENV_PATH    || '.env';
const SLUG     = process.env.QUILL_APP_SLUG_TARGET || process.env.QUILL_APP_SLUG || 'forkly-demo';
const MODEL    = process.env.QUILL_MODEL || 'gpt-5.3-chat-latest';

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------
const env = {};
if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2];
    }
}
const apiKey    = process.env.QUILL_API_KEY || env.QUILL_API_KEY;
const openAiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;

function fail(msg) { console.error(`\n  FAILED: ${msg}\n`); process.exit(1); }

if (!apiKey)    fail('QUILL_API_KEY missing (in .env or the environment).');
if (!openAiKey) fail('OPENAI_API_KEY missing. Put it in .env or pass -e OPENAI_API_KEY=...');

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep as text */ }
    if (!res.ok) {
        const detail = json?.error || json?.errors?.join('; ') || text.slice(0, 400) || '(empty body)';
        throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
    }
    return json;
}

const step = (n, what) => console.log(`\n[${n}] ${what}`);

// Model connections moved between builds, in both path and scope:
//
//   older: list and create at /apps/<slug>/ai/connection-strings, per app,
//          response shaped { items: [...] }
//   newer: list at /apps/<slug>/connection-strings, create at the instance
//          level under /ai/connection-strings, response a bare array
//
// Probe both and normalise, so this script works against either.
async function probe(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    return res ? res.status : 0;
}

async function listConnections() {
    for (const path of [`/api/apps/${SLUG}/connection-strings`,
                        `/api/apps/${SLUG}/ai/connection-strings`]) {
        const r = await api('GET', path).catch(() => null);
        if (r) return Array.isArray(r) ? r : (r.items ?? []);
    }
    return [];
}

let createPath = null;
async function connectionCreatePath() {
    if (createPath) return createPath;
    for (const candidate of ['/api/ai/connection-strings',
                             `/api/apps/${SLUG}/ai/connection-strings`]) {
        if (await probe('POST', candidate, {}) !== 404) { createPath = candidate; return createPath; }
    }
    fail('no endpoint on this Quill build accepts a model connection.');
}

// ---------------------------------------------------------------------------
// 1. Model connection
// ---------------------------------------------------------------------------
step(1, 'Model connection');

// QUILL_CONNECTION_NAME pins a specific connection, which is how you switch
// models: create a second connection and point the agent at it.
const WANTED = process.env.QUILL_CONNECTION_NAME || '';
// Newer builds call it `identifier`, older ones `name`.
const nameOf = (c) => c?.identifier || c?.name || '';
const existing = await listConnections();
let connectionName = WANTED
    ? existing.map(nameOf).find(n => n === WANTED)
    : nameOf(existing[0]);

if (connectionName) {
    console.log(`    reusing existing connection: ${connectionName}`);
} else {
    connectionName = WANTED || 'demo-llm';
    // Provider settings are nested under openAiSettings, not flattened onto
    // the request. A flat payload is rejected.
    await api('POST', await connectionCreatePath(), {
        name: connectionName,
        identifier: connectionName,
        modelType: 'Chat',
        openAiSettings: {
            apiKey: openAiKey,
            model: MODEL,
            // The endpoint has to be spelled out; an empty string is not
            // treated as "use the default".
            endpoint: process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1',
            organizationId: '',
            projectId: '',
            dimensions: null,
            embeddingsMaxConcurrentBatches: null,
            enablePromptCache: true,
            isSetTemperature: false,
            temperature: null,
        },
    });
    console.log(`    created: ${connectionName} (${MODEL})`);
}

// ---------------------------------------------------------------------------
// 2. Agent
//
// The query tools are defined explicitly below rather than generated, so the
// RQL is reviewable and version controlled alongside the schema it reads.
// ---------------------------------------------------------------------------
step(2, 'Agent');

// Every tool needs a parameter schema. Without one the model has no way to
// pass arguments, so a parameterised tool is simply never called.
function schemaFrom(sample) {
    const properties = {};
    for (const [k, v] of Object.entries(sample)) {
        properties[k] = typeof v === 'number'
            ? { type: Number.isInteger(v) ? 'integer' : 'number' }
            : { type: 'string', ...(/^\d{4}-\d{2}-\d{2}T/.test(v) ? { format: 'date-time' } : {}) };
    }
    return JSON.stringify({
        type: 'object',
        properties,
        required: Object.keys(sample),
        additionalProperties: false,
    });
}

const tool = (name, description, query, sample, opts = {}) => ({
    name,
    description,
    query,
    parametersSampleObject: JSON.stringify(sample),
    parametersSchema: schemaFrom(sample),
    // Lookups are seeded into the initial context and stay queryable on demand,
    // so the model can fetch a name it did not get up front.
    allowModelQueries: 'True',
    addToInitialContext: opts.initial ? 'True' : 'False',
    isExpanded: false,
});

// A JS projection rather than a list of dotted field names.
//
// When a query filters on a nested field, a dotted projection such as
// "Review.Rating as Rating" is served from the auto-index and returns null for
// anything the index does not carry. A select { } projection always loads the
// document, so the nested values come back intact.
const PROJ_ORDER = [
    'select {',
    '    OrderId: o.OrderId,',
    '    RestaurantId: o.RestaurantId,',
    '    ZoneId: o.ZoneId,',
    '    PlacedAt: o.PlacedAt,',
    '    Status: o.Status,',
    '    Subtotal: o.Subtotal,',
    '    CourierId:   o.Delivery ? o.Delivery.CourierId   : null,',
    '    PickedUpAt:  o.Delivery ? o.Delivery.PickedUpAt  : null,',
    '    DeliveredAt: o.Delivery ? o.Delivery.DeliveredAt : null,',
    '    Rating:      o.Review   ? o.Review.Rating        : null,',
    '    Comment:     o.Review   ? o.Review.Comment       : null,',
    '    ItemIds:     o.Items ? o.Items.map(function(i) { return i.MenuItemId; }) : []',
    '}',
].join('\n');

const queryTools = [
    tool('zones', 'Every delivery zone: ZoneId and name. Use it to turn a zone name into a ZoneId.',
        'from Zones\nlimit 100', {}, { initial: true }),

    tool('restaurants',
        'Every restaurant: RestaurantId, name, cuisine, ZoneId and PromisedPrepMin, the prep time promised to the customer in minutes.',
        'from Restaurants\nselect RestaurantId, Name, Cuisine, ZoneId, PromisedPrepMin, CommissionRate\nlimit 500',
        {}, { initial: true }),

    tool('couriers', 'Every courier: CourierId, full name, vehicle, home zone.',
        'from Couriers\nselect CourierId, FullName, Vehicle, HomeZoneId\nlimit 500', {}, { initial: true }),

    tool('menuMargins',
        'The full menu of EVERY restaurant at once: price (Price), ingredient cost (FoodCost) and prep time (PrepMin) of each item. Use this to compare margins across dishes. Margin is (Price - FoodCost) / Price.',
        'from Restaurants\nselect Name, RestaurantId, Menu\nlimit 500', {}, { initial: true }),

    tool('ordersInWindow',
        'Orders in one zone within a time window, with delivery timestamps and the review. Use narrow windows, one day at a time. To compare weekdays, call this once per specific date.',
        'from Orders as o\nwhere o.ZoneId = $zoneId and o.PlacedAt >= $from and o.PlacedAt < $to\n' + PROJ_ORDER + '\nlimit 400',
        { zoneId: 2, from: '2026-07-24T00:00:00.0000000Z', to: '2026-07-25T00:00:00.0000000Z' }),

    tool('ordersByRestaurantInWindow',
        'Orders from one restaurant within a time window. The gap between PlacedAt and PickedUpAt is the time the order spent in the kitchen.',
        'from Orders as o\nwhere o.RestaurantId = $restaurantId and o.PlacedAt >= $from and o.PlacedAt < $to\n' + PROJ_ORDER + '\nlimit 400',
        { restaurantId: 6, from: '2026-07-24T00:00:00.0000000Z', to: '2026-07-25T00:00:00.0000000Z' }),

    tool('shiftsInWindow',
        'Courier shifts in one zone within a time window. The row count is the staffing level of that zone for that period.',
        'from Shifts\nwhere ZoneId = $zoneId and ShiftDate >= $from and ShiftDate < $to\nselect ShiftId, CourierId, ZoneId, ShiftDate\nlimit 500',
        { zoneId: 2, from: '2026-07-24T00:00:00.0000000Z', to: '2026-07-25T00:00:00.0000000Z' }),

    tool('lowRatedReviews',
        'Poorly rated orders together with the review text, including the CourierId and RestaurantId behind each one. The best starting point for finding who or what is causing complaints.',
        'from Orders as o\nwhere o.Review.Rating <= $maxRating and o.PlacedAt >= $from\n' + PROJ_ORDER + '\nlimit 150',
        { maxRating: 2, from: '2026-07-01T00:00:00.0000000Z' }),

    tool('ordersByCourier',
        'Orders handled by one courier, with timings and reviews. The gap between PickedUpAt and DeliveredAt is the ride itself.',
        'from Orders as o\nwhere o.Delivery.CourierId = $courierId\n' + PROJ_ORDER + '\nlimit 250',
        { courierId: 55 }),

    tool('courierById',
        'One courier by CourierId: full name, vehicle, home zone. Use this to turn a CourierId into a name instead of saying the courier is not in the lookup.',
        'from Couriers as c\nwhere c.CourierId = $courierId\nselect CourierId, FullName, Vehicle, HomeZoneId',
        { courierId: 55 }),

    tool('restaurantById',
        'One restaurant by RestaurantId, including its full menu (Price, FoodCost, PrepMin per item).',
        'from Restaurants as r\nwhere r.RestaurantId = $restaurantId\nselect Name, RestaurantId, ZoneId, PromisedPrepMin, Menu',
        { restaurantId: 1 }),
];

// The model cannot reliably tell which calendar date was a Friday, and it
// guesses. One run it picked the right Fridays, the next it picked Saturdays
// and concluded there was no problem. So the calendar is handed to it
// explicitly, generated from the same clock the seed used.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byDow = {};
{
    const now = new Date();
    for (let i = 1; i <= 60; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        (byDow[DAY_NAMES[d.getUTCDay()]] ??= []).push(d.toISOString().slice(0, 10));
    }
}
const TODAY = new Date().toISOString().slice(0, 10);
const CALENDAR = DAY_NAMES.map(d => `- ${d}s: ${(byDow[d] || []).slice(0, 6).join(', ')}`);

const SYSTEM_PROMPT = [
    'You are the operations assistant for Forkly, a food delivery marketplace.',
    'You answer questions that cut across delivery times, city zones, weekdays,',
    'restaurant prep times, courier staffing, dish margins and the TEXT of',
    'customer reviews.',
    '',
    'Data model:',
    '- Orders are the centre. Each order embeds Items, a Delivery and a Review.',
    '- Derive durations yourself from the timestamps: PlacedAt -> PickedUpAt is',
    '  kitchen time, PickedUpAt -> DeliveredAt is the ride, PlacedAt -> DeliveredAt',
    '  is the total the customer experiences.',
    '- Restaurants embed a Menu with Price, FoodCost and PrepMin per item.',
    '- Relationships are by id: ZoneId, RestaurantId, CourierId, CustomerId.',
    '',
    'Date format:',
    '- Timestamps look like 2026-07-24T00:00:00.0000000Z, with seven decimal',
    '  places and a trailing Z. Always pass dates in exactly that format.',
    '  A shorter form such as 2026-07-24T00:00:00Z silently matches nothing,',
    '  because the comparison is textual.',
    `- The data covers the last 60 days. Today is ${TODAY}.`,
    '',
    'Calendar. Do NOT work out weekdays yourself, use this table. Picking the',
    'wrong date is the single easiest way to reach a wrong conclusion here.',
    ...CALENDAR,
    '',
    'Result limits, this is critical:',
    '- Every tool returns at most about 30 rows. On a wider query the result is',
    '  truncated and some fields, Rating and Comment among them, come back empty.',
    '  That makes it very easy to wrongly conclude "there are no ratings",',
    '  when in fact there are.',
    '- So NEVER ask for a wide window. Use single-day windows and call the tool',
    '  several times, one day per call, then combine the results yourself.',
    '- If a call returns roughly 30 rows, assume it was truncated and repeat it',
    '  on a narrower window instead of drawing conclusions from it.',
    '',
    'Numbers:',
    '- EVERY number in your answer must be computed from rows a tool returned.',
    '  Never estimate or round "about right". Average the actual records.',
    '- When you compare, give both values and the gap, e.g.',
    '  "62 minutes against 39 minutes on other days".',
    '- For kitchen time, compare against that restaurant\'s PromisedPrepMin,',
    '  not against a global average.',
    '- State how many records and which dates your analysis covered.',
    '- When you quote a review, quote it word for word from the Comment field.',
    '  Never paraphrase inside quotation marks. If you are summarising rather',
    '  than quoting, drop the quotation marks and say you are summarising.',
    '',
    'Names, not identifiers:',
    '- Never invent an identifier or a name. Every RestaurantId, CourierId or',
    '  ZoneId you mention must come from a row a tool returned in this',
    '  conversation.',
    '- Always resolve ids to names: zones via zones, restaurants via restaurants,',
    '  couriers via couriers or courierById. Write "Mark Wolfe", not "courier 55".',
    '  If you do not know the name yet, go and fetch it.',
    '',
    'Business glossary:',
    '- "losing money on a dish" does not mean a negative margin. It means a margin',
    '  clearly below the rest of the menu, especially when the dish sells well or',
    '  ties up the kitchen. Do not answer that there is no problem merely because',
    '  every margin is positive.',
    '- "falling apart" means clearly worse than usual, not a total outage.',
    '',
    'Be self-sufficient, this matters:',
    '- NEVER ask the user for data or to narrow the scope. You have tools, use',
    '  them. A sentence like "please tell me which zone" is a wrong answer.',
    '- Questions are open ended by design. Choose a sensible scope yourself,',
    '  for example all couriers or the last 60 days, do the analysis, and say',
    '  which scope you picked.',
    '- It is FORBIDDEN to end an answer with "I would need to fetch",',
    '  "one would have to check" or "I do not have the data yet". If you know',
    '  what is missing, go and fetch it and finish the analysis. You may call',
    '  tools as many times as you need. The user wants a result, not a plan.',
    '- To judge a dish: take the margin from menuMargins, then pull that',
    '  restaurant\'s orders for several DIFFERENT single days (say 6-8 days spread',
    '  across the last 60), keep the ones with that MenuItemId in ItemIds, and',
    '  compute the ratings from those.',
    '- To judge a courier: use ordersByCourier for the timings and courierById',
    '  for the name.',
    '- When hunting for a problem courier, restaurant or zone, do NOT walk the',
    '  list checking each one. Start from the symptom: call lowRatedReviews,',
    '  group the results by CourierId or RestaurantId, and see who recurs.',
    '  Only then pull the details for that one. Go from bad outcomes to the',
    '  cause, never from a list of entities to a linear scan.',
    '',
    'Answer in English, concisely, with concrete numbers. Do not guess.',
    'If the data genuinely does not show something, say so plainly.',
].join('\n');

const agentPayload = {
    name: 'Forkly Operations Assistant',
    identifier: 'forkly-ops',
    systemPrompt: SYSTEM_PROMPT,
    connectionStringName: connectionName,
    sampleObject: JSON.stringify({ reply: '' }),
    outputSchema: '',
    parameters: [],
    // The field is called "queries", not "queryTools". With the wrong name the
    // API accepts the agent with HTTP 200 and quietly stores it WITHOUT any
    // tools. The symptom is misleading: the agent still answers, it just makes
    // up numbers and identifiers, and in the worst case asks the user to supply
    // the data. Nothing in the API signals that the tools went missing.
    queries: queryTools,
};

const created = await api('POST', `/api/apps/${SLUG}/setup/agent`, agentPayload);
const agentId = created?.agentId ?? agentPayload.identifier;
console.log(`    agent: ${agentId}`);
console.log(`    tools (${queryTools.length}): ${queryTools.map(t => t.name).join(', ')}`);

// AGENT_ONLY=1 stops here. setup/agent is an upsert, so the prompt and tools
// can be iterated without creating another channel and a new widget id.
if (process.env.AGENT_ONLY === '1') {
    console.log('\nAGENT_ONLY=1, skipping the channel. The existing widget keeps working.\n');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Channel
// ---------------------------------------------------------------------------
step(3, 'Web widget channel');

const channel = await api('POST', `/api/apps/${SLUG}/setup/channel`, {
    type: 'IFrame',
    displayName: 'forkly-widget',
    agentId,
    enabled: true,
    // Required. An empty array means the embed page can be framed from
    // anywhere, which is what we want: the same widget is embedded both in
    // the app on :3000 and in the pilot deck on :8080.
    allowedOrigins: [],
});
const widgetId = channel?.channelId ?? channel?.widgetId ?? channel?.id;
if (!widgetId) fail('setup/channel returned no widgetId:\n' + JSON.stringify(channel).slice(0, 400));
console.log(`    widgetId: ${widgetId}`);

// ---------------------------------------------------------------------------
// 4. Write back to .env
// ---------------------------------------------------------------------------
step(4, 'Writing to .env');

env.QUILL_APP_SLUG  = SLUG;
env.QUILL_WIDGET_ID = widgetId;
env.QUILL_AGENT_ID  = agentId;

const order = ['QUILL_LICENSE_KEY', 'QUILL_API_KEY', 'QUILL_DOMAIN', 'OPENAI_API_KEY',
               'QUILL_APP_SLUG', 'QUILL_WIDGET_ID', 'QUILL_AGENT_ID'];
const lines = order.filter(k => env[k] !== undefined).map(k => `${k}=${env[k]}`);
for (const [k, v] of Object.entries(env)) if (!order.includes(k)) lines.push(`${k}=${v}`);
writeFileSync(ENV_PATH, lines.join('\n') + '\n');

console.log(`    wrote QUILL_APP_SLUG=${SLUG}, QUILL_AGENT_ID=${agentId} and QUILL_WIDGET_ID`);
console.log('\nDone. Now run:  docker compose up -d app');
console.log('Then open the pilot at http://localhost:8080 and hit "Enable Quill".\n');
