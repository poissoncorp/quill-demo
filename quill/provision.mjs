// First half of the Quill setup: point it at Postgres, discover the schema,
// map it into a document model, provision, and wait for the initial ingest.
// The second half (model connection, agent, channel) is finish-setup.mjs.
//
// Idempotent: if the app slug already exists, provisioning is skipped. There
// is no endpoint to delete an app, so re-running blindly would leave a trail
// of half-configured apps that cannot be cleaned up.

import { buildMapping, describeMapping } from './build-mapping.mjs';

const BASE  = process.env.QUILL_BASE || 'http://quill:5000';
// Prefer the slug already recorded in .env, so a re-run recognises an app it
// provisioned earlier instead of creating a second one alongside it.
const SLUG  = process.env.QUILL_APP_SLUG_TARGET || process.env.QUILL_APP_SLUG || 'forkly-demo';
const NAME  = process.env.QUILL_APP_NAME || 'Forkly Demo';
const CONN  = process.env.QUILL_SOURCE_CONNECTION
           || 'Host=postgres;Port=5432;Database=zjadlo;Username=quill_cdc;Password=quill_cdc';

const apiKey = process.env.QUILL_API_KEY;
if (!apiKey) fail('QUILL_API_KEY is not set.');

function fail(msg) { console.error(`\n  ERROR: ${msg}\n`); process.exit(1); }
const step = (n, what) => console.log(`\n[${n}] ${what}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
    if (!res.ok) {
        const detail = json?.error || text.slice(0, 400) || '(empty body)';
        throw new Error(`${method} ${path} -> ${res.status}: ${detail}`);
    }
    return json;
}

// ---------------------------------------------------------------------------
step(0, 'Waiting for Quill to finish bootstrapping');

for (let i = 0; ; i++) {
    const s = await api('GET', '/api/bootstrap/status').catch(() => null);
    if (s?.state === 'Ready') { console.log('    ready'); break; }
    if (i > 120) fail(`still not ready after 10 minutes (last state: ${s?.state ?? 'unreachable'})`);
    if (i % 6 === 0) console.log(`    ${s?.state ?? 'unreachable'}...`);
    await sleep(5000);
}

// ---------------------------------------------------------------------------
const apps = await api('GET', '/api/apps').catch(() => []);
if (apps.some(a => a.slug === SLUG)) {
    console.log(`\n[=] App '${SLUG}' already exists, skipping provisioning.`);
    console.log('    Delete is not supported by the API, so this is left alone.');
    process.exit(0);
}

// ---------------------------------------------------------------------------
step(1, 'Testing the connection to Postgres');
// slug travels with every wizard call. The wizard keys its server-side state on
// it, and on a clean state the call is rejected without it.
const source = { provider: 'Npgsql', connectionString: CONN, slug: SLUG, appName: NAME };
const conn = await api('POST', '/api/setup/connect', source);
if (conn?.success === false) fail(`connect failed: ${JSON.stringify(conn.errors)}`);
console.log('    ok');

// ---------------------------------------------------------------------------
step(2, 'Discovering the schema');
const disc = await api('POST', '/api/setup/discover', source);
console.log(`    ${disc.tables.length} tables in ${disc.catalogName}`);

const noKey = disc.tables.filter(t => !t.primaryKeyColumns?.length).map(t => t.sourceTableName);
if (noKey.length) {
    fail(`no primary key reported for: ${noKey.join(', ')}\n` +
         '  This is almost always a permissions artefact rather than a real missing key:\n' +
         '  information_schema only exposes constraints to a user holding some privilege\n' +
         '  other than SELECT. Check that GRANT REFERENCES ran (see db/init/01-schema.sql).');
}

// ---------------------------------------------------------------------------
step(3, 'Mapping tables to collections');
const mapping = buildMapping(disc, { appName: NAME, slug: SLUG, connString: CONN });
console.log(describeMapping(mapping));

// setup/map has to run before setup/provision. The wizard keeps state server
// side, and provisioning without it reuses whatever the previous session left
// behind, which means CDC tasks against tables from somebody else's database.
await api('POST', '/api/setup/map', mapping);
console.log('    mapping accepted');

// ---------------------------------------------------------------------------
step(4, 'Provisioning');
await api('POST', '/api/setup/provision', mapping);
console.log(`    app '${SLUG}' created`);

// ---------------------------------------------------------------------------
step(5, 'Waiting for the initial ingest');

let last = -1, stableFor = 0;
for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const cols = await api('GET', `/api/apps/${SLUG}/collections`).catch(() => null);
    if (!cols) continue;
    const total = cols.reduce((s, c) => s + (c.documentsCount || 0), 0);
    if (total > 0 && total === last) {
        // Two identical readings in a row means the snapshot has landed.
        if (++stableFor >= 2) {
            console.log(`    ${total} documents in ${cols.length} collections`);
            break;
        }
    } else {
        stableFor = 0;
        if (total !== last) console.log(`    ${total} documents...`);
    }
    last = total;
}

console.log(`\nDone. Next: quill/finish-setup.mjs creates the model connection, agent and channel.`);
