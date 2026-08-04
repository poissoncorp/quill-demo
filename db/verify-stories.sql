-- Proves the three planted stories really are in the data.
-- These are the same truths the chat is supposed to find. If they are not
-- visible here, the agent will not find them either.

\echo '=== STORY 1a: evening delivery times by zone and weekday (worst only) ==='
SELECT z.name AS zone,
       to_char(o.placed_at, 'Dy') AS day,
       COUNT(*) AS orders,
       ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60)::numeric, 1) AS avg_min
FROM orders o
JOIN deliveries d ON d.order_id = o.order_id
JOIN zones z      ON z.zone_id = o.zone_id
WHERE EXTRACT(hour FROM o.placed_at) BETWEEN 17 AND 21
GROUP BY z.name, EXTRACT(dow FROM o.placed_at), to_char(o.placed_at, 'Dy')
HAVING AVG(EXTRACT(EPOCH FROM (d.delivered_at - o.placed_at))/60) > 55
ORDER BY avg_min DESC;

\echo ''
\echo '=== STORY 1b: the kitchen side (promised vs actual, Friday evenings) ==='
SELECT r.name AS restaurant,
       r.promised_prep_min AS promised_min,
       ROUND(AVG(EXTRACT(EPOCH FROM (d.picked_up_at - o.placed_at))/60)::numeric, 1) AS actual_min,
       COUNT(*) AS orders
FROM orders o
JOIN deliveries d  ON d.order_id = o.order_id
JOIN restaurants r ON r.restaurant_id = o.restaurant_id
WHERE EXTRACT(dow FROM o.placed_at) = 5
  AND EXTRACT(hour FROM o.placed_at) BETWEEN 17 AND 21
GROUP BY r.name, r.promised_prep_min
ORDER BY actual_min DESC
LIMIT 10;

\echo ''
\echo '=== STORY 1c: the staffing side (couriers on shift in Riverside) ==='
SELECT to_char(x.shift_date, 'Dy') AS day,
       ROUND(AVG(x.cnt)::numeric, 1) AS avg_couriers
FROM (SELECT s.shift_date, COUNT(*) AS cnt
      FROM shifts s
      JOIN zones z ON z.zone_id = s.zone_id
      WHERE z.name = 'Riverside'
      GROUP BY s.shift_date) x
GROUP BY EXTRACT(dow FROM x.shift_date), to_char(x.shift_date, 'Dy')
ORDER BY avg_couriers;

\echo ''
\echo '=== STORY 1d: what customers wrote (sample) ==='
SELECT rv.rating, rv.comment
FROM reviews rv
JOIN orders o ON o.order_id = rv.order_id
JOIN zones z  ON z.zone_id = o.zone_id
WHERE z.name = 'Riverside'
  AND EXTRACT(dow FROM o.placed_at) = 5
  AND rv.rating <= 2
LIMIT 6;

\echo ''
\echo '=== STORY 2: the trap dish (margin vs ratings vs kitchen time) ==='
SELECT m.name AS dish,
       m.price, m.food_cost,
       ROUND(((m.price - m.food_cost) / m.price * 100)::numeric, 0) AS margin_pct,
       m.prep_min AS kitchen_min,
       COUNT(DISTINCT oi.order_id) AS sold,
       ROUND(AVG(rv.rating)::numeric, 2) AS avg_rating
FROM menu_items m
JOIN restaurants r   ON r.restaurant_id = m.restaurant_id AND r.name = 'Trattoria Aurora'
LEFT JOIN order_items oi ON oi.menu_item_id = m.menu_item_id
LEFT JOIN reviews rv     ON rv.order_id = oi.order_id
GROUP BY m.name, m.price, m.food_cost, m.prep_min
ORDER BY sold DESC
LIMIT 6;

\echo ''
\echo '=== STORY 3: couriers, ride time vs rating ==='
SELECT c.full_name AS courier,
       COUNT(d.delivery_id) AS deliveries,
       ROUND(AVG(EXTRACT(EPOCH FROM (d.delivered_at - d.picked_up_at))/60)::numeric, 1) AS avg_ride_min,
       ROUND(AVG(rv.rating)::numeric, 2) AS avg_rating
FROM deliveries d
JOIN couriers c      ON c.courier_id = d.courier_id
LEFT JOIN reviews rv ON rv.order_id = d.order_id
GROUP BY c.full_name
HAVING COUNT(d.delivery_id) > 40
ORDER BY avg_ride_min
LIMIT 5;
