'use strict';

// Pilot deck. Every number is fetched live and the Enable button performs a
// real call. The pilot talks only to Forkly's backend, never to Quill directly,
// because that would put the API key in the browser.

const APP = 'http://localhost:3000';
const $ = (s) => document.querySelector(s);

const jget = (p) => fetch(APP + p).then(r => r.json());
const nf = new Intl.NumberFormat('en-US');

let state = { docs: null, orders: null, tookMs: null };

// ------------------------------------------------------------------ status

function setDot(el, ok, text) {
  el.classList.remove('wait', 'ok', 'bad');
  el.classList.add(ok ? 'ok' : 'bad');
  el.lastChild.textContent = text;
}

async function refresh() {
  const summary = await jget('/api/summary').catch(() => null);
  if (summary) {
    state.orders = Number(summary.orders_total);
    setDot($('#dotApp'), true, `app · ${nf.format(state.orders)} orders`);
  } else {
    setDot($('#dotApp'), false, 'app unreachable');
  }

  const health = await jget('/api/quill/health').catch(() => null);
  if (health?.ok) setDot($('#dotQuill'), true, `Quill · ${health.tookMs} ms`);
  else setDot($('#dotQuill'), false, `Quill · ${health?.reason || 'unreachable'}`);

  const cols = await jget('/api/quill/collections').catch(() => null);
  if (cols?.ok) {
    state.docs = cols.total;
    $('#docCount').textContent = nf.format(cols.total);
    setDot($('#dotData'), true, `data · ${nf.format(cols.total)} documents`);
  } else {
    setDot($('#dotData'), false, 'data · not mirrored');
  }

  const st = await jget('/api/quill/status').catch(() => null);
  if (st) applyStatus(st);
  punch();
}

function applyStatus(st) {
  if (st.dashboardUrl) $('#openDash').href = st.dashboardUrl;

  const btn = $('#enable');
  const label = btn.querySelector('.label');

  if (!st.configured) {
    $('#setupBox').hidden = false;
    $('#setupText').textContent =
      `Source, mapping and ingest are done. The model connection, agent and channel are not. Missing: ${st.missing.join(', ')}.`;
    btn.disabled = true;
    btn.classList.remove('done');
    label.textContent = 'Enable Quill';
    return;
  }

  $('#setupBox').hidden = true;
  if (!btn.classList.contains('busy')) btn.disabled = false;

  if (st.attached && st.pilotUrl) {
    mountChat(st.pilotUrl);
    if (!btn.classList.contains('done')) {
      btn.classList.add('done');
      label.textContent = 'Quill is live';
    }
  }
}

// ------------------------------------------------------------------- chat

function mountChat(url) {
  const box = $('#chatframe');
  if (box.dataset.url === url) return;
  box.dataset.url = url;
  box.innerHTML = '';
  const f = document.createElement('iframe');
  f.src = url;
  f.title = 'Forkly Assistant';
  f.setAttribute('allow', 'clipboard-write');
  box.appendChild(f);
  $('#act3').classList.remove('locked');
}

// ----------------------------------------------------------------- enable

$('#enable').addEventListener('click', async () => {
  const btn = $('#enable');
  const label = btn.querySelector('.label');
  btn.disabled = true;
  btn.classList.add('busy');
  label.textContent = 'Minting links';
  $('#raw').hidden = true;
  $('#rawToggle').hidden = true;
  $('#result').hidden = true;
  document.querySelectorAll('#result .rrow').forEach(r => r.classList.remove('in'));
  $('#took').hidden = true;

  const t0 = performance.now();
  let body;
  try {
    const res = await fetch(APP + '/api/quill/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 3600, maxInvocations: 100 }),
    });
    body = await res.json();
  } catch (err) {
    body = { error: err.message };
  }
  const wall = Math.round(performance.now() - t0);

  btn.classList.remove('busy');
  $('#raw').textContent = JSON.stringify(body, null, 2);

  // On failure the payload is the message, so show it outright. On success it
  // is noise for the room this deck is built for, and hides behind a toggle.
  if (!body || body.error) {
    $('#raw').hidden = false;
    $('#raw').classList.add('err');
    btn.disabled = false;
    label.textContent = 'Enable Quill';
    return;
  }

  $('#raw').classList.remove('err');
  // The ticks land one at a time. All three appearing together reads as a
  // static block; staggered, it reads as work completing in front of you.
  $('#result').hidden = false;
  document.querySelectorAll('#result .rrow').forEach((row, i) => {
    row.classList.remove('in');
    setTimeout(() => row.classList.add('in'), 260 + i * 420);
  });
  $('#rmeta').textContent =
    'Both links stay valid for 60 minutes, 100 questions each. Nothing was deployed and no app code changed.';
  $('#rawToggle').hidden = false;
  state.tookMs = body.tookMs ?? wall;
  $('#took').hidden = false;
  $('#took').textContent = `Done in ${state.tookMs} ms.`;

  btn.classList.add('done');
  label.textContent = 'Quill is live';
  document.querySelectorAll('.act')[1].classList.add('done');

  mountChat(body.pilotUrl);
  punch();
});

