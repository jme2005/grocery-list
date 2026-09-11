// Shared family grocery list — Cloudflare Worker + D1.
//
// Access control: every route (page and API) lives under a secret first path
// segment, e.g. /{LIST_SECRET}/ and /{LIST_SECRET}/api/items. The secret is
// provided via the LIST_SECRET environment variable (wrangler secret put).
// Anything without the correct segment gets a 404. No accounts, no logins —
// Johan and Krista open the same secret link on both phones.

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
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #f6f6f4; color: #1c1c1e; padding-bottom: 120px; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e5e5; padding: 12px 16px calc(12px + env(safe-area-inset-top)); padding-top: calc(12px + env(safe-area-inset-top)); z-index: 10; }
  h1 { margin: 0 0 10px; font-size: 20px; }
  .chips { display: flex; gap: 8px; }
  .chip { flex: 1; padding: 10px 0; border: 1px solid #d1d1d6; border-radius: 999px; background: #fff; font-size: 15px; text-align: center; cursor: pointer; }
  .chip.active { background: #1c1c1e; color: #fff; border-color: #1c1c1e; }
  ul { list-style: none; margin: 0; padding: 12px 12px 0; }
  li { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 14px; padding: 14px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  li.done .name { text-decoration: line-through; color: #8e8e93; }
  .check { width: 30px; height: 30px; border: 2px solid #c7c7cc; border-radius: 50%; flex: none; cursor: pointer; background: #fff; }
  li.done .check { background: #34c759; border-color: #34c759; }
  .name { flex: 1; font-size: 17px; word-break: break-word; }
  .tag { flex: none; font-size: 12px; padding: 4px 8px; border-radius: 999px; background: #efeff4; color: #636366; }
  .tag.heb { background: #e8f2ff; color: #0a5fd7; }
  .tag.tjs { background: #ffe9e9; color: #c0392b; }
  .rowbtn { flex: none; border: none; background: none; font-size: 16px; color: #8e8e93; padding: 8px; cursor: pointer; }
  .empty { text-align: center; color: #8e8e93; margin-top: 48px; font-size: 16px; padding: 0 24px; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #e5e5e5; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
  .addrow { display: flex; gap: 8px; margin-bottom: 8px; }
  #itemName { flex: 1; font-size: 17px; padding: 12px; border: 1px solid #d1d1d6; border-radius: 12px; }
  #addBtn { font-size: 17px; padding: 12px 18px; border: none; border-radius: 12px; background: #007aff; color: #fff; cursor: pointer; }
  .storepick { display: flex; gap: 8px; margin-bottom: 8px; }
  .storepick button { flex: 1; padding: 9px 0; font-size: 14px; border: 1px solid #d1d1d6; border-radius: 10px; background: #fff; cursor: pointer; }
  .storepick button.active { background: #007aff; color: #fff; border-color: #007aff; }
  #clearBtn { width: 100%; border: none; background: none; color: #ff3b30; font-size: 15px; padding: 6px; cursor: pointer; }
  #err { display: none; background: #ff3b30; color: #fff; font-size: 14px; padding: 8px 16px; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <h1>Grocery List</h1>
  <div class="chips" id="filters">
    <button class="chip active" data-f="all">All</button>
    <button class="chip" data-f="heb">H-E-B</button>
    <button class="chip" data-f="tjs">Trader Joe&rsquo;s</button>
  </div>
</header>
<ul id="list"></ul>
<div class="empty" id="empty" style="display:none">Nothing here. Add something below.</div>
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
  <button id="clearBtn">Clear checked</button>
</footer>
<script>
var filter = 'all';
var addStore = 'either';
var items = [];
var listEl = document.getElementById('list');
var emptyEl = document.getElementById('empty');
var errEl = document.getElementById('err');

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

function render() {
  listEl.innerHTML = '';
  var visible = items.filter(function (it) {
    return filter === 'all' || it.store === 'either' || it.store === filter;
  });
  visible.sort(function (a, b) {
    if (a.checked !== b.checked) return a.checked - b.checked;
    return a.created_at < b.created_at ? -1 : 1;
  });
  emptyEl.style.display = visible.length ? 'none' : 'block';
  visible.forEach(function (it) {
    var li = document.createElement('li');
    if (it.checked) li.className = 'done';
    var check = document.createElement('button');
    check.className = 'check';
    check.setAttribute('aria-label', 'toggle');
    check.onclick = function () { toggle(it); };
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;
    var tag = document.createElement('span');
    tag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
    tag.textContent = storeLabel(it.store);
    var edit = document.createElement('button');
    edit.className = 'rowbtn';
    edit.textContent = '\\u270E';
    edit.setAttribute('aria-label', 'edit');
    edit.onclick = function () { editItem(it); };
    var del = document.createElement('button');
    del.className = 'rowbtn';
    del.textContent = '\\u00D7';
    del.setAttribute('aria-label', 'delete');
    del.onclick = function () { remove(it); };
    li.appendChild(check); li.appendChild(name); li.appendChild(tag);
    li.appendChild(edit); li.appendChild(del);
    listEl.appendChild(li);
  });
}

function refresh() {
  api('').then(function (data) { items = data; render(); })
    .catch(function () { showErr('Could not sync list'); });
}
function toggle(it) {
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checked: it.checked ? 0 : 1 }) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}
function remove(it) {
  if (!confirm('Remove "' + it.name + '"?')) return;
  api('/' + it.id, { method: 'DELETE' }).then(refresh)
    .catch(function () { showErr('Could not delete item'); });
}
function editItem(it) {
  var name = prompt('Item name', it.name);
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  var store = prompt("Store: heb, tjs, or either", it.store);
  if (store === null) return;
  store = store.trim().toLowerCase();
  if (['heb', 'tjs', 'either'].indexOf(store) < 0) store = it.store;
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, store: store }) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}
function addItem() {
  var input = document.getElementById('itemName');
  var name = input.value.trim();
  if (!name) return;
  api('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, store: addStore }) })
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
  if (!confirm('Remove all checked items?')) return;
  api('/clear-checked', { method: 'POST' }).then(refresh)
    .catch(function () { showErr('Could not clear checked'); });
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
        .prepare('SELECT id, name, store, checked, created_at, updated_at FROM items ORDER BY checked ASC, created_at ASC')
        .all();
      return json(rows.results || []);
    }
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
      const name = (body.name || '').toString().trim();
      const store = (body.store || 'either').toString();
      if (!name) return badRequest('name is required');
      if (!STORES.includes(store)) return badRequest('store must be heb, tjs, or either');
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO items (id, name, store, checked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .bind(id, name, store, now, now)
        .run();
      return json({ id, name, store, checked: 0, created_at: now, updated_at: now }, 201);
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
