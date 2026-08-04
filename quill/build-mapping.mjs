// Builds the mapping payload for POST /api/setup/map from the output of
// /api/setup/discover.
//
// The document model is deliberately not flat:
//   Orders       <- items, delivery and review live INSIDE the order,
//                   while customer, restaurant and zone are linked
//   Restaurants  <- the menu lives inside the restaurant
//
// That is what lets "why do Friday deliveries fall apart in Riverside" be
// served from a single collection instead of a six-way join.
//
// Written in Node rather than PowerShell for one specific reason:
// ConvertTo-Json collapses a single-element array into a string, and Quill's
// DTO expects string[]. The result is HTTP 400 with an empty body, a binding
// error with no hint whatsoever. In JS a one-element array stays an array.

import { readFileSync, writeFileSync } from 'node:fs';

// Usable two ways: imported as buildMapping() by provision.mjs, or run from
// the command line against a saved discover response.
export function buildMapping(disc, { appName, slug, connString }) {
const byName = new Map(disc.tables.map(t => [t.sourceTableName, t]));

const pascal = (s) => s.split('_').filter(Boolean)
    .map(p => p[0].toUpperCase() + p.slice(1)).join('');

function table(name) {
    const t = byName.get(name);
    if (!t) throw new Error(`Table '${name}' not found in discover.json`);
    return t;
}

const columns = (name) => table(name).columns
    .map(c => ({ column: c.name, name: pascal(c.name), type: 'Default' }));

const pk = (name) => [...table(name).primaryKeyColumns];

const embedded = (name, propertyName, type, joinColumns) => ({
    sourceTableSchema: 'public',
    sourceTableName: name,
    propertyName,
    columns: columns(name),
    primaryKeyColumns: pk(name),
    joinColumns,
    type,                       // Array | Value | Map
    patch: null,
    onDelete: null,
    linkedTables: [],
});

const linked = (name, propertyName, joinColumns, linkedCollectionName) => ({
    sourceTableSchema: 'public',
    sourceTableName: name,
    propertyName,
    joinColumns,
    linkedCollectionName,
});

const root = (name, collectionName, embeddedTables = [], linkedTables = []) => ({
    sourceTableSchema: 'public',
    sourceTableName: name,
    collectionName,
    columns: columns(name),
    primaryKeyColumns: pk(name),
    patch: null,
    onDelete: null,
    disabled: false,
    embeddedTables,
    linkedTables,
});

const tables = [
    root('zones', 'Zones'),

    root('customers', 'Customers', [], [
        linked('zones', 'Zone', ['zone_id'], 'Zones'),
    ]),

    root('couriers', 'Couriers', [], [
        linked('zones', 'HomeZone', ['home_zone_id'], 'Zones'),
    ]),

    root('shifts', 'Shifts', [], [
        linked('couriers', 'Courier', ['courier_id'], 'Couriers'),
        linked('zones', 'Zone', ['zone_id'], 'Zones'),
    ]),

    // The menu is part of the restaurant, not a separate entity.
    root('restaurants', 'Restaurants', [
        embedded('menu_items', 'Menu', 'Array', ['restaurant_id']),
    ], [
        linked('zones', 'Zone', ['zone_id'], 'Zones'),
    ]),

    // The heart of the model: everything describing the life of one order
    // lands in a single document.
    root('orders', 'Orders', [
        embedded('order_items', 'Items', 'Array', ['order_id']),
        embedded('deliveries', 'Delivery', 'Value', ['order_id']),
        embedded('reviews', 'Review', 'Value', ['order_id']),
    ], [
        linked('customers', 'Customer', ['customer_id'], 'Customers'),
        linked('restaurants', 'Restaurant', ['restaurant_id'], 'Restaurants'),
        linked('zones', 'Zone', ['zone_id'], 'Zones'),
    ]),
];

return { appName, slug, provider: 'Npgsql', connectionString: connString, tables };
}

export function describeMapping(payload) {
    return payload.tables.map(t =>
        `  ${t.sourceTableName.padEnd(12)} -> ${t.collectionName.padEnd(12)} ` +
        `cols=${String(t.columns.length).padEnd(3)} ` +
        `embed=[${t.embeddedTables.map(e => `${e.propertyName}:${e.type}`).join(' ')}] ` +
        `link=[${t.linkedTables.map(l => l.propertyName).join(' ')}]`).join('\n');
}

// CLI: build-mapping.mjs <discover.json> <out.json> <appName> <slug> <connString>
if (process.argv[1] && process.argv[1].endsWith('build-mapping.mjs')) {
    const [, , discoverPath, outPath, appName, slug, connString] = process.argv;
    const payload = buildMapping(JSON.parse(readFileSync(discoverPath, 'utf8')),
                                 { appName, slug, connString });
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`wrote ${outPath}\n${describeMapping(payload)}`);
}
