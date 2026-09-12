// Tests for batched push notifications (the real server code from worker.js,
// run in a vm with a mock D1 database).
//
// - recordActivity() queues events but sends nothing immediately
// - flushDuePushes() sends exactly one push per batch after quiet
// - reconcileBatch() drops deleted/un-bought/un-claimed items from the count
//   (Johan's "added 5, deleted them, added 1 more -> 6 items added" bug)
// - batches whose items are all gone are dropped silently (no push)
// - pre-migrate8 (no push_sent_at column) falls back to an immediate push
//
// Run: node test-push-batch.js   (exit 0 = all pass)
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const marker = '\nconst PAGE = `';
const serverSrc = src.slice(0, src.indexOf(marker));
if (!serverSrc || serverSrc.includes('export default')) {
  console.error('FAIL: could not extract server code block');
  process.exit(1);
}

// ---------------- mock D1 ----------------
function makeDb(withPushSentCol = true) {
  const db = {
    _events: [],
    _items: [],
    _subs: [],
    _withCol: withPushSentCol,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ');
      const st = {
        _b: [],
        bind(...a) { st._b = a; return st; },
        first() { return run('first'); },
        all() { return run('all'); },
        run() { return run('run'); },
      };
      function run() {
        const b = st._b;
        // column probe
        if (q === 'SELECT push_sent_at FROM notification_events LIMIT 0') {
          if (!db._withCol) throw new Error('no such column: push_sent_at');
          return { results: [] };
        }
        // upsertEvent: find open batch
        if (q.startsWith('SELECT id, count, names FROM notification_events WHERE actor = ?')) {
          const [actor, kind, windowStart] = b;
          const rows = db._events
            .filter(e => e.actor === actor && e.kind === kind && e.updated_at > windowStart &&
              (!db._withCol || e.push_sent_at == null))
            .sort((x, y) => (x.updated_at > y.updated_at ? -1 : x.updated_at < y.updated_at ? 1 : 0));
          return rows[0] || null;
        }
        // upsertEvent: coalesce update
        if (q.startsWith('UPDATE notification_events SET body = ?, count = ?, names = ?, updated_at = ?')) {
          const [body, count, names, now, id] = b;
          const e = db._events.find(e => e.id === id);
          if (e) {
            e.body = body; e.count = count; e.names = names; e.updated_at = now;
            if (q.includes('push_sent_at = NULL')) e.push_sent_at = null;
          }
          return { meta: { changes: e ? 1 : 0 } };
        }
        // upsertEvent: insert
        if (q.startsWith('INSERT INTO notification_events')) {
          const [id, actor, kind, body, count, names, created_at, updated_at] = b;
          db._events.push({ id, actor, kind, body, count, names, created_at, updated_at,
            push_sent_at: db._withCol ? null : undefined });
          return { meta: { changes: 1 } };
        }
        // reconcileBatch: add
        if (q.startsWith('SELECT name FROM items WHERE added_by = ?')) {
          const [actor, ts] = b;
          const rows = db._items
            .filter(i => i.added_by === actor && i.created_at >= ts)
            .sort((x, y) => (x.created_at > y.created_at ? 1 : -1));
          return { results: rows.map(i => ({ name: i.name })) };
        }
        // reconcileBatch: purchase
        if (q.startsWith('SELECT name FROM items WHERE purchased_by = ?')) {
          const [actor, ts] = b;
          const rows = db._items
            .filter(i => i.purchased_by === actor && i.checked === 1 && i.purchased_at >= ts)
            .sort((x, y) => (x.purchased_at > y.purchased_at ? 1 : -1));
          return { results: rows.map(i => ({ name: i.name })) };
        }
        // reconcileBatch: claim
        if (q.startsWith('SELECT name FROM items WHERE claimed_by = ?')) {
          const [actor, ts] = b;
          const rows = db._items
            .filter(i => i.claimed_by === actor && i.claimed_at >= ts)
            .sort((x, y) => (x.claimed_at > y.claimed_at ? 1 : -1));
          return { results: rows.map(i => ({ name: i.name })) };
        }
        // flushDuePushes: due batches
        if (q.startsWith('SELECT id, actor, kind, body, count, created_at, updated_at FROM notification_events WHERE push_sent_at IS NULL AND updated_at <=')) {
          const [cutoff] = b;
          return { results: db._events.filter(e => e.push_sent_at == null && e.updated_at <= cutoff) };
        }
        // flushDuePushes: drop emptied batch
        if (q === 'DELETE FROM notification_events WHERE id = ? AND updated_at = ? AND push_sent_at IS NULL') {
          const [id, updated_at] = b;
          const ix = db._events.findIndex(e => e.id === id && e.updated_at === updated_at && e.push_sent_at == null);
          if (ix >= 0) db._events.splice(ix, 1);
          return { meta: { changes: ix >= 0 ? 1 : 0 } };
        }
        // flushDuePushes: corrected body
        if (q.startsWith('UPDATE notification_events SET body = ?, count = ?, names = ? WHERE id = ?')) {
          const [body, count, names, id, updated_at] = b;
          const e = db._events.find(e => e.id === id && e.updated_at === updated_at && e.push_sent_at == null);
          if (e) { e.body = body; e.count = count; e.names = names; }
          return { meta: { changes: e ? 1 : 0 } };
        }
        // flushDuePushes: claim batch
        if (q.startsWith('UPDATE notification_events SET push_sent_at = ? WHERE id = ?')) {
          const [ts, id, updated_at] = b;
          const e = db._events.find(e => e.id === id && e.updated_at === updated_at && e.push_sent_at == null);
          if (e) e.push_sent_at = ts;
          return { meta: { changes: e ? 1 : 0 } };
        }
        // fanoutPush: subscriptions
        if (q.startsWith('SELECT endpoint, p256dh, auth, name FROM push_subscriptions')) {
          return { results: db._subs.slice() };
        }
        if (q.startsWith('DELETE FROM push_subscriptions WHERE endpoint = ?')) {
          const [endpoint] = b;
          db._subs = db._subs.filter(s => s.endpoint !== endpoint);
          return { meta: { changes: 1 } };
        }
        throw new Error('unmocked SQL: ' + q);
      }
      return st;
    },
  };
  return db;
}

