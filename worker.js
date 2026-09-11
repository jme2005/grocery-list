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
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: #f4f2ec; color: #20241f; padding-bottom: 200px; }
  header { position: sticky; top: 0; z-index: 10; background: linear-gradient(150deg, #1d9a55 0%, #0e6b3a 60%, #0a4f2c 100%); color: #fff; padding: calc(16px + env(safe-area-inset-top)) 18px 16px; box-shadow: 0 2px 12px rgba(10,60,35,.35); }
  .headrow { display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
  .sub { font-size: 13px; opacity: .85; margin-top: 2px; font-weight: 500; }
  #whoBtn { border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.16); color: #fff; font-size: 14px; font-weight: 600; padding: 8px 14px; border-radius: 999px; cursor: pointer; transition: transform .12s ease; }
  #whoBtn:active { transform: scale(.94); }
  .chips { display: flex; gap: 8px; margin-top: 14px; }
  .chip { flex: 1; padding: 11px 0; border: none; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-size: 15px; font-weight: 700; text-align: center; cursor: pointer; transition: all .15s ease; }
  .chip.active { background: #fff; color: #0b5a34; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .section { margin: 20px 16px 0; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #979d94; }
  ul { list-style: none; margin: 10px 0 0; padding: 0 14px; }
  li { display: flex; align-items: center; gap: 12px; background: #fff; border-radius: 18px; padding: 14px 14px 14px 12px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(25,35,25,.05), 0 6px 18px rgba(25,35,25,.06); border-left: 5px solid #d8dcd4; }
  li.s-heb { border-left-color: #2f7de1; }
  li.s-tjs { border-left-color: #e05757; }
  li.s-either { border-left-color: #b9c2b5; }
  li.purchased { opacity: .65; }
  .check { width: 34px; height: 34px; border: 2px solid #c3cbc0; border-radius: 50%; flex: none; cursor: pointer; background: #fff; font-size: 18px; line-height: 1; color: #fff; transition: transform .12s ease, background .12s ease; }
  .check:active { transform: scale(.85); }
  li.purchased .check { background: #1d9a55; border-color: #1d9a55; }
  .mid { flex: 1; min-width: 0; }
  .name { font-size: 17px; font-weight: 600; letter-spacing: -0.2px; word-break: break-word; }
  li.purchased .name { text-decoration: line-through; color: #9a9d98; font-weight: 400; }
  .meta { font-size: 12.5px; color: #8f948c; margin-top: 3px; }
  .tag { flex: none; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; padding: 6px 10px; border-radius: 999px; background: #eef0ec; color: #6d746a; }
  .tag.heb { background: #e2efff; color: #1663cc; }
  .tag.tjs { background: #ffe6e6; color: #c74343; }
  .rowbtn { flex: none; border: none; background: none; font-size: 18px; color: #b3b8b0; padding: 8px 6px; cursor: pointer; }
  .empty { text-align: center; color: #9aa097; margin: 32px; font-size: 15px; line-height: 1.6; }
  footer { position: fixed; bottom: 12px; left: 12px; right: 12px; background: rgba(255,255,255,.98); border-radius: 22px; box-shadow: 0 8px 28px rgba(20,40,25,.16); padding: 12px 12px calc(12px + env(safe-area-inset-bottom)); }
  .addrow { display: flex; gap: 8px; margin-bottom: 10px; }
  #itemName { flex: 1; font-size: 17px; padding: 14px 16px; border: 1.5px solid #d5dad2; border-radius: 16px; background: #f7f9f5; outline: none; }
  #itemName:focus { border-color: #1d9a55; background: #fff; }
  #addBtn { font-size: 17px; font-weight: 800; padding: 14px 22px; border: none; border-radius: 16px; background: linear-gradient(150deg, #1d9a55, #0e6b3a); color: #fff; cursor: pointer; box-shadow: 0 3px 10px rgba(20,120,65,.35); transition: transform .12s ease; }
  #addBtn:active { transform: scale(.95); }
  .storepick { display: flex; gap: 8px; margin-bottom: 10px; }
  .storepick button { flex: 1; padding: 11px 0; font-size: 14px; font-weight: 700; border: 1.5px solid #d5dad2; border-radius: 14px; background: #fff; color: #4a5148; cursor: pointer; transition: all .12s ease; }
  .storepick button.active { background: #0e6b3a; color: #fff; border-color: #0e6b3a; }
  #clearBtn { width: 100%; border: none; background: none; color: #d05240; font-size: 15px; font-weight: 700; padding: 8px; cursor: pointer; }
  #err { display: none; background: #d05240; color: #fff; font-size: 14px; font-weight: 700; padding: 10px 16px; text-align: center; }
  .section { display: flex; align-items: center; justify-content: space-between; }
  #selectBtn { border: none; background: none; color: #1d9a55; font-size: 14px; font-weight: 800; cursor: pointer; padding: 4px 8px; }
  .selbox { display: none; width: 26px; height: 26px; border: 2px solid #c3cbc0; border-radius: 8px; flex: none; }
  body.selecting .selbox { display: block; }
  body.selecting li.selected .selbox { background: #1d9a55; border-color: #1d9a55; }
  body.selecting li.selected { background: #e9f5ee; }
  body.selecting .check, body.selecting .rowbtn { display: none; }
  .claimbtn.claimed { color: #1d9a55; }
  .claimedline { color: #1d9a55; font-weight: 600; }
  footer .bulkactions { display: none; }
  body.selecting footer .normal { display: none; }
  body.selecting footer .bulkactions { display: block; }
  .selcount { text-align: center; font-size: 14px; font-weight: 700; color: #4a5148; margin-bottom: 8px; }
  .abtns { display: flex; gap: 8px; }
  .abtns button { flex: 1; padding: 13px 0; font-size: 15px; font-weight: 800; border: none; border-radius: 14px; cursor: pointer; }
  #bulkClaim { background: #e2efff; color: #1663cc; }
  #bulkBuy { background: linear-gradient(150deg, #1d9a55, #0e6b3a); color: #fff; }
  #bulkDel { background: #ffe6e6; color: #c74343; }
  #bulkCancel { background: #eef0ec; color: #4a5148; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <div class="headrow">
    <div><h1>🧺 Grocery List</h1><div class="sub" id="buyCount"></div></div>
    <button id="whoBtn" aria-label="change name"></button>
  </div>
  <div class="chips" id="filters">
    <button class="chip active" data-f="all">All</button>
    <button class="chip" data-f="heb">H-E-B</button>
    <button class="chip" data-f="tjs">Trader Joe&rsquo;s</button>
  </div>
</header>
<div class="section"><span>To buy</span><button id="selectBtn">Select</button></div>
<ul id="list"></ul>
<div class="empty" id="empty" style="display:none">🛒 Nothing to buy yet.<br>Add something below.</div>
<div class="section" id="purchHead" style="display:none">Purchased</div>
<ul id="purchased"></ul>
<footer>
  <div class="normal">
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
  </div>
  <div class="bulkactions">
    <div class="selcount" id="selCount"></div>
    <div class="abtns">
      <button id="bulkClaim">Claim</button>
      <button id="bulkBuy">Buy</button>
      <button id="bulkDel">Delete</button>
      <button id="bulkCancel">Done</button>
    </div>
  </div>
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
  li.className = (purchased ? 'purchased ' : '') + 's-' + (it.store || 'either');
  if (selected[it.id]) li.classList.add('selected');
  li.onclick = function () {
    if (!selecting || purchased) return;
    if (selected[it.id]) delete selected[it.id]; else selected[it.id] = 1;
    li.classList.toggle('selected');
    updateSel();
  };
  var check = document.createElement('button');
  check.className = 'check';
  check.setAttribute('aria-label', purchased ? 'restore' : 'mark purchased');
  if (purchased) check.textContent = '\\u2713';
  check.onclick = function (e) { e.stopPropagation(); toggle(it, purchased); };
  var sel = document.createElement('span');
  sel.className = 'selbox';
  var mid = document.createElement('div');
  mid.className = 'mid';
  var name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = purchased ? purchMeta(it) : addedMeta(it);
  mid.appendChild(name); mid.appendChild(meta);
  if (!purchased && it.claimed_by) {
    var cl = document.createElement('div');
    cl.className = 'meta claimedline';
    cl.textContent = '\\uD83D\\uDE4B Claimed by ' + it.claimed_by + (it.claimed_at ? ' \\u00B7 ' + fmtDate(it.claimed_at) : '');
    mid.appendChild(cl);
  }
  var tag = document.createElement('span');
  tag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
  tag.textContent = storeLabel(it.store);
  li.appendChild(check); li.appendChild(sel); li.appendChild(mid); li.appendChild(tag);
  if (!purchased) {
    var claim = document.createElement('button');
    claim.className = 'rowbtn claimbtn' + (it.claimed_by ? ' claimed' : '');
    claim.textContent = '\\uD83D\\uDE4B';
    claim.setAttribute('aria-label', 'claim');
    claim.title = it.claimed_by ? 'Claimed by ' + it.claimed_by : 'Claim this item';
    claim.onclick = function (e) { e.stopPropagation(); claimItem(it); };
    li.appendChild(claim);
  }
  var del = document.createElement('button');
  del.className = 'rowbtn';
  del.textContent = '\\u00D7';
  del.setAttribute('aria-label', 'delete');
  del.onclick = function (e) { e.stopPropagation(); remove(it); };
  li.appendChild(del);
  return li;
}

function claimItem(it) {
  var body = it.claimed_by ? { claimed: 0 } : { claimed: 1, claimed_by: who };
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}

var selecting = false;
var selected = {};
function updateSel() {
  var n = Object.keys(selected).length;
  document.getElementById('selCount').textContent = n === 0 ? 'Tap items to select' : n + ' selected';
}
function endSelect() {
  selecting = false; selected = {};
  document.body.classList.remove('selecting');
  render();
}
document.getElementById('selectBtn').onclick = function () {
  selecting = true; selected = {};
  document.body.classList.add('selecting');
  render(); updateSel();
};
function bulkOp(op, confirmMsg) {
  var ids = Object.keys(selected);
  if (!ids.length) return;
  if (confirmMsg && !confirm(confirmMsg)) return;
  api('/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids, op: op, by: who }) })
    .then(function () { endSelect(); refresh(); })
    .catch(function () { showErr('Bulk update failed'); });
}
document.getElementById('bulkClaim').onclick = function () { bulkOp('claim'); };
document.getElementById('bulkBuy').onclick = function () {
  var n = Object.keys(selected).length;
  bulkOp('purchase', 'Mark ' + n + (n === 1 ? ' item' : ' items') + ' as purchased?');
};
document.getElementById('bulkDel').onclick = function () {
  var n = Object.keys(selected).length;
  bulkOp('delete', 'Delete ' + n + (n === 1 ? ' item' : ' items') + '?');
};
document.getElementById('bulkCancel').onclick = endSelect;

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
  var buyCount = document.getElementById('buyCount');
  buyCount.textContent = active.length === 0 ? 'All done 🎉' :
    active.length + (active.length === 1 ? ' item to buy' : ' items to buy');
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

  // POST /api/items/bulk — { ids: [...], op: 'claim'|'unclaim'|'purchase'|'restore'|'delete', by }
  if (rest.length === 1 && rest[0] === 'bulk') {
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter(function (x) { return typeof x === 'string'; }).slice(0, 200)
      : [];
    const op = body.op;
    const by = (body.by || '').toString().trim().slice(0, 60) || null;
    if (!ids.length) return badRequest('ids required');
    if (['claim', 'unclaim', 'purchase', 'restore', 'delete'].indexOf(op) < 0) return badRequest('bad op');
    const now = new Date().toISOString();
    const stmts = ids.map(function (id) {
      switch (op) {
        case 'claim': return db.prepare('UPDATE items SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?').bind(by, now, now, id);
        case 'unclaim': return db.prepare('UPDATE items SET claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'purchase': return db.prepare('UPDATE items SET checked = 1, purchased_by = ?, purchased_at = ?, updated_at = ? WHERE id = ?').bind(by, now, now, id);
        case 'restore': return db.prepare('UPDATE items SET checked = 0, purchased_by = NULL, purchased_at = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'delete': return db.prepare('DELETE FROM items WHERE id = ?').bind(id);
      }
    });
    await db.batch(stmts);
    return json({ ok: true, count: ids.length });
  }

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
        .prepare('SELECT id, name, store, checked, added_by, claimed_by, claimed_at, created_at, updated_at, purchased_by, purchased_at FROM items ORDER BY checked ASC, created_at ASC')
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
      if (body.claimed !== undefined) {
        if (body.claimed) {
          const claimedBy = (body.claimed_by || '').toString().trim().slice(0, 60) || null;
          sets.push('claimed_by = ?'); binds.push(claimedBy);
          sets.push('claimed_at = ?'); binds.push(new Date().toISOString());
        } else {
          sets.push('claimed_by = NULL');
          sets.push('claimed_at = NULL');
        }
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
