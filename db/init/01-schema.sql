-- =============================================================================
-- Forkly: a food delivery marketplace.
--
-- An ordinary relational schema, the one this app would have anyway.
-- Every table has a single-column primary key, because that is what Quill
-- uses to identify records and track their changes.
-- =============================================================================

CREATE TABLE zones (
    zone_id     SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    city        TEXT NOT NULL DEFAULT 'Ashbourne'
);

CREATE TABLE restaurants (
    restaurant_id     SERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    cuisine           TEXT NOT NULL,
    zone_id           INT  NOT NULL REFERENCES zones(zone_id),
    promised_prep_min INT  NOT NULL,          -- what the app promises the customer
    commission_rate   NUMERIC(4,3) NOT NULL,  -- our commission
    joined_at         DATE NOT NULL,
    active            BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
    menu_item_id  SERIAL PRIMARY KEY,
    restaurant_id INT  NOT NULL REFERENCES restaurants(restaurant_id),
    name          TEXT NOT NULL,
    category      TEXT NOT NULL,
    price         NUMERIC(8,2) NOT NULL,
    food_cost     NUMERIC(8,2) NOT NULL,   -- ingredient cost, i.e. the margin
    prep_min      INT NOT NULL,            -- what the kitchen actually takes
    is_vegetarian BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE customers (
    customer_id  SERIAL PRIMARY KEY,
    full_name    TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    zone_id      INT  NOT NULL REFERENCES zones(zone_id),
    signed_up_at DATE NOT NULL
);

CREATE TABLE couriers (
    courier_id   SERIAL PRIMARY KEY,
    full_name    TEXT NOT NULL,
    vehicle      TEXT NOT NULL,   -- bike / scooter / car / on foot
    home_zone_id INT  NOT NULL REFERENCES zones(zone_id),
    hired_at     DATE NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT true
);

-- Who is on shift and where. This is where the staffing level hides,
-- the one thing no screen in the app shows.
CREATE TABLE shifts (
    shift_id   SERIAL PRIMARY KEY,
    courier_id INT  NOT NULL REFERENCES couriers(courier_id),
    zone_id    INT  NOT NULL REFERENCES zones(zone_id),
    shift_date DATE NOT NULL,
    starts_at  TIMESTAMPTZ NOT NULL,
    ends_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE orders (
    order_id      SERIAL PRIMARY KEY,
    customer_id   INT  NOT NULL REFERENCES customers(customer_id),
    restaurant_id INT  NOT NULL REFERENCES restaurants(restaurant_id),
    zone_id       INT  NOT NULL REFERENCES zones(zone_id),  -- delivery zone
    placed_at     TIMESTAMPTZ NOT NULL,
    status        TEXT NOT NULL,           -- delivered / cancelled
    subtotal      NUMERIC(8,2) NOT NULL,
    delivery_fee  NUMERIC(6,2) NOT NULL,
    tip           NUMERIC(6,2) NOT NULL DEFAULT 0,
    promo_code    TEXT
);

CREATE TABLE order_items (
    order_item_id SERIAL PRIMARY KEY,
    order_id      INT NOT NULL REFERENCES orders(order_id),
    menu_item_id  INT NOT NULL REFERENCES menu_items(menu_item_id),
    qty           INT NOT NULL,
    unit_price    NUMERIC(8,2) NOT NULL
);

-- Where the time goes: assigned -> picked_up -> delivered.
CREATE TABLE deliveries (
    delivery_id  SERIAL PRIMARY KEY,
    order_id     INT NOT NULL UNIQUE REFERENCES orders(order_id),
    courier_id   INT REFERENCES couriers(courier_id),
    assigned_at  TIMESTAMPTZ,
    picked_up_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    distance_km  NUMERIC(5,2)
);

-- A rating plus free text. This is the material the model summarises.
CREATE TABLE reviews (
    review_id  SERIAL PRIMARY KEY,
    order_id   INT NOT NULL UNIQUE REFERENCES orders(order_id),
    rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment    TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX ix_orders_placed_at    ON orders(placed_at);
CREATE INDEX ix_orders_zone         ON orders(zone_id);
CREATE INDEX ix_orders_restaurant   ON orders(restaurant_id);
CREATE INDEX ix_order_items_order   ON order_items(order_id);
CREATE INDEX ix_deliveries_courier  ON deliveries(courier_id);
CREATE INDEX ix_shifts_date_zone    ON shifts(shift_date, zone_id);
CREATE INDEX ix_reviews_created_at  ON reviews(created_at);

-- =============================================================================
-- Users. The app reads its own data, Quill reads the changes.
-- =============================================================================

-- The app's account. A plain reader, nothing special.
CREATE USER zjadlo_app WITH PASSWORD 'zjadlo_app';
GRANT CONNECT ON DATABASE zjadlo TO zjadlo_app;
GRANT USAGE ON SCHEMA public TO zjadlo_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zjadlo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO zjadlo_app;

-- Quill's account. The REPLICATION attribute plus wal_level=logical is the
-- minimum CDC needs on the Postgres side.
CREATE USER quill_cdc WITH REPLICATION PASSWORD 'quill_cdc';
GRANT CONNECT ON DATABASE zjadlo TO quill_cdc;
GRANT USAGE ON SCHEMA public TO quill_cdc;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO quill_cdc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO quill_cdc;

-- NOTE, this is not decoration. information_schema.key_column_usage only
-- exposes constraints to a user holding some privilege OTHER than SELECT on
-- the table. A pure reader sees zero primary keys, so Quill's schema discovery
-- reports "no primary key" for every table even though the keys are right
-- there. REFERENCES is the smallest privilege that unblocks it, and it still
-- grants no write access.
GRANT REFERENCES ON ALL TABLES IN SCHEMA public TO quill_cdc;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT REFERENCES ON TABLES TO quill_cdc;

-- CDC creates its own publication on the source database, and PostgreSQL is
-- strict about who may do that:
--
--   CREATE PUBLICATION ... FOR TABLE  requires ownership of those tables
--   CREATE PUBLICATION FOR ALL TABLES requires superuser
--
-- So a purely read-only account cannot run CDC at all. It needs CREATE on the
-- database and it has to own the tables it publishes. Ownership is the smaller
-- of the two evils here: it stays a non-superuser role, scoped to this schema.
--
-- Get this wrong and nothing tells you. The CDC task registers, reports itself
-- enabled, and then fails in the Extraction step with "Insufficient permissions
-- to create publication". The app looks healthy and mirrors zero documents.
-- The error is visible only under /api/apps/<slug>/cdc/errors.
GRANT CREATE ON DATABASE zjadlo TO quill_cdc;

DO $$
DECLARE t text;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO quill_cdc', t); END LOOP;
END $$;

-- Ownership moved, so re-grant what the app needs to read.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zjadlo_app;
