'use strict';

// Forkly operations console. Plain fetch + DOM, no framework, because this is
// meant to read like an app somebody wrote three years ago and still runs.

const $ = (sel) => document.querySelector(sel);
const get = (url) => fetch(url).then(r => r.json());

const nf = new Intl.NumberFormat('en-US');
const money = (v) => v == null ? '—' : '$' + nf.format(Math.round(v));
const num = (v, d = 0) => v == null ? '—' : Number(v).toFixed(d);

const stars = (r) => r == null
  ? '<span class="muted">—</span>'
  : `<span class="stars">${'★'.repeat(Math.round(r))}<span class="off">${'★'.repeat(5 - Math.round(r))}</span></span>`;

const clock = () => {
  $('#clock').textContent = new Date().toLocaleTimeString('en-GB');
};
clock();
setInterval(clock, 1000);

// ---------------------------------------------------------------- KPI row

async function loadKpis() {
  const s = await get('/api/summary');
  // Four numbers, not six. The console should read as a real product, and
  // real products do not put every available metric on the same row.
  $('#kpis').innerHTML = [
    ['Orders (60 days)', nf.format(s.orders_total), 'across 8 zones'],
    ['Avg delivery',     num(s.avg_delivery_min, 1) + '<span class="unit"> min</span>', 'placed to delivered'],
    ['Avg rating',       num(s.avg_rating, 2),      'all reviews'],
    ['GMV',              money(s.gmv),              'delivered orders'],
  ].map(([label, value, sub], i) => `
    <div class="kpi">
      <div class="k-label">${label}</div>
      <div class="k-value${i === 3 ? ' accent' : ''}">${value}</div>
      <div class="k-sub">${sub}</div>
    </div>`).join('');
}

// ------------------------------------------------------------------ views

const VIEWS = {
  orders: {
    title: 'Live orders',
    sub: 'Most recent orders across every zone.',
    url: '/api/orders?limit=120',
    // The one and only piece of "insight" this app offers: paint a row red
    // when a delivery took over 65 minutes. Turning that into an explanation
    // is a human with a spreadsheet.
    foot: 'Rows highlighted in red took over 65 minutes end to end.',
    cols: [
      ['Placed',     r => `<span class="mono">${new Date(r.placed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>`],
      ['Restaurant', r => `<span class="strong">${r.restaurant}</span>`],
      ['Zone',       r => `<span class="pill zone">${r.zone}</span>`],
      ['Courier',    r => r.courier ? r.courier : '<span class="muted">—</span>'],
      ['Total',      r => money(r.subtotal), 'num'],
      ['Minutes',    r => r.total_min == null ? '—' : Math.round(r.total_min), 'num'],
      ['Rating',     r => stars(r.rating)],
    ],
    rowClass: r => (r.total_min > 65 ? 'late' : ''),
    cellClass: (r, i) => (i === 5 && r.total_min > 65 ? 'bad' : ''),
    search: r => `${r.order_id} ${r.restaurant} ${r.zone} ${r.courier || ''} ${r.status}`,
  },

  restaurants: {
    title: 'Restaurants',
    sub: 'Promised prep time against what the kitchen actually does.',
    url: '/api/restaurants',
    foot: 'Actual prep is measured from order placed to courier pickup.',
    cols: [
      ['Restaurant', r => `<span class="strong">${r.name}</span>`],
      ['Cuisine',    r => `<span class="muted">${r.cuisine}</span>`],
      ['Zone',       r => `<span class="pill zone">${r.zone}</span>`],
      ['Orders',     r => nf.format(r.orders), 'num'],
      ['Promised',   r => r.promised_prep_min + ' min', 'num'],
      ['Actual',     r => (r.actual_prep_min == null ? '—' : r.actual_prep_min + ' min'), 'num'],
      ['Rating',     r => stars(r.rating)],
    ],
    cellClass: (r, i) => (i === 5 && r.actual_prep_min > r.promised_prep_min * 1.4 ? 'warn' : ''),
    search: r => `${r.name} ${r.cuisine} ${r.zone}`,
  },

  couriers: {
    title: 'Couriers',
    sub: 'Ride time from pickup to hand-off, and how customers rate it.',
    url: '/api/couriers',
    foot: 'Ride time excludes any waiting at the restaurant.',
    cols: [
      ['Courier',    r => `<span class="strong">${r.full_name}</span>`],
      ['Vehicle',    r => `<span class="muted">${r.vehicle}</span>`],
      ['Home zone',  r => `<span class="pill zone">${r.zone}</span>`],
      ['Deliveries', r => nf.format(r.deliveries), 'num'],
      ['Avg ride',   r => (r.avg_ride_min == null ? '—' : r.avg_ride_min + ' min'), 'num'],
      ['Rating',     r => stars(r.rating)],
    ],
    cellClass: (r, i) => (i === 5 && r.rating != null && r.rating < 3.5 ? 'bad' : ''),
    search: r => `${r.full_name} ${r.vehicle} ${r.zone}`,
  },

  reviews: {
    title: 'Reviews',
    sub: 'What customers actually wrote, newest first.',
    url: '/api/reviews?limit=120',
    foot: 'Free text. Nobody on the ops team reads all of it.',
    cols: [
      ['When',       r => `<span class="mono">${new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>`],
      ['Restaurant', r => `<span class="strong">${r.restaurant}</span>`],
      ['Zone',       r => `<span class="pill zone">${r.zone}</span>`],
      ['Rating',     r => stars(r.rating)],
      ['Comment',    r => r.comment || '<span class="muted">—</span>', 'wide'],
    ],
    rowClass: r => (r.rating <= 2 ? 'late' : ''),
    search: r => `${r.restaurant} ${r.zone} ${r.comment || ''}`,
  },
};

