'use strict';

// Forkly: the operations console of a food delivery marketplace, on Postgres.
// Nothing above the "Quill attachment" section at the bottom of this file
// knows that Quill exists.

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const app = express();
app.use(express.json());

// The pilot deck runs on a different port, so its calls to /api/quill/* are
// cross-origin. Allow only that origin, and only on those paths.
const PILOT_ORIGINS = (process.env.PILOT_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080').split(',');
app.use(['/api/quill', '/api/summary'], (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && PILOT_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

function wrap(handler) {
    return async (req, res) => {
        try {
            res.json(await handler(req));
        } catch (err) {
            console.error(`[${req.method} ${req.path}]`, err.message);
            res.status(500).json({ error: err.message });
        }
    };
}

// -----------------------------------------------------------------------------
// The app's own API: totals, orders, restaurants, couriers, reviews.
// -----------------------------------------------------------------------------

app.get('/api/summary', wrap(async () => {
    const [row] = await q(`
        SELECT
            (SELECT COUNT(*) FROM orders)                                     AS orders_total,
            (SELECT COUNT(*) FROM orders WHERE placed_at >= CURRENT_DATE - 7) AS orders_week,
            (SELECT COUNT(*) FROM restaurants)                                AS restaurants,
            (SELECT COUNT(*) FROM couriers WHERE active)                      AS couriers,
            (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews)              AS avg_rating,
            (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60)::numeric, 1)
               FROM orders o JOIN deliveries d ON d.order_id = o.order_id)    AS avg_delivery_min,
            (SELECT ROUND(SUM(subtotal)::numeric, 0) FROM orders WHERE status = 'delivered') AS gmv
    `);
    return row;
}));

app.get('/api/orders', wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    return q(`
        SELECT o.order_id, o.placed_at, o.status, o.subtotal,
               r.name AS restaurant, z.name AS zone,
               c.full_name AS courier,
               ROUND(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60) AS total_min,
               rv.rating
        FROM orders o
        JOIN restaurants r      ON r.restaurant_id = o.restaurant_id
        JOIN zones z            ON z.zone_id = o.zone_id
        LEFT JOIN deliveries d  ON d.order_id = o.order_id
        LEFT JOIN couriers c    ON c.courier_id = d.courier_id
        LEFT JOIN reviews rv    ON rv.order_id = o.order_id
        ORDER BY o.placed_at DESC
        LIMIT $1
    `, [limit]);
}));

app.get('/api/restaurants', wrap(async () => q(`
    SELECT r.name, r.cuisine, z.name AS zone, r.promised_prep_min,
           COUNT(o.order_id) AS orders,
           ROUND(AVG(EXTRACT(EPOCH FROM (d.picked_up_at - o.placed_at))/60)::numeric, 1) AS actual_prep_min,
           ROUND(AVG(rv.rating)::numeric, 2) AS rating
    FROM restaurants r
    JOIN zones z            ON z.zone_id = r.zone_id
    LEFT JOIN orders o      ON o.restaurant_id = r.restaurant_id
    LEFT JOIN deliveries d  ON d.order_id = o.order_id
    LEFT JOIN reviews rv    ON rv.order_id = o.order_id
    GROUP BY r.name, r.cuisine, z.name, r.promised_prep_min
    ORDER BY orders DESC
`)));

app.get('/api/couriers', wrap(async () => q(`
    SELECT c.full_name, c.vehicle, z.name AS zone,
           COUNT(d.delivery_id) AS deliveries,
           ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.picked_up_at))/60)::numeric, 1) AS avg_ride_min,
           ROUND(AVG(rv.rating)::numeric, 2) AS rating
    FROM couriers c
    JOIN zones z            ON z.zone_id = c.home_zone_id
    LEFT JOIN deliveries d  ON d.courier_id = c.courier_id
    LEFT JOIN reviews rv    ON rv.order_id = d.order_id
    GROUP BY c.full_name, c.vehicle, z.name
    HAVING COUNT(d.delivery_id) > 0
    ORDER BY deliveries DESC
    LIMIT 30
`)));

app.get('/api/reviews', wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    return q(`
        SELECT rv.rating, rv.comment, rv.created_at,
               r.name AS restaurant, z.name AS zone
        FROM reviews rv
        JOIN orders o      ON o.order_id = rv.order_id
        JOIN restaurants r ON r.restaurant_id = o.restaurant_id
        JOIN zones z       ON z.zone_id = o.zone_id
        ORDER BY rv.created_at DESC
        LIMIT $1
    `, [limit]);
}));