// ---------------- vm sandbox ----------------
const sandbox = { console, crypto: webcrypto, __pushes: [] };
vm.createContext(sandbox);
vm.runInContext(serverSrc, sandbox, { filename: 'worker-server.js' });
// Stub the real Web Push crypto: capture pushes instead of sending.
vm.runInContext(`
  sendPush = async function (env, sub, payload) {
    globalThis.__pushes.push({ to: sub.endpoint, forName: sub.name, title: payload.title, body: payload.body });
    return 201;
  };
  globalThis.__api = { recordActivity, flushDuePushes };
`, sandbox);
const api = sandbox.__api;

// ---------------- helpers ----------------
const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log('ok   ' + name); }
  else { console.error('FAIL ' + name + (detail ? ' — ' + detail : '')); failures.push(name); }
}
const nowIso = () => new Date().toISOString();
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

function freshEnv(withCol = true) {
  vm.runInContext('HAS_PUSH_SENT_COL = null;', sandbox); // reset column probe cache
  sandbox.__pushes.length = 0;
  const db = makeDb(withCol);
  db._subs.push(
    { endpoint: 'https://push.example/johan', p256dh: 'x', auth: 'y', name: 'Johan' },
    { endpoint: 'https://push.example/krista', p256dh: 'x', auth: 'y', name: 'Krista' },
  );
  return { db, env: { DB: db, VAPID_PRIVATE_JWK: 'fake-jwk', LIST_SECRET: 's' } };
}
// Simulate the quiet period elapsing for an actor's open batch.
function ageBatch(db, actor, kind, ms = 60000) {
  const e = db._events.find(e => e.actor === actor && e.kind === kind && e.push_sent_at == null);
  if (e) e.updated_at = agoIso(ms);
}
function addItem(db, id, name, by) {
  // Production stamps the item a few ms BEFORE the batch row (the item insert
  // is awaited before recordActivity runs). Simulate that skew: without it the
  // test passes by same-millisecond luck and misses the reconcile bug.
  db._items.push({ id, name, added_by: by, created_at: new Date(Date.now() - 50).toISOString(), checked: 0 });
}
function delItem(db, id) {
  db._items = db._items.filter(i => i.id !== id);
}

