-- =============================================================================
-- Forkly demo data. 60 days of history, ~6k orders.
--
-- The data is NOT random. Three truths are planted in it. None of them is
-- visible on any screen of the app, and all three fall out of a chat over
-- this database within seconds:
--
--   1. Friday in Riverside. Two restaurants blow past their promised prep
--      time on Friday evenings, and courier staffing in that zone is at half
--      strength on exactly the same nights. The symptom shows up in delivery
--      times, the cause only after joining three tables and reading reviews.
--
--   2. The trap dish. Wild Mushroom Risotto has the best ratings and strong
--      sales, and at the same time the worst margin and the longest ticket.
--
--   3. The two-faced courier. Mark Wolfe has the fastest drop-off times in
--      the city and some of the worst ratings, because the complaint is
--      about manners, not speed.
--
-- The generator is deterministic (hashing instead of random()), so the same
-- data comes out every time. It also verifies itself at the bottom: if the
-- planted stories fail to show up, the script raises and the load fails loudly.
--
-- Safe to re-run: it truncates first, so it works both as a first-boot init
-- script and as a live re-seed against a running database.
-- =============================================================================

TRUNCATE reviews, deliveries, order_items, orders, shifts,
         couriers, customers, menu_items, restaurants, zones
    RESTART IDENTITY CASCADE;