// -----------------------------------------------------------------------------
// Quill attachment.
//
// The only part of the app that knows Quill exists at all. The API key never
// leaves the server; the browser only ever receives a ready-made url.
// -----------------------------------------------------------------------------

// Only the API key has to be supplied. Everything else is discovered from the
// running Quill instance, which is what keeps the setup free of a
// write-the-env-then-restart cycle: provisioning can happen after this process
// started and the app still picks it up on the next poll.
const quill = {
    apiKey:   process.env.QUILL_API_KEY   || '',
    domain:   process.env.QUILL_DOMAIN    || '',   // optional override
    slug:     process.env.QUILL_APP_SLUG  || '',
    widgetId: process.env.QUILL_WIDGET_ID || '',
    agentId:  process.env.QUILL_AGENT_ID  || '',
};

const QUILL_HOST = process.env.QUILL_HOST || 'quill';

// Quill's management API is reached over plain HTTP on the compose network.
// Its public HTTPS name is for browsers; from inside, the container port is
// both simpler and free of the certificate problem, because Quill serves only
// the leaf certificate and Node cannot build a chain from that.
const QUILL_API = process.env.QUILL_API_BASE || `http://${QUILL_HOST}:5000`;

async function quillApi(method, path, body) {
    const res = await fetch(`${QUILL_API}${path}`, {
        method,
        headers: {
            'X-Api-Key': quill.apiKey,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
    return { status: res.status, json, raw };
}

let attached = null;   // { url, pilotUrl, mintedAt, ttlSeconds, maxInvocations }

// Quill's domain is the name on the certificate it serves on 443, as
// CN=*.<domain>. Reading it there means the operator does not have to supply
// something the instance already knows. Verification is deliberately off: this
// reads a name, it trusts nothing. The domain is only used to build the
// dashboard link, since embed URLs come back fully formed from Quill.
async function discoverDomain() {
    if (quill.domain) return quill.domain;
    const tls = require('tls');
    quill.domain = await new Promise((resolve) => {
        const socket = tls.connect(
            { host: QUILL_HOST, port: 443, rejectUnauthorized: false, servername: 'discover' },
            () => {
                const cn = socket.getPeerCertificate()?.subject?.CN || '';
                socket.end();
                resolve(cn.startsWith('*.') ? cn.slice(2) : '');
            });
        socket.setTimeout(5000, () => { socket.destroy(); resolve(''); });
        socket.on('error', () => resolve(''));
    });
    return quill.domain;
}

// The app slug, widget and agent come from Quill itself rather than from the
// environment, so a provisioning run that happens while this process is
// already up is picked up without a restart.
async function discoverApp() {
    if (!quill.domain || !quill.apiKey) return;
    if (quill.slug && quill.widgetId && quill.agentId) return;

    const get = (p) => quillApi('GET', p)
        .then(r => (r.status === 200 ? r.json : null))
        .catch(() => null);

    // The widget id has appeared under both names on this API, so accept either.
    const widgetIdOf = (c) => c?.channelId || c?.widgetId || '';
    const channelOf = async (slug) => {
        const channels = await get(`/api/apps/${encodeURIComponent(slug)}/channels`);
        return channels?.find(c => c.enabled && widgetIdOf(c)) || null;
    };

    if (quill.slug) {
        const live = await channelOf(quill.slug);
        if (live) {
            quill.widgetId = quill.widgetId || widgetIdOf(live);
            quill.agentId  = quill.agentId  || live.agentId;
        }
        return;
    }

    // No slug configured, so pick the app that is actually usable: the one with
    // an enabled widget channel. An instance can carry several apps, and Quill
    // has no delete, so "the newest" would be a coin flip.
    const apps = await get('/api/apps');
    if (!apps?.length) return;

    for (const a of apps) {
        const live = await channelOf(a.slug);
        if (live) {
            quill.slug = a.slug;
            quill.widgetId = quill.widgetId || widgetIdOf(live);
            quill.agentId  = quill.agentId  || live.agentId;
            return;
        }
    }
}

let discovering = null;
function refreshDiscovery() {
    if (discovering) return discovering;
    discovering = (async () => {
        await discoverDomain();
        await discoverApp();
    })().finally(() => { discovering = null; });
    return discovering;
}

function missingConfig() {
    return Object.entries({
        QUILL_API_KEY: quill.apiKey,
        QUILL_DOMAIN: quill.domain,
        QUILL_APP_SLUG: quill.slug,
        QUILL_WIDGET_ID: quill.widgetId,
        QUILL_AGENT_ID: quill.agentId,
    }).filter(([, v]) => !v).map(([k]) => k);
}

// A real connectivity check: asks Quill's API for the list of apps. The pilot
// renders this as a green light, so it has to be an actual call rather than
// an assumption.
app.get('/api/quill/health', async (req, res) => {
    if (!quill.domain || !quill.apiKey) {
        return res.json({ ok: false, reason: 'QUILL_DOMAIN or QUILL_API_KEY missing' });
    }
    const startedAt = Date.now();
    try {
        const r = await quillApi('GET', '/api/apps');
        if (r.status !== 200) return res.json({ ok: false, reason: `HTTP ${r.status}`, tookMs: Date.now() - startedAt });
        const apps = r.json;
        const mine = apps.find(a => a.slug === quill.slug);
        res.json({
            ok: true,
            tookMs: Date.now() - startedAt,
            appCount: apps.length,
            app: mine ? { slug: mine.slug, name: mine.name, createdAt: mine.createdAt } : null,
        });
    } catch (err) {
        res.json({ ok: false, reason: err.message, tookMs: Date.now() - startedAt });
    }
});

// How many documents Quill already holds. This is the number that lands on
// stage: "that many of your rows are already in there".
app.get('/api/quill/collections', async (req, res) => {
    if (!quill.domain || !quill.apiKey || !quill.slug) {
        return res.json({ ok: false, collections: [] });
    }
    try {
        const r = await quillApi('GET', `/api/apps/${encodeURIComponent(quill.slug)}/collections`);
        if (r.status !== 200) return res.json({ ok: false, collections: [] });
        const all = r.json;

        // Quill keeps its own bookkeeping collections (channels, embed links,
        // conversations) in the same database. On a "mirrored" counter they
        // would be misleading, since they are not customer data, so only the
        // collections that came from the mapping are counted.
        const INTERNAL = new Set(['Channels', 'ChannelBindings', 'EmbedLinks', 'Chats',
                                  'Conversations', 'IFrameStyleDefaults']);
        const collections = all.filter(c => !INTERNAL.has(c.name) && !c.name.startsWith('@'));

        res.json({
            ok: true,
            collections,
            total: collections.reduce((s, c) => s + (c.documentsCount || 0), 0),
        });
    } catch {
        res.json({ ok: false, collections: [] });
    }
});

app.get('/api/quill/status', async (req, res) => {
    // Re-check on every poll while anything is still missing. That is how a
    // provisioning run finishing after this process started gets noticed
    // without restarting the container.
    if (missingConfig().length) await refreshDiscovery().catch(() => {});
    res.json({
        configured: missingConfig().length === 0,
        missing: missingConfig(),
        attached: Boolean(attached),
        embedUrl: attached ? attached.url : null,
        pilotUrl: attached ? attached.pilotUrl : null,
        mintedAt: attached ? attached.mintedAt : null,
        domain: quill.domain || null,
        slug: quill.slug || null,
        dashboardUrl: quill.domain ? `https://dashboard.${quill.domain}/` : null,
    });
});

// Mints one embed link against Quill's API.
async function mintLink(body) {
    const path = `/api/apps/${encodeURIComponent(quill.slug)}/embed-links`;
    const endpoint = `https://api.${quill.domain}${path}`;
    const resp = await quillApi('POST', path, body);
    const parsed = resp.json;
    if (resp.status < 200 || resp.status >= 300) {
        const err = new Error(`Quill responded ${resp.status}`);
        err.detail = { endpoint, request: body, response: parsed ?? resp.raw.slice(0, 500) };
        throw err;
    }
    // Quill builds the embed URL from the Host of the request that minted it,
    // and we mint over the internal container address, so what comes back is
    // http://quill:5000/... which no browser can use. Swap the origin for the
    // public one and keep the path exactly as Quill produced it, because the
    // shape of that path has changed between builds.
    const raw = parsed?.url || parsed?.embedUrl;
    const url = raw && quill.domain
        ? raw.replace(/^https?:\/\/[^/]+/, `https://public.${quill.domain}`)
        : raw;
    if (!url) {
        const err = new Error('No url in the response');
        err.detail = { endpoint, request: body, response: parsed ?? text.slice(0, 500) };
        throw err;
    }
    return { url, endpoint, request: body, response: parsed };
}

// Mints two links in one call: one is stored and drives the bubble inside the
// app, one is returned to the pilot deck, which embeds it directly. Same agent,
// two independent short-lived links.
app.post('/api/quill/attach', async (req, res) => {
    const missing = missingConfig();
    if (missing.length) {
        return res.status(503).json({
            error: 'Quill is not configured',
            missing,
            hint: 'Fill in .env and restart the app container.',
        });
    }

    // agentId is required here even though the guide does not list it.
    //
    // The channel identifier is sent under both names on purpose. Builds of
    // Quill disagree about whether this field is called channelId or widgetId,
    // and the one that is not recognised is ignored, so sending both works
    // against either. Without the right one the call fails with a 400 naming
    // the field it wanted.
    const base = {
        channelId: quill.widgetId,
        widgetId: quill.widgetId,
        agentId: quill.agentId,
        ttlSeconds: Number(req.body?.ttlSeconds) || 3600,
        maxInvocations: Number(req.body?.maxInvocations) || 100,
    };

    const startedAt = Date.now();
    try {
        const [inApp, inPilot] = await Promise.all([mintLink(base), mintLink(base)]);
        attached = {
            url: inApp.url,
            pilotUrl: inPilot.url,
            mintedAt: new Date().toISOString(),
            ...base,
        };
        res.json({
            ok: true,
            url: inApp.url,
            pilotUrl: inPilot.url,
            tookMs: Date.now() - startedAt,
            endpoint: inApp.endpoint,
            request: base,
            // Shown raw by the pilot, so the audience can see it happening live.
            response: inApp.response,
        });
    } catch (err) {
        res.status(502).json({ error: err.message, ...(err.detail || {}) });
    }
});

app.post('/api/quill/detach', (req, res) => {
    attached = null;
    res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
    console.log(`Forkly listening on :${PORT}`);
    await refreshDiscovery().catch(() => {});
    const missing = missingConfig();
    console.log(missing.length
        ? `Quill not attachable yet, missing: ${missing.join(', ')}`
        : `Quill ready to attach (domain=${quill.domain}, app=${quill.slug}, widget=${quill.widgetId})`);
});