// ---------------- tests ----------------
async function testOnePushPerBurst() {
  const { db, env } = freshEnv();
  addItem(db, 'i1', 'Milk', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Milk', { store: 'either' });
  addItem(db, 'i2', 'Bread', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Bread', { store: 'either' });
  addItem(db, 'i3', 'Eggs', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Eggs', { store: 'either' });
  check('burst: no push sent immediately', sandbox.__pushes.length === 0,
    'got ' + sandbox.__pushes.length);
  await api.flushDuePushes(env);
  check('burst: still quiet-gated (no push before quiet)', sandbox.__pushes.length === 0,
    'got ' + sandbox.__pushes.length);
  ageBatch(db, 'Johan', 'add');
  await api.flushDuePushes(env);
  check('burst: exactly one push after quiet', sandbox.__pushes.length === 1,
    'got ' + sandbox.__pushes.length);
  const p = sandbox.__pushes[0];
  check('burst: body names all three items', p && p.body === 'Johan added 3 items: "Milk", "Bread", "Eggs"',
    'got ' + JSON.stringify(p && p.body));
  check('burst: not sent to the actor', p && p.to === 'https://push.example/krista',
    'got ' + JSON.stringify(p && p.to));
  await api.flushDuePushes(env);
  check('burst: second flush does not re-push', sandbox.__pushes.length === 1,
    'got ' + sandbox.__pushes.length);
}

async function testDeletedItemsDontCount() {
  const { db, env } = freshEnv();
  // Johan's scenario: add 5, delete them all, add 1 more.
  for (let n = 1; n <= 5; n++) {
    addItem(db, 'd' + n, 'Item' + n, 'Johan');
    await api.recordActivity(env, 'Johan', 'add', 'Item' + n, { store: 'either' });
  }
  for (let n = 1; n <= 5; n++) delItem(db, 'd' + n);
  addItem(db, 'd6', 'Milk', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Milk', { store: 'either' });
  const before = db._events.find(e => e.actor === 'Johan' && e.kind === 'add');
  check('delete: batch counted 6 before flush', before && before.count === 6,
    'got ' + JSON.stringify(before && before.count));
  ageBatch(db, 'Johan', 'add');
  await api.flushDuePushes(env);
  check('delete: exactly one push', sandbox.__pushes.length === 1,
    'got ' + sandbox.__pushes.length);
  const p = sandbox.__pushes[0];
  check('delete: push says 1 item, not 6', p && p.body === 'Johan added "Milk"',
    'got ' + JSON.stringify(p && p.body));
}

async function testAllDeletedDropsSilently() {
  const { db, env } = freshEnv();
  addItem(db, 'x1', 'Milk', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Milk', { store: 'either' });
  addItem(db, 'x2', 'Bread', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Bread', { store: 'either' });
  delItem(db, 'x1'); delItem(db, 'x2');
  ageBatch(db, 'Johan', 'add');
  await api.flushDuePushes(env);
  check('all-deleted: no push at all', sandbox.__pushes.length === 0,
    'got ' + sandbox.__pushes.length);
  check('all-deleted: batch row removed', !db._events.some(e => e.push_sent_at == null),
    'stale batch remains');
}

async function testPurchaseReconcile() {
  const { db, env } = freshEnv();
  for (let n = 1; n <= 3; n++) {
    db._items.push({ id: 'p' + n, name: 'P' + n, purchased_by: 'Krista',
      purchased_at: new Date(Date.now() - 50 + n).toISOString(), checked: 1 });
    await api.recordActivity(env, 'Krista', 'purchase', 'P' + n, {});
  }
  db._items.find(i => i.id === 'p3').checked = 0; // un-buy one before the flush
  ageBatch(db, 'Krista', 'purchase');
  await api.flushDuePushes(env);
  const p = sandbox.__pushes[0];
  check('purchase: one push', sandbox.__pushes.length === 1, 'got ' + sandbox.__pushes.length);
  check('purchase: un-bought item excluded', p && p.body === 'Krista bought 2 items: "P1", "P2"',
    'got ' + JSON.stringify(p && p.body));
  check('purchase: not sent to the actor', p && p.to === 'https://push.example/johan',
    'got ' + JSON.stringify(p && p.to));
}

async function testPreMigrationFallback() {
  const { db, env } = freshEnv(false); // no push_sent_at column
  addItem(db, 'm1', 'Milk', 'Johan');
  await api.recordActivity(env, 'Johan', 'add', 'Milk', { store: 'either' });
  check('pre-migration: immediate push fallback', sandbox.__pushes.length === 1,
    'got ' + sandbox.__pushes.length);
  check('pre-migration: unbatched body', sandbox.__pushes[0].body === 'Johan added "Milk"',
    'got ' + JSON.stringify(sandbox.__pushes[0].body));
  await api.flushDuePushes(env);
  check('pre-migration: cron flush is a no-op', sandbox.__pushes.length === 1,
    'got ' + sandbox.__pushes.length);
}

await testPreMigrationFallback(); // first: probe cache starts empty
await testOnePushPerBurst();
await testDeletedItemsDontCount();
await testAllDeletedDropsSilently();
await testPurchaseReconcile();

if (failures.length) {
  console.error('\n' + failures.length + ' FAILURE(S)');
  process.exit(1);
}
console.log('\nAll push-batch tests passed.');