let current = 'orders';
let rows = [];

async function loadView(name) {
  current = name;
  const v = VIEWS[name];
  $('#panelTitle').textContent = v.title;
  $('#panelSub').textContent = v.sub;
  $('#panelfoot').textContent = v.foot;
  $('#filter').value = '';
  $('#thead').innerHTML = `<tr>${v.cols.map(c => `<th class="${c[2] === 'num' ? 'num' : ''}">${c[0]}</th>`).join('')}</tr>`;
  $('#tbody').innerHTML = `<tr><td colspan="${v.cols.length}" style="padding:26px;text-align:center;color:var(--dim)">Loading…</td></tr>`;
  rows = await get(v.url);
  render();
}

function render() {
  const v = VIEWS[current];
  const term = $('#filter').value.trim().toLowerCase();
  const shown = term ? rows.filter(r => v.search(r).toLowerCase().includes(term)) : rows;

  $('#rowcount').textContent = `${nf.format(shown.length)} row${shown.length === 1 ? '' : 's'}`;

  if (!shown.length) {
    $('#tbody').innerHTML = `<tr><td colspan="${v.cols.length}" style="padding:26px;text-align:center;color:var(--dim)">Nothing matches “${term}”.</td></tr>`;
    return;
  }

  $('#tbody').innerHTML = shown.map(r => {
    const cls = v.rowClass ? v.rowClass(r) : '';
    const tds = v.cols.map((c, i) => {
      const kind = c[2] === 'num' ? 'num' : (c[2] === 'wide' ? 'wide' : '');
      const extra = v.cellClass ? v.cellClass(r, i) : '';
      return `<td class="${kind} ${extra}">${c[1](r)}</td>`;
    }).join('');
    return `<tr class="${cls}">${tds}</tr>`;
  }).join('');
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
  loadView(btn.dataset.view);
});

$('#filter').addEventListener('input', render);

loadKpis();
loadView('orders');

// -------------------------------------------------------------------------
// Quill. The only part of the frontend that knows Quill exists. It polls the
// app's own backend for a widget URL; when one appears, so does the bubble,
// with no reload.
// -------------------------------------------------------------------------

let mounted = null;

// The reveal animation is deferred until this tab is visible. Quill is enabled
// on the pilot and Forkly is switched to afterwards, so firing on the state
// change alone means the animation finishes before anyone sees it. Gated on a
// mint this browser has not greeted yet plus a visible tab; otherwise the
// bubble is shown without animation.

const SEEN_KEY = 'forkly.quill.greeted';
const seen = () => { try { return sessionStorage.getItem(SEEN_KEY); } catch { return null; } };
const markSeen = v => { try { sessionStorage.setItem(SEEN_KEY, v); } catch {} };
const clearSeen = () => { try { sessionStorage.removeItem(SEEN_KEY); } catch {} };

let pendingReveal = null;   // mintedAt waiting for the tab to come forward

function reveal(mintedAt) {
  const l = $('#quill-launcher');
  l.hidden = false;
  l.classList.remove('reveal');
  void l.offsetWidth;              // restart the animation
  l.classList.add('reveal');
  $('#quill-teaser').hidden = false;
  setTimeout(() => { $('#quill-teaser').hidden = true; }, 6000);
  markSeen(mintedAt);
  pendingReveal = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingReveal) reveal(pendingReveal);
});

async function pollQuill() {
  try {
    const st = await get('/api/quill/status');

    if (st.attached && st.embedUrl) {
      if (st.embedUrl !== mounted) {
        mounted = st.embedUrl;
        $('#quill-frame').src = st.embedUrl;
      }
      const fresh = seen() !== st.mintedAt;
      if (fresh) {
        // Hold the reveal until this tab is in front of a human.
        if (document.hidden) { pendingReveal = st.mintedAt; $('#quill-launcher').hidden = true; }
        else reveal(st.mintedAt);
      } else {
        $('#quill-launcher').hidden = false;   // already greeted, no fanfare
      }
    }

    if (!st.attached && mounted) {
      mounted = null;
      pendingReveal = null;
      clearSeen();
      $('#quill-launcher').hidden = true;
      $('#quill-launcher').classList.remove('reveal');
      $('#quill-panel').hidden = true;
      $('#quill-teaser').hidden = true;
    }
  } catch { /* the app carries on regardless */ }
}

$('#quill-bubble').addEventListener('click', () => {
  const p = $('#quill-panel');
  p.hidden = !p.hidden;
});
$('#quill-close').addEventListener('click', () => { $('#quill-panel').hidden = true; });

pollQuill();
setInterval(pollQuill, 2000);
