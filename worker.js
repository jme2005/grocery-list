// Shared family grocery list — Cloudflare Worker + D1.
//
// Access control: every route (page and API) lives under a secret first path
// segment, e.g. /{LIST_SECRET}/ and /{LIST_SECRET}/api/items. The secret is
// provided via the LIST_SECRET environment variable (wrangler secret put).
// Anything without the correct segment gets a 404. No accounts, no logins —
// Johan and Krista open the same secret link on both phones. Each phone picks
// a display name once (stored in localStorage) so items can show who added
// and who purchased them.

const STORES = ['heb', 'tjs', 'either'];
const STORE_LABEL = { heb: 'H-E-B', tjs: "Trader Joe's", either: 'Either' };

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Grocery List</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: #eef3ee; color: #1c1c1e; padding-bottom: 170px; }
  header { position: sticky; top: 0; z-index: 10; background: linear-gradient(135deg, #157f47, #0b5a34); color: #fff; padding: calc(14px + env(safe-area-inset-top)) 16px 14px; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
  .headrow { display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
  #whoBtn { border: 1px solid rgba(255,255,255,.5); background: rgba(255,255,255,.15); color: #fff; font-size: 14px; padding: 7px 12px; border-radius: 999px; cursor: pointer; }
  .chips { display: flex; gap: 8px; margin-top: 12px; }
  .chip { flex: 1; padding: 10px 0; border: none; border-radius: 999px; background: rgba(255,255,255,.18); color: #fff; font-size: 15px; font-weight: 600; text-align: center; cursor: pointer; }
  .chip.active { background: #fff; color: #0b5a34; }
  .section { margin: 18px 12px 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: #6b7a6f; }
  ul { list-style: none; margin: 8px 0 0; padding: 0 12px; }
  li { display: flex; align-items: center; gap: 12px; background: #fff; border-radius: 16px; padding: 13px 14px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(20,40,25,.08); }
  li.purchased { opacity: .75; }
  .check { width: 32px; height: 32px; border: 2px solid #c4cec6; border-radius: 50%; flex: none; cursor: pointer; background: #fff; font-size: 18px; line-height: 1; color: #fff; }
  li.purchased .check { background: #1a9e54; border-color: #1a9e54; }
  .mid { flex: 1; min-width: 0; }
  .name { font-size: 17px; font-weight: 600; word-break: break-word; }
  li.purchased .name { text-decoration: line-through; color: #8e8e93; font-weight: 400; }
  .meta { font-size: 12.5px; color: #8a938c; margin-top: 3px; }
  .tag { flex: none; font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 999px; background: #eef0ee; color: #636366; }
  .tag.heb { background: #e3efff; color: #0a5fd7; }
  .tag.tjs { background: #ffe7e7; color: #c0392b; }
  .rowbtn { flex: none; border: none; background: none; font-size: 17px; color: #a7b0a9; padding: 8px 6px; cursor: pointer; }
  .empty { text-align: center; color: #8a938c; margin: 28px 24px; font-size: 15px; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); border-top: 1px solid #dde4dd; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
  .addrow { display: flex; gap: 8px; margin-bottom: 8px; }
  #itemName { flex: 1; font-size: 17px; padding: 13px 14px; border: 1px solid #cfd8d0; border-radius: 14px; background: #f7faf7; }
  #addBtn { font-size: 17px; font-weight: 700; padding: 13px 20px; border: none; border-radius: 14px; background: #157f47; color: #fff; cursor: pointer; }
  .storepick { display: flex; gap: 8px; margin-bottom: 8px; }
  .storepick button { flex: 1; padding: 10px 0; font-size: 14px; font-weight: 600; border: 1px solid #cfd8d0; border-radius: 12px; background: #fff; color: #3c443e; cursor: pointer; }
  .storepick button.active { background: #157f47; color: #fff; border-color: #157f47; }
  #clearBtn { width: 100%; border: none; background: none; color: #d43d2a; font-size: 15px; font-weight: 600; padding: 6px; cursor: pointer; }
  #err { display: none; background: #d43d2a; color: #fff; font-size: 14px; font-weight: 600; padding: 10px 16px; text-align: center; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <div class="headrow">
    <h1>Grocery List</h1>
    <button id="whoBtn" aria-label="change name"></button>
  </div>
  <div class="chips" id="filters">
    <button class="chip active" data-f="all">All</button>
    <button class="chip" data-f="heb">H-E-B</button>
    <button class="chip" data-f="tjs">Trader Joe&rsquo;s</button>
  </div>
</header>
<div class="section" id="buyHead">To buy</div>
<ul id="list"></ul>
<div class="empty" id="empty" style="display:none">Nothing to buy. Add something below.</div>
<div class="section" id="purchHead" style="display:none">Purchased</div>
<ul id="purchased"></ul>
<footer>
  <div class="storepick" id="storepick">
    <button data-s="either" class="active">Either</button>
    <button data-s="heb">H-E-B</button>
    <button data-s="tjs">Trader Joe&rsquo;s</button>
  </div>
  <div class="addrow">
    <input id="itemName" type="text" placeholder="Add an item&hellip;" autocomplete="off" enterkeyhint="done">
    <button id="addBtn">Add</button>
  </div>
  <button id="clearBtn">Clear purchased</button>
</footer>
<script>
var filter = 'all';
var addStore = 'either';
var items = [];
var who = localStorage.getItem('groceryWho') || '';
var listEl = document.getElementById('list');
var purchEl = document.getElementById('purchased');
var emptyEl = document.getElementById('empty');
var purchHead = document.getElementById('purchHead');
var errEl = document.getElementById('err');
var whoBtn = document.getElementById('whoBtn');

function ensureWho() {
  if (!who) {
    var n = prompt('Your name (shown on items you add/buy):', '');
    if (n && n.trim()) { who = n.trim(); localStorage.setItem('groceryWho', who); }
    else { who = 'Someone'; }
  }
  whoBtn.textContent = who;
}
whoBtn.onclick = function () {
  var n = prompt('Your name:', who);
  if (n && n.trim()) { who = n.trim(); localStorage.setItem('groceryWho', who); whoBtn.textContent = who; }
};
ensureWho();

function api(path, opts) {
  return fetch('api/items' + path, opts).then(function (r) {
    if (!r.ok) throw new Error('Request failed');
    return r.json();
  });
}
function showErr(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
  setTimeout(function () { errEl.style.display = 'none'; }, 3000);
}
function storeLabel(s) { return s === 'heb' ? 'H-E-B' : (s === 'tjs' ? "Trader Joe's" : 'Either'); }
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function addedMeta(it) {
  var d = fmtDate(it.created_at);
  if (it.added_by && d) return 'Added by ' + it.added_by + ' · ' + d;
  if (d) return 'Added ' + d;
  return '';
}
function purchMeta(it) {
  var d = fmtDate(it.purchased_at);
  if (it.purchased_by && d) return 'Purchased by ' + it.purchased_by + ' · ' + d;
  if (d) return 'Purchased ' + d;
  return 'Purchased';
}

function makeRow(it, purchased) {
  var li = document.createElement('li');
  if (purchased) li.className = 'purchased';
  var check = document.createElement('button');
  check.className = 'check';
  check.setAttribute('aria-label', purchased ? 'restore' : 'mark purchased');
  if (purchased) check.textContent = '\\u2713';
  check.onclick = function () { toggle(it, purchased); };
  var mid = document.createElement('div');
  mid.className = 'mid';
  var name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = purchased ? purchMeta(it) : addedMeta(it);
  mid.appendChild(name); mid.appendChild(meta);
  var tag = document.createElement('span');
  tag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
  tag.textContent = storeLabel(it.store);
  var del = document.createElement('button');
  del.className = 'rowbtn';
  del.textContent = '\\u00D7';
  del.setAttribute('aria-label', 'delete');
  del.onclick = function () { remove(it); };
  li.appendChild(check); li.appendChild(mid); li.appendChild(tag); li.appendChild(del);
  return li;
}

function render() {
  listEl.innerHTML = '';
  purchEl.innerHTML = '';
  var active = items.filter(function (it) {
    return !it.checked && (filter === 'all' || it.store === 'either' || it.store === filter);
  });
  var bought = items.filter(function (it) { return it.checked; });
  active.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
  bought.sort(function (a, b) { return (a.purchased_at || '') < (b.purchased_at || '') ? 1 : -1; });
  emptyEl.style.display = active.length ? 'none' : 'block';
  active.forEach(function (it) { listEl.appendChild(makeRow(it, false)); });
  purchHead.style.display = bought.length ? 'block' : 'none';
  purchHead.textContent = 'Purchased (' + bought.length + ')';
  bought.forEach(function (it) { purchEl.appendChild(makeRow(it, true)); });
}

function refresh() {
  api('').then(function (data) { items = data; render(); })
    .catch(function () { showErr('Could not sync list'); });
}
function toggle(it, purchased) {
  if (!purchased && !confirm('Marked as purchased?')) return;
  var body = purchased
    ? { checked: 0 }
    : { checked: 1, purchased_by: who };
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}
function remove(it) {
  if (!confirm('Remove "' + it.name + '"?')) return;
  api('/' + it.id, { method: 'DELETE' }).then(refresh)
    .catch(function () { showErr('Could not delete item'); });
}
function addItem() {
  var input = document.getElementById('itemName');
  var name = input.value.trim();
  if (!name) return;
  api('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, store: addStore, added_by: who }) })
    .then(function () { input.value = ''; refresh(); })
    .catch(function () { showErr('Could not add item'); });
}

document.getElementById('filters').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  filter = b.getAttribute('data-f');
  var chips = this.querySelectorAll('button');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  b.classList.add('active');
  render();
});
document.getElementById('storepick').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  addStore = b.getAttribute('data-s');
  var btns = this.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
  b.classList.add('active');
});
document.getElementById('addBtn').onclick = addItem;
document.getElementById('itemName').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') addItem();
});
document.getElementById('clearBtn').onclick = function () {
  if (!items.some(function (it) { return it.checked; })) return;
  if (!confirm('Remove all purchased items?')) return;
  api('/clear-checked', { method: 'POST' }).then(refresh)
    .catch(function () { showErr('Could not clear purchased'); });
};

refresh();
setInterval(refresh, 10000); // near-live sync between the two phones
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) refresh();
});
</script>
</body>
</html>`;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

async function handleApi(request, env, rest) {
  const method = request.method;
  const db = env.DB;

  // POST /api/items/clear-checked
  if (rest.length === 1 && rest[0] === 'clear-checked') {
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    await db.prepare('DELETE FROM items WHERE checked = 1').run();
    return json({ ok: true });
  }

  // GET /api/items  |  POST /api/items
  if (rest.length === 0) {
    if (method === 'GET') {
      const rows = await db
        .prepare('SELECT id, name, store, checked, added_by, created_at, updated_at, purchased_by, purchased_at FROM items ORDER BY checked ASC, created_at ASC')
        .all();
      return json(rows.results || []);
    }
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
      const name = (body.name || '').toString().trim();
      const store = (body.store || 'either').toString();
      const addedBy = (body.added_by || '').toString().trim().slice(0, 60) || null;
      if (!name) return badRequest('name is required');
      if (!STORES.includes(store)) return badRequest('store must be heb, tjs, or either');
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO items (id, name, store, checked, added_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .bind(id, name, store, addedBy, now, now)
        .run();
      return json({ id, name, store, checked: 0, added_by: addedBy, created_at: now, updated_at: now }, 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  // PATCH /api/items/:id  |  DELETE /api/items/:id
  if (rest.length === 1) {
    const id = rest[0];
    if (method === 'PATCH') {
      let body;
      try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
      const sets = [];
      const binds = [];
      if (body.name !== undefined) {
        const name = body.name.toString().trim();
        if (!name) return badRequest('name cannot be empty');
        sets.push('name = ?'); binds.push(name);
      }
      if (body.store !== undefined) {
        const store = body.store.toString();
        if (!STORES.includes(store)) return badRequest('store must be heb, tjs, or either');
        sets.push('store = ?'); binds.push(store);
      }
      if (body.checked !== undefined) {
        const checked = body.checked ? 1 : 0;
        sets.push('checked = ?'); binds.push(checked);
        if (checked) {
          const purchasedBy = (body.purchased_by || '').toString().trim().slice(0, 60) || null;
          sets.push('purchased_by = ?'); binds.push(purchasedBy);
          sets.push('purchased_at = ?'); binds.push(new Date().toISOString());
        } else {
          sets.push('purchased_by = NULL');
          sets.push('purchased_at = NULL');
        }
      }
      if (sets.length === 0) return badRequest('nothing to update');
      sets.push('updated_at = ?');
      binds.push(new Date().toISOString(), id);
      const res = await db
        .prepare('UPDATE items SET ' + sets.join(', ') + ' WHERE id = ?')
        .bind(...binds)
        .run();
      if (res.meta.changes === 0) return json({ error: 'Not found' }, 404);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const res = await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
      if (res.meta.changes === 0) return json({ error: 'Not found' }, 404);
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Secret gate: first path segment must equal LIST_SECRET.
    if (!env.LIST_SECRET || parts.length === 0 || parts[0] !== env.LIST_SECRET) {
      return new Response('Not found', { status: 404 });
    }

    const rest = parts.slice(1);
    if (rest.length === 0) {
      // Canonicalize to a trailing slash so relative API fetches resolve.
      if (!url.pathname.endsWith('/')) {
        return Response.redirect(url.pathname + '/' + url.search, 301);
      }
      return new Response(PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (rest[0] === 'api' && rest[1] === 'items') {
      return handleApi(request, env, rest.slice(2));
    }
    return new Response('Not found', { status: 404 });
  },
};