-- Returns numeric, not double precision. Otherwise every round(x, 2) on the
-- result dies on the missing round(double precision, integer) overload.
CREATE OR REPLACE FUNCTION rnd(k text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
    SELECT (abs(hashtext(k)::bigint) % 1000003)::numeric / 1000003.0;
$$;

CREATE OR REPLACE FUNCTION rndint(k text, lo int, hi int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
    SELECT lo + floor(rnd(k) * (hi - lo + 1))::int;
$$;

-- -----------------------------------------------------------------------------
-- 1. Zones
-- -----------------------------------------------------------------------------
INSERT INTO zones (name) VALUES
    ('Downtown'), ('Riverside'), ('Northgate'), ('Old Town'),
    ('Harbour'), ('Westpark'), ('Hillside'), ('Eastfield');

-- -----------------------------------------------------------------------------
-- 2. Restaurants
-- -----------------------------------------------------------------------------
INSERT INTO restaurants (name, cuisine, zone_id, promised_prep_min, commission_rate, joined_at)
SELECT v.name, v.cuisine, z.zone_id, v.prep, v.comm, v.joined
FROM (VALUES
    ('Trattoria Aurora',      'italian',     'Downtown',  20, 0.220, DATE '2021-09-02'),
    ('The Daily Grind',       'american',    'Downtown',  15, 0.180, DATE '2022-03-14'),
    ('Sakura Room',           'japanese',    'Downtown',  25, 0.240, DATE '2022-01-20'),
    ('Anatolia Grill',        'turkish',     'Downtown',  12, 0.170, DATE '2023-05-11'),
    ('Patty Union',           'american',    'Downtown',  18, 0.200, DATE '2022-07-30'),

    -- Riverside. The Copper Pot and Saigon Corner are the leads in story #1.
    ('The Copper Pot',        'american',    'Riverside', 20, 0.190, DATE '2021-11-08'),
    ('Saigon Corner',         'vietnamese',  'Riverside', 18, 0.210, DATE '2022-02-17'),
    ('Napoli Bridge',         'italian',     'Riverside', 22, 0.220, DATE '2021-06-25'),
    ('Green Bowl',            'vegetarian',  'Riverside', 14, 0.180, DATE '2023-01-09'),
    ('Tandoor House',         'indian',      'Riverside', 26, 0.230, DATE '2022-10-03'),

    ('Sandwich Lab',          'american',    'Northgate', 10, 0.160, DATE '2023-02-27'),
    ('Pho Northgate',         'vietnamese',  'Northgate', 16, 0.200, DATE '2022-05-19'),
    ('Osteria Mulino',        'italian',     'Northgate', 24, 0.230, DATE '2021-12-01'),
    ('Kebab Central',         'turkish',     'Northgate', 11, 0.170, DATE '2023-06-14'),

    ('The Dumpling House',    'american',    'Old Town',  18, 0.180, DATE '2022-04-06'),
    ('Root & Stem',           'vegetarian',  'Old Town',  15, 0.190, DATE '2023-03-22'),
    ('Kaiseki Old Town',      'japanese',    'Old Town',  24, 0.240, DATE '2022-08-15'),
    ('Bistro Lumiere',        'french',      'Old Town',  27, 0.250, DATE '2023-04-18'),

    ('Curry Harbour',         'indian',      'Harbour',   25, 0.230, DATE '2022-06-11'),
    ('Pizza Dockside',        'italian',     'Harbour',   21, 0.220, DATE '2021-10-29'),
    ('Ramen Pier',            'japanese',    'Harbour',   19, 0.210, DATE '2023-07-05'),
    ('Saladworks Harbour',    'vegetarian',  'Harbour',   12, 0.170, DATE '2023-08-23'),

    ('Cafe Rossignol',        'french',      'Westpark',  26, 0.250, DATE '2022-09-12'),
    ('Taqueria Westpark',     'mexican',     'Westpark',  16, 0.200, DATE '2023-01-31'),
    ('Boulangerie Ouest',     'french',      'Westpark',   9, 0.150, DATE '2022-11-24'),

    ('Hillside Smokehouse',   'american',    'Hillside',  22, 0.190, DATE '2022-12-07'),
    ('Bangkok Hillside',      'thai',        'Hillside',  17, 0.200, DATE '2023-05-30'),
    ('Pizzeria Azzurra',      'italian',     'Hillside',  23, 0.220, DATE '2022-03-03'),

    ('Cluck & Co',            'american',    'Eastfield', 19, 0.200, DATE '2023-02-08'),
    ('Eastfield Diner',       'american',    'Eastfield', 21, 0.190, DATE '2022-10-17'),
    ('Sushi Eastfield',       'japanese',    'Eastfield', 26, 0.240, DATE '2023-09-04')
) AS v(name, cuisine, zone_name, prep, comm, joined)
JOIN zones z ON z.name = v.zone_name;

-- -----------------------------------------------------------------------------
-- 3. Menus. Eight dishes per cuisine, priced per restaurant.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE dish_tpl (cuisine TEXT, name TEXT, category TEXT,
                            base_price NUMERIC, cost_ratio NUMERIC, prep INT, veg BOOLEAN);

INSERT INTO dish_tpl VALUES
    ('american','Buttermilk Chicken Soup','soups',18,0.30,10,false),
    ('american','Loaded Potato Skins','starters',24,0.32,12,false),
    ('american','Classic Cheeseburger','mains',38,0.34,18,false),
    ('american','Pulled Pork Sandwich','mains',32,0.28,14,false),
    ('american','Smoked Brisket Plate','mains',44,0.36,20,false),
    ('american','Buffalo Wings (8 pc)','starters',34,0.32,15,false),
    ('american','Skin-On Fries','sides',14,0.22,7,true),
    ('american','Brownie Sundae','desserts',20,0.27,5,true),

    ('italian','Tomato Bruschetta','starters',22,0.25,8,true),
    ('italian','Margherita Pizza','pizza',36,0.29,14,true),
    ('italian','Diavola Pizza','pizza',44,0.31,15,false),
    ('italian','Spaghetti Carbonara','pasta',42,0.30,13,false),
    ('italian','Tagliatelle with Salmon','pasta',52,0.36,16,false),
    ('italian','Lasagne Bolognese','pasta',46,0.33,20,false),
    ('italian','Caprese Salad','salads',28,0.30,6,true),
    ('italian','Tiramisu','desserts',22,0.26,5,true),

    ('japanese','Miso Soup','soups',14,0.24,5,true),
    ('japanese','Edamame','starters',18,0.28,6,true),
    ('japanese','Salmon Avocado Roll (8 pc)','sushi',42,0.38,14,false),
    ('japanese','Nigiri Selection (10 pc)','sushi',68,0.42,18,false),
    ('japanese','Tonkotsu Ramen','mains',48,0.34,16,false),
    ('japanese','Pork Gyoza (6 pc)','starters',28,0.31,11,false),
    ('japanese','Wakame Salad','salads',20,0.29,5,true),
    ('japanese','Mochi Ice Cream','desserts',18,0.30,3,true),

    ('vietnamese','Vegetable Spring Rolls (4 pc)','starters',22,0.26,9,true),
    ('vietnamese','Pho Bo','soups',38,0.32,13,false),
    ('vietnamese','Pho Ga','soups',35,0.30,12,false),
    ('vietnamese','Bun Cha','mains',44,0.35,17,false),
    ('vietnamese','Lemongrass Chicken','mains',41,0.33,15,false),
    ('vietnamese','Tamarind Tofu','mains',36,0.27,14,true),
    ('vietnamese','Green Papaya Salad','salads',26,0.28,7,true),
    ('vietnamese','Vietnamese Iced Coffee','drinks',14,0.20,4,true),

    ('indian','Vegetable Samosa (3 pc)','starters',20,0.24,10,true),
    ('indian','Chicken Tikka Masala','mains',48,0.35,20,false),
    ('indian','Butter Chicken','mains',50,0.36,22,false),
    ('indian','Palak Paneer','mains',42,0.29,18,true),
    ('indian','Dal Makhani','mains',36,0.25,16,true),
    ('indian','Garlic Naan','sides',12,0.20,6,true),
    ('indian','Cucumber Raita','sides',10,0.22,4,true),
    ('indian','Gulab Jamun','desserts',16,0.26,5,true),

    ('vegetarian','Quinoa Sweet Potato Bowl','bowls',38,0.30,11,true),
    ('vegetarian','Falafel Bowl','bowls',36,0.28,10,true),
    ('vegetarian','Roasted Beetroot Salad','salads',32,0.29,8,true),
    ('vegetarian','Pumpkin Veloute','soups',20,0.24,7,true),
    ('vegetarian','Hummus Flatbread','sandwiches',24,0.25,6,true),
    ('vegetarian','Spinach Crepes','mains',34,0.27,14,true),
    ('vegetarian','Green Smoothie','drinks',18,0.26,4,true),
    ('vegetarian','Carrot Cake','desserts',17,0.25,4,true),

    ('turkish','Doner in Pita','wraps',26,0.30,8,false),
    ('turkish','Doner in Bun','wraps',28,0.31,8,false),
    ('turkish','Falafel Pita','wraps',24,0.24,9,true),
    ('turkish','Mezze Platter','starters',38,0.29,12,true),
    ('turkish','Hummus with Flatbread','starters',22,0.23,6,true),
    ('turkish','Adana Kebab with Rice','mains',44,0.34,16,false),
    ('turkish','Shepherd Salad','salads',18,0.26,5,true),
    ('turkish','Baklava (3 pc)','desserts',18,0.28,3,true),

    ('french','French Onion Soup','soups',26,0.27,14,true),
    ('french','Quiche Lorraine','mains',34,0.30,16,false),
    ('french','Duck Confit','mains',68,0.40,24,false),
    ('french','Ratatouille','mains',38,0.26,18,true),
    ('french','Croque Monsieur','sandwiches',32,0.31,10,false),
    ('french','Butter Baguette','sides',8,0.18,2,true),
    ('french','Creme Brulee','desserts',24,0.28,6,true),
    ('french','Lemon Tart','desserts',22,0.27,5,true),

    ('mexican','Loaded Nachos','starters',28,0.27,9,true),
    ('mexican','Beef Tacos (3 pc)','tacos',38,0.33,12,false),
    ('mexican','Chicken Tacos (3 pc)','tacos',36,0.32,12,false),
    ('mexican','Vegan Tacos (3 pc)','tacos',34,0.26,11,true),
    ('mexican','Beef Burrito','mains',42,0.34,14,false),
    ('mexican','Cheese Quesadilla','mains',32,0.29,10,true),
    ('mexican','Guacamole & Chips','starters',24,0.31,6,true),
    ('mexican','Churros with Chocolate','desserts',20,0.25,7,true),

    ('thai','Chicken Satay (4 pc)','starters',26,0.29,11,false),
    ('thai','Tom Yum Goong','soups',34,0.33,12,false),
    ('thai','Pad Thai','mains',40,0.30,14,false),
    ('thai','Green Curry','mains',44,0.34,17,false),
    ('thai','Massaman Curry','mains',46,0.35,19,false),
    ('thai','Cashew Tofu Stir Fry','mains',36,0.27,13,true),
    ('thai','Som Tam','salads',24,0.28,7,true),
    ('thai','Mango Sticky Rice','desserts',22,0.26,6,true);

INSERT INTO menu_items (restaurant_id, name, category, price, food_cost, prep_min, is_vegetarian)
SELECT r.restaurant_id,
       t.name,
       t.category,
       ROUND(t.base_price * (0.90 + 0.25 * rnd('p:' || r.restaurant_id || ':' || t.name)), 2),
       ROUND(t.base_price * (0.90 + 0.25 * rnd('p:' || r.restaurant_id || ':' || t.name)) * t.cost_ratio, 2),
       t.prep,
       t.veg
FROM restaurants r
JOIN dish_tpl t ON t.cuisine = r.cuisine;

-- Story #2: the trap dish. Best ratings, worst margin in the house, longest
-- ticket. Inserted separately so it can be pointed at by name.
INSERT INTO menu_items (restaurant_id, name, category, price, food_cost, prep_min, is_vegetarian)
SELECT r.restaurant_id, 'Wild Mushroom Risotto', 'mains', 64.00, 43.00, 32, true
FROM restaurants r WHERE r.name = 'Trattoria Aurora';

-- -----------------------------------------------------------------------------
-- 4. Customers
-- -----------------------------------------------------------------------------
INSERT INTO customers (full_name, email, zone_id, signed_up_at)
SELECT fn || ' ' || ln,
       lower(fn) || '.' || lower(ln) || i || '@example.com',
       z.zone_id,
       CURRENT_DATE - rndint('su:' || i, 30, 900)
FROM generate_series(1, 800) AS g(i)
CROSS JOIN LATERAL (
    SELECT (ARRAY['Emma','James','Olivia','Liam','Sophia','Noah','Ava','Ethan',
                  'Isabella','Mason','Mia','Lucas','Charlotte','Henry','Amelia','Jack',
                  'Harper','Owen','Evelyn','Leo','Abigail','Nathan','Ella','Caleb',
                  'Grace','Adrian','Chloe','Miles','Zoe','Julian'])[1 + (abs(hashtext('fn:'||i)) % 30)] AS fn,
           (ARRAY['Bennett','Carter','Donovan','Ellis','Fletcher','Garrison','Hayes',
                  'Ingram','Jennings','Kirby','Lawson','Mercer','Norton','Osborne',
                  'Prescott','Quinn','Radcliffe','Sinclair','Thornton','Underwood',
                  'Vaughan','Whitfield','Ashcroft','Barlow','Chandler','Duffield',
                  'Everhart','Fairbanks','Goodwin','Halloway'])[1 + (abs(hashtext('ln:'||i)) % 30)] AS ln
) n
CROSS JOIN LATERAL (
    SELECT zone_id FROM zones ORDER BY rnd('cz:' || i || ':' || zone_id) LIMIT 1
) z;

-- -----------------------------------------------------------------------------
-- 5. Couriers
-- -----------------------------------------------------------------------------
INSERT INTO couriers (full_name, vehicle, home_zone_id, hired_at)
SELECT fn || ' ' || ln,
       (ARRAY['bike','scooter','car','on foot'])[1 + (abs(hashtext('v:'||i)) % 4)],
       z.zone_id,
       CURRENT_DATE - rndint('hi:' || i, 60, 1100)
FROM generate_series(1, 54) AS g(i)
CROSS JOIN LATERAL (
    SELECT (ARRAY['Tyler','Dominic','Kieran','Felix','Oscar','Igor','Simon','Wesley','Patrick',
                  'Emily','Nicole','Olive','Victoria','Amelie','Susan','Hugo','Conrad','Nolan'])[1 + (abs(hashtext('cfn:'||i)) % 18)] AS fn,
           (ARRAY['Sikora','Barnes','Crowley','Sanders','Rutledge','Gorman','Whitaker','Walsh',
                  'Sobel','Chambers','Burke','Zane','Lister','Wren','Sowell','Kane','Shaw','Ostrom'])[1 + (abs(hashtext('cln:'||i)) % 18)] AS ln
) n
CROSS JOIN LATERAL (
    SELECT zone_id FROM zones ORDER BY rnd('kz:' || i || ':' || zone_id) LIMIT 1
) z;

-- Story #3: the two-faced courier. Fastest in the city, worst rated.
INSERT INTO couriers (full_name, vehicle, home_zone_id, hired_at)
SELECT 'Mark Wolfe', 'scooter', z.zone_id, CURRENT_DATE - 420
FROM zones z WHERE z.name = 'Downtown';

-- -----------------------------------------------------------------------------
-- 6. Courier shifts.
--    Second half of story #1 lives here: Riverside on Fridays runs at half
--    staffing, on exactly the busiest night of the week.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE cal AS
SELECT d::date AS d, EXTRACT(dow FROM d)::int AS dow
FROM generate_series(CURRENT_DATE - 59, CURRENT_DATE - 1, interval '1 day') AS g(d);

INSERT INTO shifts (courier_id, zone_id, shift_date, starts_at, ends_at)
SELECT c.courier_id, z.zone_id, cal.d, cal.d + TIME '11:00', cal.d + TIME '22:00'
FROM cal
CROSS JOIN zones z
CROSS JOIN LATERAL (
    SELECT GREATEST(2, ROUND(
        (CASE z.name
            WHEN 'Downtown' THEN 10 WHEN 'Riverside' THEN 9 WHEN 'Northgate' THEN 7
            WHEN 'Old Town' THEN 6 WHEN 'Harbour' THEN 6 WHEN 'Westpark' THEN 5
            WHEN 'Hillside' THEN 5 ELSE 4 END)
        * (CASE WHEN cal.dow IN (5, 6) THEN 1.15 ELSE 1.0 END)
        -- <<< planted: Riverside on Fridays runs at half staffing
        * (CASE WHEN z.name = 'Riverside' AND cal.dow = 5 THEN 0.5 ELSE 1.0 END)
    ))::int AS n
) k
CROSS JOIN LATERAL (
    SELECT courier_id FROM couriers
    ORDER BY (home_zone_id = z.zone_id) DESC, rnd('sh:' || cal.d || ':' || z.zone_id || ':' || courier_id)
    LIMIT k.n
) c;

-- -----------------------------------------------------------------------------
-- 7. Orders
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE zone_pick AS
SELECT (row_number() OVER (ORDER BY z.zone_id, s)) - 1 AS idx, z.zone_id
FROM zones z
JOIN (VALUES ('Downtown',22),('Riverside',20),('Northgate',14),('Old Town',12),
             ('Harbour',11),('Westpark',8),('Hillside',7),('Eastfield',6)) AS w(zname, weight)
  ON w.zname = z.name
CROSS JOIN LATERAL generate_series(1, w.weight) AS s;

CREATE TEMP TABLE hour_pick AS
SELECT (row_number() OVER (ORDER BY h.hr, s)) - 1 AS idx, h.hr
FROM (VALUES (10,2),(11,6),(12,12),(13,11),(14,7),(15,4),(16,4),
             (17,8),(18,13),(19,14),(20,11),(21,6),(22,2)) AS h(hr, weight)
CROSS JOIN LATERAL generate_series(1, h.weight) AS s;

-- Lookup tables for picking. Without them every one of the 6k orders would
-- scan the whole customers table, which turns container init into minutes.
CREATE TEMP TABLE cust_idx AS
SELECT zone_id, customer_id,
       (row_number() OVER (PARTITION BY zone_id ORDER BY customer_id)) - 1 AS idx
FROM customers;
CREATE TEMP TABLE cust_cnt AS SELECT zone_id, COUNT(*) AS cnt FROM customers GROUP BY zone_id;
CREATE UNIQUE INDEX ON cust_idx(zone_id, idx);
CREATE UNIQUE INDEX ON cust_cnt(zone_id);

CREATE TEMP TABLE rest_idx AS
SELECT zone_id, restaurant_id,
       (row_number() OVER (PARTITION BY zone_id ORDER BY restaurant_id)) - 1 AS idx
FROM restaurants;
CREATE TEMP TABLE rest_cnt AS SELECT zone_id, COUNT(*) AS cnt FROM restaurants GROUP BY zone_id;
CREATE TEMP TABLE rest_all AS
SELECT restaurant_id, (row_number() OVER (ORDER BY restaurant_id)) - 1 AS idx FROM restaurants;
CREATE UNIQUE INDEX ON rest_idx(zone_id, idx);
CREATE UNIQUE INDEX ON rest_cnt(zone_id);
CREATE UNIQUE INDEX ON rest_all(idx);

INSERT INTO orders (customer_id, restaurant_id, zone_id, placed_at, status,
                    subtotal, delivery_fee, tip, promo_code)
SELECT cu.customer_id,
       re.restaurant_id,
       zp.zone_id,
       cal.d + make_interval(hours => hp.hr, mins => rndint('mi:'||cal.d||':'||g.n, 0, 59)),
       CASE WHEN rnd('st:'||cal.d||':'||g.n) < 0.03 THEN 'cancelled' ELSE 'delivered' END,
       0,
       CASE WHEN rnd('df:'||cal.d||':'||g.n) < 0.25 THEN 0 ELSE 6.99 END,
       ROUND((rndint('tp:'||cal.d||':'||g.n, 0, 12))::numeric, 2),
       CASE WHEN rnd('pc:'||cal.d||':'||g.n) < 0.12
            THEN (ARRAY['WELCOME20','FRIDAY15','LUNCH10'])[1 + (abs(hashtext('pk:'||cal.d||':'||g.n)) % 3)]
            ELSE NULL END
FROM cal
CROSS JOIN LATERAL (
    SELECT generate_series(1, (CASE cal.dow WHEN 5 THEN 130 WHEN 6 THEN 120 WHEN 0 THEN 110 ELSE 85 END)) AS n
) g
CROSS JOIN LATERAL (
    SELECT zone_id FROM zone_pick WHERE idx = floor(rnd('z:'||cal.d||':'||g.n) * 100)::int
) zp
CROSS JOIN LATERAL (
    SELECT hr FROM hour_pick WHERE idx = floor(rnd('h:'||cal.d||':'||g.n) * 100)::int
) hp
CROSS JOIN LATERAL (
    SELECT CASE
        -- Friday evening in Riverside: the two most popular kitchens take
        -- two thirds of the zone traffic, which is exactly why they seize up.
        -- Cause and effect are meant to hang together here, not be bolted on.
        WHEN zp.zone_id = (SELECT zone_id FROM zones WHERE name = 'Riverside')
             AND cal.dow = 5 AND hp.hr BETWEEN 17 AND 21
             AND rnd('mk:'||cal.d||':'||g.n) < 0.65
        THEN (SELECT restaurant_id FROM restaurants
              WHERE name = CASE WHEN rnd('mk2:'||cal.d||':'||g.n) < 0.5
                                THEN 'The Copper Pot' ELSE 'Saigon Corner' END)
        -- 85% of the rest order inside their own zone, the remainder city-wide
        WHEN rnd('rx:'||cal.d||':'||g.n) < 0.15
        THEN (SELECT restaurant_id FROM rest_all
              WHERE idx = floor(rnd('rg:'||cal.d||':'||g.n) * (SELECT COUNT(*) FROM rest_all))::int)
        ELSE (SELECT restaurant_id FROM rest_idx
              WHERE zone_id = zp.zone_id
                AND idx = floor(rnd('r:'||cal.d||':'||g.n)
                                * (SELECT cnt FROM rest_cnt WHERE zone_id = zp.zone_id))::int)
      END AS restaurant_id
) re
CROSS JOIN LATERAL (
    SELECT customer_id FROM cust_idx
    WHERE zone_id = zp.zone_id
      AND idx = floor(rnd('c:'||cal.d||':'||g.n)
                      * (SELECT cnt FROM cust_cnt WHERE zone_id = zp.zone_id))::int
) cu;

-- -----------------------------------------------------------------------------
-- 8. Order lines
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE menu_idx AS
SELECT restaurant_id, menu_item_id, price,
       (row_number() OVER (PARTITION BY restaurant_id ORDER BY menu_item_id)) - 1 AS idx
FROM menu_items WHERE name <> 'Wild Mushroom Risotto';
CREATE TEMP TABLE menu_cnt AS
SELECT restaurant_id, COUNT(*) AS cnt FROM menu_items
WHERE name <> 'Wild Mushroom Risotto' GROUP BY restaurant_id;
CREATE UNIQUE INDEX ON menu_idx(restaurant_id, idx);
CREATE UNIQUE INDEX ON menu_cnt(restaurant_id);

INSERT INTO order_items (order_id, menu_item_id, qty, unit_price)
SELECT o.order_id, mi.menu_item_id,
       CASE WHEN rnd('q:'||o.order_id||':'||s.i) < 0.78 THEN 1 ELSE 2 END,
       mi.price
FROM orders o
CROSS JOIN LATERAL generate_series(1, 1 + floor(rnd('n:'||o.order_id) * 3)::int) AS s(i)
CROSS JOIN LATERAL (
    SELECT menu_item_id, price FROM menu_idx
    WHERE restaurant_id = o.restaurant_id
      AND idx = floor(rnd('it:'||o.order_id||':'||s.i)
                      * (SELECT cnt FROM menu_cnt WHERE restaurant_id = o.restaurant_id))::int
) mi;

-- The trap dish lands in ~40% of its restaurant's orders, so it sells
-- extremely well. That is the point: a bestseller that costs you money.
INSERT INTO order_items (order_id, menu_item_id, qty, unit_price)
SELECT o.order_id, m.menu_item_id, 1, m.price
FROM orders o
JOIN restaurants r ON r.restaurant_id = o.restaurant_id AND r.name = 'Trattoria Aurora'
JOIN menu_items m ON m.restaurant_id = r.restaurant_id AND m.name = 'Wild Mushroom Risotto'
WHERE rnd('trap:'||o.order_id) < 0.40;

UPDATE orders o
SET subtotal = s.total
FROM (SELECT order_id, ROUND(SUM(qty * unit_price), 2) AS total
      FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.order_id;

-- -----------------------------------------------------------------------------
-- 9. Deliveries. The evidence for stories #1 and #3 lives here.
-- -----------------------------------------------------------------------------
INSERT INTO deliveries (order_id, courier_id, assigned_at, picked_up_at, delivered_at, distance_km)
SELECT o.order_id,
       co.courier_id,
       o.placed_at + make_interval(mins => t.assign_delay),
       o.placed_at + make_interval(mins => GREATEST(t.assign_delay + 4, t.prep_actual)),
       o.placed_at + make_interval(mins => GREATEST(t.assign_delay + 4, t.prep_actual) + t.travel),
       t.dist
FROM orders o
JOIN restaurants r ON r.restaurant_id = o.restaurant_id
JOIN zones z       ON z.zone_id = o.zone_id
CROSS JOIN LATERAL (
    SELECT courier_id FROM shifts sh
    WHERE sh.zone_id = o.zone_id AND sh.shift_date = o.placed_at::date
    ORDER BY rnd('cr:'||o.order_id||':'||sh.courier_id) LIMIT 1
) co
CROSS JOIN LATERAL (
    SELECT EXTRACT(dow FROM o.placed_at)::int AS dow,
           EXTRACT(hour FROM o.placed_at)::int AS hr
) d
CROSS JOIN LATERAL (
    SELECT
        -- Time to find a courier. Riverside on Friday evenings runs at half
        -- staffing, so an order waits noticeably longer to be assigned.
        CASE WHEN z.name = 'Riverside' AND d.dow = 5 AND d.hr BETWEEN 17 AND 21
             THEN rndint('ad:'||o.order_id, 9, 21)
             ELSE rndint('ad:'||o.order_id, 1, 6) END AS assign_delay,
        -- Kitchen time. Two Riverside restaurants miss their promise by half
        -- an hour on Friday evenings.
        CASE WHEN r.name IN ('The Copper Pot', 'Saigon Corner')
                  AND d.dow = 5 AND d.hr BETWEEN 17 AND 21
             THEN r.promised_prep_min + rndint('pp:'||o.order_id, 30, 52)
             ELSE r.promised_prep_min + rndint('pp:'||o.order_id, -3, 8) END AS prep_actual,
        -- Mark rides noticeably faster than everyone else
        (CASE WHEN co.courier_id = (SELECT courier_id FROM couriers WHERE full_name = 'Mark Wolfe')
              THEN 0.62 ELSE 1.0 END * rndint('tr:'||o.order_id, 9, 26))::int AS travel,
        ROUND((0.8 + rnd('ds:'||o.order_id) * 5.5)::numeric, 2) AS dist
) t
WHERE o.status = 'delivered';

-- -----------------------------------------------------------------------------
-- 10. Reviews. The rating follows the real delivery time and the comment
--     names the cause. This is the free text the model summarises.
-- -----------------------------------------------------------------------------
INSERT INTO reviews (order_id, rating, comment, created_at)
SELECT o.order_id,
       GREATEST(1, LEAST(5, base.rating + adj.delta)),
       txt.comment,
       dl.delivered_at + make_interval(mins => rndint('rv:'||o.order_id, 20, 900))
FROM orders o
JOIN deliveries dl ON dl.order_id = o.order_id
JOIN restaurants r ON r.restaurant_id = o.restaurant_id
JOIN zones z       ON z.zone_id = o.zone_id
CROSS JOIN LATERAL (
    SELECT EXTRACT(EPOCH FROM (dl.delivered_at - o.placed_at)) / 60 AS total_min,
           EXTRACT(EPOCH FROM (dl.picked_up_at - o.placed_at)) / 60 AS wait_min,
           EXTRACT(EPOCH FROM (dl.assigned_at  - o.placed_at)) / 60 AS assign_min
) m
CROSS JOIN LATERAL (
    SELECT CASE WHEN m.total_min <= 35 THEN 5
                WHEN m.total_min <= 50 THEN 4
                WHEN m.total_min <= 65 THEN 3
                WHEN m.total_min <= 80 THEN 2
                ELSE 1 END AS rating
) base
CROSS JOIN LATERAL (
    SELECT (CASE WHEN co.full_name = 'Mark Wolfe' THEN -2 ELSE 0 END)
         + (CASE WHEN EXISTS (SELECT 1 FROM order_items oi
                              JOIN menu_items mi ON mi.menu_item_id = oi.menu_item_id
                              WHERE oi.order_id = o.order_id AND mi.name = 'Wild Mushroom Risotto')
                 THEN 1 ELSE 0 END) AS delta,
           co.full_name AS courier_name
    FROM couriers co WHERE co.courier_id = dl.courier_id
) adj
CROSS JOIN LATERAL (
    SELECT CASE
        -- the two-faced courier: fast, but no manners
        WHEN adj.courier_name = 'Mark Wolfe' THEN
            (ARRAY['Fast, but the courier was rude and dumped the bag by the door.',
                   'Lightning quick delivery, except he never rang and left the food on the mat.',
                   'Very fast, zero manners though. Grunted and walked off.',
                   'Delivery time was excellent, the courier''s attitude was awful.',
                   'No complaints about the speed, plenty about how the courier speaks to people.'
                  ])[1 + (abs(hashtext('rc:'||o.order_id)) % 5)]
        -- waiting on the kitchen: the courier was stuck at the restaurant
        WHEN m.wait_min > 45 THEN
            (ARRAY['The courier waited outside the restaurant for nearly half an hour, food arrived lukewarm.',
                   'Friday again, over an hour again. The app showed the courier waiting for pickup.',
                   'The kitchen cannot keep up on Friday evenings, the courier is not to blame.',
                   'Order showed up 40 minutes past the promised time, food was cold.',
                   'Friday kitchen is a lottery. Lost today, the food sat ready and went cold.'
                  ])[1 + (abs(hashtext('rw:'||o.order_id)) % 5)]
        -- long hunt for a courier
        WHEN m.assign_min > 8 THEN
            (ARRAY['Nobody was assigned for ages, the order just sat ready at the restaurant.',
                   'Waited 20 minutes before a courier was even found.',
                   'Food was good, but no one picked the order up for half an hour.'
                  ])[1 + (abs(hashtext('ra:'||o.order_id)) % 3)]
        WHEN m.total_min > 65 THEN
            (ARRAY['Far too slow.', 'Over an hour for delivery, poor.',
                   'Food was fine, the delivery time was not.'])[1 + (abs(hashtext('rl:'||o.order_id)) % 3)]
        WHEN m.total_min > 50 THEN
            (ARRAY['Fine, though slower than advertised.',
                   'Good food, average delivery.',
                   'Bit of a wait, but it tasted good.'])[1 + (abs(hashtext('rm:'||o.order_id)) % 3)]
        WHEN EXISTS (SELECT 1 FROM order_items oi JOIN menu_items mi ON mi.menu_item_id = oi.menu_item_id
                     WHERE oi.order_id = o.order_id AND mi.name = 'Wild Mushroom Risotto') THEN
            (ARRAY['The wild mushroom risotto is outstanding, worth the wait.',
                   'Best risotto in the city, I order it every week.',
                   'Risotto is a knockout, the rest of the menu holds up too.',
                   'I order from across town just for that risotto.'
                  ])[1 + (abs(hashtext('rt:'||o.order_id)) % 4)]
        ELSE
            (ARRAY['On time, hot, recommended.', 'Quick and tasty.', 'No complaints.',
                   'Friendly courier, hot food.', 'Solid as always.',
                   'Punctual and tasty, nothing to add.'])[1 + (abs(hashtext('rg:'||o.order_id)) % 6)]
    END AS comment
) txt
WHERE rnd('has:'||o.order_id) < 0.68;

-- -----------------------------------------------------------------------------
-- 11. Self-check: are the planted stories actually visible in the data?
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_fri_riv NUMERIC; v_other NUMERIC; v_mark_t NUMERIC; v_mark_r NUMERIC;
    v_rest_t  NUMERIC; v_orders BIGINT; v_reviews BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_orders FROM orders;
    SELECT COUNT(*) INTO v_reviews FROM reviews;

    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60)::numeric, 1)
      INTO v_fri_riv
      FROM orders o JOIN deliveries d ON d.order_id = o.order_id JOIN zones z ON z.zone_id = o.zone_id
     WHERE z.name = 'Riverside' AND EXTRACT(dow FROM o.placed_at) = 5
       AND EXTRACT(hour FROM o.placed_at) BETWEEN 17 AND 21;

    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60)::numeric, 1)
      INTO v_other
      FROM orders o JOIN deliveries d ON d.order_id = o.order_id JOIN zones z ON z.zone_id = o.zone_id
     WHERE NOT (z.name = 'Riverside' AND EXTRACT(dow FROM o.placed_at) = 5);

    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.picked_up_at))/60)::numeric, 1),
           ROUND(AVG(rv.rating)::numeric, 2)
      INTO v_mark_t, v_mark_r
      FROM deliveries d JOIN couriers c ON c.courier_id = d.courier_id
      LEFT JOIN reviews rv ON rv.order_id = d.order_id
     WHERE c.full_name = 'Mark Wolfe';

    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.picked_up_at))/60)::numeric, 1)
      INTO v_rest_t
      FROM deliveries d JOIN couriers c ON c.courier_id = d.courier_id
     WHERE c.full_name <> 'Mark Wolfe';

    RAISE NOTICE '--- Forkly: data seeded ---';
    RAISE NOTICE 'orders: %, reviews: %', v_orders, v_reviews;
    RAISE NOTICE 'story 1: Riverside Friday evening % min vs rest % min', v_fri_riv, v_other;
    RAISE NOTICE 'story 3: Mark drops in % min (rest %), rating %', v_mark_t, v_rest_t, v_mark_r;

    IF v_fri_riv < v_other + 18 THEN
        RAISE EXCEPTION 'Story 1 did not seed: % vs %', v_fri_riv, v_other;
    END IF;
    IF v_mark_t >= v_rest_t THEN
        RAISE EXCEPTION 'Story 3 did not seed: Mark %, rest %', v_mark_t, v_rest_t;
    END IF;
END $$;