// ------------------------------------------------------------------ punch

function punch() {
  const cards = [
    [state.orders == null ? '…' : nf.format(state.orders), 'rows in Postgres'],
    [state.docs   == null ? '…' : nf.format(state.docs),   'mirrored'],
    [state.tookMs == null ? 'not yet' : state.tookMs + ' ms', 'to attach'],
    ['0', 'lines of app code changed'],
  ];
  $('#punch').innerHTML = cards
    .map(([v, t]) => `<div class="tcard"><div class="v">${v}</div><div class="t">${t}</div></div>`)
    .join('');
}

punch();
refresh();
setInterval(refresh, 5000);

// ------------------------------------------------------------------ reset
//
// Puts the demo back to how the audience must first see it: no links, no
// bubble in Forkly, act 3 locked again. The attach state lives on the app
// server, so without this it survives page reloads and the bubble is already
// there when the presenter opens Forkly for the "before" shot.

$('#reset').addEventListener('click', async () => {
  const btn = $('#reset');
  btn.disabled = true;
  btn.textContent = 'resetting…';
  try {
    await fetch(APP + '/api/quill/detach', { method: 'POST' });
  } catch (e) {
    btn.textContent = 'reset failed';
    btn.disabled = false;
    return;
  }

  // Wind the page back to its opening state.
  state.tookMs = null;
  const enable = $('#enable');
  enable.classList.remove('done');
  enable.disabled = false;
  enable.querySelector('.label').textContent = 'Enable Quill';
  $('#took').hidden = true;
  $('#raw').hidden = true;
  $('#rawToggle').hidden = true;
  $('#rawToggle').textContent = 'technical detail';
  $('#result').hidden = true;
  document.querySelectorAll('#result .rrow').forEach(r => r.classList.remove('in'));
  document.querySelectorAll('.act').forEach(a => a.classList.remove('done'));
  $('#act3').classList.add('locked');
  $('#chatframe').innerHTML = '<div class="chatempty">Enable Quill to load the assistant.</div>';
  punch();

  btn.textContent = 'reset demo';
  btn.disabled = false;
  await refresh();
});

// The engineer in the room still gets the receipts, just not by default.
$('#rawToggle').addEventListener('click', () => {
  const raw = $('#raw');
  raw.hidden = !raw.hidden;
  $('#rawToggle').textContent = raw.hidden ? 'technical detail' : 'hide detail';
});


// ------------------------------------------------------- sample questions
//
// Clicking a chip copies it. It cannot type into the chat for us: the widget
// runs in a cross-origin iframe on public.<domain>, it registers no window
// message listener and reads no URL parameters, so the parent page has no
// supported way in. Checked against the served embed page, not assumed.
//
// So we do the next best thing: copy, confirm on the chip itself, and put
// focus on the chat frame so the paste is a single keystroke away.

async function copyAsk(btn) {
  const text = btn.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; localhost qualifies, but keep a
    // fallback so a presenter on some other host is not left stuck.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }

  document.querySelectorAll('.ask.copied').forEach(b => b.classList.remove('copied'));
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1800);

  const frame = document.querySelector('#chatframe iframe');
  if (frame) frame.focus();
}

document.querySelectorAll('.ask').forEach(b => b.addEventListener('click', () => copyAsk(b)));
