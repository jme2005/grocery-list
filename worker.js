// Shared family grocery list — Cloudflare Worker + D1.
//
// Access control: every route (page and API) lives under a secret first path
// segment, e.g. /{LIST_SECRET}/ and /{LIST_SECRET}/api/items. The secret is
// provided via the LIST_SECRET environment variable (wrangler secret put).
// Anything without the correct segment gets a 404. No accounts, no logins —
// Johan and Krista open the same secret link on both phones. Each phone picks
// a display name once (stored in localStorage) so items can show who added
// and who purchased them.

const STORES = ['heb', 'tjs', 'costco', 'either'];
const STORE_LABEL = { heb: 'H-E-B', tjs: "Trader Joe's", costco: 'Costco', either: 'Either' };

// Service worker for Web Push. Served at /{LIST_SECRET}/sw.js so it stays
// same-origin with the page. Registered only when the user taps the bell.
const SW_JS = `self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Grocery List', {
      body: data.body || ''
    }).then(function () {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    }).then(function (clis) {
      clis.forEach(function (c) { try { c.postMessage({ type: 'push' }); } catch (e) {} });
    })
  );
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(self.registration.scope));
});
`;

// ---- Web Push sending (RFC 8291 aes128gcm + RFC 8292 VAPID) ----
// Server-side only: this code runs in the worker, NOT inside the PAGE
// template literal, so escapes are plain JavaScript ('\0' is a NUL byte,
// /\+/ matches a literal plus). Do not move it into PAGE without doubling
// every backslash (see the Sep 11, 2026 outage).
// The private VAPID key is a secret and is never committed:
//   npx wrangler secret put VAPID_PRIVATE_JWK
const VAPID_PUBLIC_KEY = 'BFoQfkwwjzJKXqOqvzuieNMEH9w12Ire-X6F1vvGMwnpnF7rsJ_qMy6_fD4g4o2f5EMvZtDSTOwNEKmnVd7-XI4';
const VAPID_SUBJECT = 'mailto:johan.m.edvinsson@gmail.com';

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

// RFC 5869, explicit extract/expand so each step's salt and info stay exact.
async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}
async function hkdfExpand(prk, info, len) {
  const out = new Uint8Array(len);
  let t = new Uint8Array(0);
  let pos = 0;
  let counter = 1;
  while (pos < len) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[input.length - 1] = counter;
    t = await hmacSha256(prk, input);
    const take = Math.min(t.length, len - pos);
    out.set(t.subarray(0, take), pos);
    pos += take;
    counter++;
  }
  return out;
}

// RFC 8291 section 3.4: "aes128gcm" content encoding.
async function encryptPushPayload(p256dhB64, authB64, payload) {
  const uaPub = b64urlDecode(p256dhB64);   // browser's public key, 65 bytes
  const authSecret = b64urlDecode(authB64); // 16 bytes
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)); // 65 bytes

  const te = new TextEncoder();
  const keyInfo = new Uint8Array(13 + 1 + 65 + 65);
  keyInfo.set(te.encode('WebPush: info'), 0);
  keyInfo[13] = 0; // NUL byte per RFC 8291
  keyInfo.set(uaPub, 14);
  keyInfo.set(asPub, 79);
  const ikm = await hkdfExpand(await hkdfExtract(authSecret, shared), keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cekInfo = te.encode('Content-Encoding: aes128gcm');
  const cekInfo0 = new Uint8Array(cekInfo.length + 1); cekInfo0.set(cekInfo, 0); // NUL-terminated
  const nonceInfo = te.encode('Content-Encoding: nonce');
  const nonceInfo0 = new Uint8Array(nonceInfo.length + 1); nonceInfo0.set(nonceInfo, 0);
  const cek = await hkdfExpand(prk, cekInfo0, 16);
  const nonce = await hkdfExpand(prk, nonceInfo0, 12);

  const data = te.encode(payload);
  const record = new Uint8Array(data.length + 1);
  record.set(data, 0);
  record[data.length] = 0x02; // padding delimiter, single-record message
  const rs = record.length;

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, record));

  const body = new Uint8Array(16 + 4 + 1 + 65 + ct.length);
  body.set(salt, 0);
  body[16] = (rs >>> 24) & 0xff;
  body[17] = (rs >>> 16) & 0xff;
  body[18] = (rs >>> 8) & 0xff;
  body[19] = rs & 0xff;
  body[20] = 65;
  body.set(asPub, 21);
  body.set(ct, 86);
  return { body };
}

// RFC 8292: VAPID Authorization header.
async function vapidAuthHeader(endpoint, env) {
  if (!env.VAPID_PRIVATE_JWK) throw new Error('missing VAPID_PRIVATE_JWK secret');
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: now + 43200, sub: VAPID_SUBJECT
  })));
  const unsigned = header + '.' + claims;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  return 'vapid t=' + unsigned + '.' + b64urlEncode(sig) + ', k=' + VAPID_PUBLIC_KEY;
}

async function sendPush(env, sub, payload) {
  const enc = await encryptPushPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization': await vapidAuthHeader(sub.endpoint, env),
      'TTL': '86400'
    },
    body: enc.body
  });
  return res.status;
}

// Coalescing window: events from the same actor+kind inside this window merge
// into one batch ("Johan added 3 items").
// Pushes are NOT sent immediately: flushDuePushes() (invoked by the cron
// trigger every minute) sends exactly one push per batch after PUSH_QUIET_MS
// with no new events from the actor — so a burst of adds is one notification,
// not one push per item that merely rewrites the first.
const EVENT_BATCH_MS = 3 * 60 * 1000;
const PUSH_QUIET_MS = 45 * 1000;

function buildEventBody(actor, kind, count, names, extra) {
  const list = names.length > 1 && names.length <= 3
    ? ': ' + names.map(function (n) { return '"' + n + '"'; }).join(', ') : '';
  if (kind === 'add') {
    const store = count === 1 && extra.store && extra.store !== 'either' ? ' · ' + STORE_LABEL[extra.store] : '';
    return count === 1 ? actor + ' added "' + (names[0] || '') + '"' + store
                       : actor + ' added ' + count + ' items' + list + store;
  }
  if (kind === 'purchase') {
    return count === 1 ? actor + ' bought "' + (names[0] || '') + '"'
                       : actor + ' bought ' + count + ' items' + list;
  }
  const when = extra.when ? ' · ' + extra.when : '';
  return count === 1 ? actor + ' will get "' + (names[0] || '') + '"' + when
                     : actor + ' will get ' + count + ' items' + list;
}

// migrate8.sql adds notification_events.push_sent_at. Probe for the column
// (cached per isolate once present) so this code works whether or not the
// migration has run yet.
let HAS_PUSH_SENT_COL = null;
async function hasPushSentCol(db) {
  if (HAS_PUSH_SENT_COL === true) return true;
  try {
    await db.prepare('SELECT push_sent_at FROM notification_events LIMIT 0').all();
    HAS_PUSH_SENT_COL = true;
    return true;
  } catch (e) {
    return false;
  }
}

// migrate9.sql adds items.qty/note/price/photo/claim_until and the staples
// table. Probe for the columns (cached per isolate once present) so this code
// works whether or not the migration has run yet.
let HAS_M9_COLS = null;
async function hasM9Cols(db) {
  if (HAS_M9_COLS === true) return true;
  try {
    await db.prepare('SELECT qty, note, price, photo, claim_until FROM items LIMIT 0').all();
    HAS_M9_COLS = true;
    return true;
  } catch (e) {
    return false;
  }
}

// Turn a claim "when" ("Monday", "tomorrow", ...) into an ISO datetime at
// which the claim auto-releases: end of that day. Unparseable input falls
// back to 24h from now.
function claimUntil(when, nowIso) {
  var base = nowIso ? new Date(nowIso) : new Date();
  if (isNaN(base.getTime())) base = new Date();
  var w = (when || '').toString().trim().toLowerCase();
  var days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var idx = -1;
  for (var i = 0; i < 7; i++) {
    if (w === days[i] || w === days[i].slice(0, 3)) { idx = i; break; }
  }
  var d = new Date(base.getTime());
  if (w === 'tomorrow') {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (w === 'today' || w === 'tonight') {
    // d is already today
  } else if (idx >= 0) {
    d.setUTCDate(d.getUTCDate() + ((idx - d.getUTCDay() + 7) % 7)); // 0 = today
  } else {
    return new Date(base.getTime() + 24 * 3600 * 1000).toISOString();
  }
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

// Record the event, coalescing with a recent same-actor+kind batch and
// re-arming its push (push_sent_at = NULL). Throws if the events table is
// missing (the caller falls back to an unbatched body so pushes work
// pre-migration).
async function upsertEvent(env, actor, kind, label, extra) {
  const now = new Date().toISOString();
  const count = extra.count || 1;
  const windowStart = new Date(Date.now() - EVENT_BATCH_MS).toISOString();
  const hasCol = await hasPushSentCol(env.DB);
  const sentFilter = hasCol ? 'AND push_sent_at IS NULL' : '';
  const rearm = hasCol ? ', push_sent_at = NULL' : '';
  const batch = await env.DB.prepare(
    'SELECT id, count, names FROM notification_events WHERE actor = ? AND kind = ? AND updated_at > ? ' + sentFilter + ' ORDER BY updated_at DESC LIMIT 1'
  ).bind(actor, kind, windowStart).first();
  let names, total, body;
  if (batch) {
    try { names = JSON.parse(batch.names || '[]'); } catch (e) { names = []; }
    if (label) names.push(label);
    names = names.slice(-6);
    total = (batch.count || 1) + count;
    body = buildEventBody(actor, kind, total, names, extra);
    await env.DB.prepare('UPDATE notification_events SET body = ?, count = ?, names = ?, updated_at = ?' + rearm + ' WHERE id = ?')
      .bind(body, total, JSON.stringify(names), now, batch.id).run();
    return body;
  }
  names = label ? [label] : [];
  total = count;
  body = buildEventBody(actor, kind, total, names, extra);
  await env.DB.prepare(
    'INSERT INTO notification_events (id, actor, kind, body, count, names, created_at, updated_at' + (hasCol ? ', push_sent_at' : '') + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?' + (hasCol ? ', NULL' : '') + ')'
  ).bind(crypto.randomUUID(), actor, kind, body, total, JSON.stringify(names), now, now).run();
  return body;
}

// Reconcile a pending batch against the items table so the push matches
// reality: things the actor added then deleted (un-bought, un-claimed) before
// the flush don't inflate the count. Returns { count, names }, or null when
// reconciliation isn't possible (flush with the stored body instead).
async function reconcileBatch(db, batch) {
  // The batch row is timestamped a few ms AFTER its items (same request, the
  // item insert is awaited first), so compare against a slightly earlier
  // bound — otherwise the batch's own items look older than the batch and
  // every batch reconciles to zero. The margin is safe: a same-actor item
  // from seconds before an open batch necessarily belongs to that batch
  // (anything older would have been flushed after 45s of quiet).
  const since = new Date(new Date(batch.created_at).getTime() - 10000).toISOString();
  let stmt;
  if (batch.kind === 'add') {
    stmt = db.prepare('SELECT name FROM items WHERE added_by = ? AND created_at >= ? ORDER BY created_at').bind(batch.actor, since);
  } else if (batch.kind === 'purchase') {
    stmt = db.prepare('SELECT name FROM items WHERE purchased_by = ? AND checked = 1 AND purchased_at >= ? ORDER BY purchased_at').bind(batch.actor, since);
  } else if (batch.kind === 'claim') {
    stmt = db.prepare('SELECT name FROM items WHERE claimed_by = ? AND claimed_at >= ? ORDER BY claimed_at').bind(batch.actor, since);
  } else {
    return null;
  }
  try {
    const rows = (await stmt.all()).results || [];
    const names = rows.map(function (r) { return r.name; });
    return { count: names.length, names: names.slice(-6) };
  } catch (e) {
    return null;
  }
}

// Send one push per batch that has seen no new events for PUSH_QUIET_MS.
// Reconciles counts against the items table, drops batches whose items are
// all gone, and claims each batch (push_sent_at) before pushing so a batch is
// never pushed twice.
async function flushDuePushes(env) {
  try {
    if (!env.VAPID_PRIVATE_JWK) return;
    if (!(await hasPushSentCol(env.DB))) return;
    const cutoff = new Date(Date.now() - PUSH_QUIET_MS).toISOString();
    const rows = (await env.DB.prepare(
      'SELECT id, actor, kind, body, count, created_at, updated_at FROM notification_events WHERE push_sent_at IS NULL AND updated_at <= ?'
    ).bind(cutoff).all()).results || [];
    for (const b of rows) {
      const rec = await reconcileBatch(env.DB, b);
      if (rec && rec.count === 0) {
        // Everything in this batch was undone (e.g. added then deleted):
        // drop it silently — unless a new event re-armed it meanwhile.
        await env.DB.prepare('DELETE FROM notification_events WHERE id = ? AND updated_at = ? AND push_sent_at IS NULL')
          .bind(b.id, b.updated_at).run();
        continue;
      }
      let body = b.body;
      if (rec && rec.count !== b.count) {
        body = buildEventBody(b.actor, b.kind, rec.count, rec.names, {});
        await env.DB.prepare('UPDATE notification_events SET body = ?, count = ?, names = ? WHERE id = ? AND updated_at = ? AND push_sent_at IS NULL')
          .bind(body, rec.count, JSON.stringify(rec.names), b.id, b.updated_at).run();
      }
      // Claim the batch before pushing; if a new event re-armed it meanwhile
      // (updated_at changed) this marks 0 rows and the next cron run flushes it.
      const marked = await env.DB.prepare('UPDATE notification_events SET push_sent_at = ? WHERE id = ? AND updated_at = ? AND push_sent_at IS NULL')
        .bind(new Date().toISOString(), b.id, b.updated_at).run();
      if (marked.meta.changes === 0) continue;
      await fanoutPush(env, b.actor, body);
    }
  } catch (e) { /* pushes must never break the worker */ }
}

// Delete purchased items older than 24 hours. Restored items have checked = 0
// (and purchased_at = NULL), so un-buying something saves it from the purge.
// COALESCE covers legacy rows where purchased_at was never set.
// Runs on the per-minute cron; never throws.
async function purgeOldPurchased(env) {
  try {
    await env.DB.prepare(
      "DELETE FROM items WHERE checked = 1 AND COALESCE(purchased_at, updated_at) < datetime('now', '-24 hours')"
    ).run();
  } catch (e) { /* purge must never break the worker */ }
}

// Release claims whose promised day has passed. Never throws.
async function releaseExpiredClaims(env) {
  try {
    var now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE items SET claimed_by = NULL, claimed_at = NULL, claim_when = NULL, claim_until = NULL, updated_at = ? WHERE claim_until IS NOT NULL AND claim_until < datetime('now')"
    ).bind(now).run();
  } catch (e) { /* expiry must never break the worker */ }
}

// Fan out one push to every subscribed device except the actor's own.
// Never throws: notification failures must not break the grocery API.
async function fanoutPush(env, actor, body) {
  try {
    if (!env.VAPID_PRIVATE_JWK) return;
    const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth, name FROM push_subscriptions').all();
    const subs = (rows.results || []).filter(s => s.name !== actor);
    if (!subs.length) return;
    const payload = { title: '🧺 Grocery List', body: body };
    await Promise.all(subs.map(async (s) => {
      try {
        const status = await sendPush(env, s, payload);
        if (status === 404 || status === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
        }
      } catch (e) { /* one bad subscription must not break the rest */ }
    }));
  } catch (e) { /* notifications must never break the API */ }
}

// Record activity for a later batched push. Before migrate8 runs (no
// push_sent_at column) this falls back to an immediate push so notifications
// keep working. Never throws: activity must never break the grocery API.
async function recordActivity(env, actor, kind, label, extra) {
  try {
    if (!actor || !kind) return;
    extra = extra || {};
    let body;
    try {
      body = await upsertEvent(env, actor, kind, label, extra);
    } catch (e) {
      body = buildEventBody(actor, kind, extra.count || 1, label ? [label] : [], extra);
    }
    if (!(await hasPushSentCol(env.DB))) {
      await fanoutPush(env, actor, body);
    }
    // Otherwise the cron flush (flushDuePushes) sends one push after quiet.
  } catch (e) { /* notifications must never break the API */ }
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0e6b3a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Grocery List">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%A7%BA</text></svg>">
<title>Grocery List</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; color: #20241f; padding-bottom: 200px;
    background: radial-gradient(120% 42% at 50% 0%, #faf8f1 0%, #f4f2ec 55%, #edebe3 100%); background-attachment: fixed; }
  :focus-visible { outline: 2px solid #1d9a55; outline-offset: 2px; }
  ::selection { background: #bfe6cf; }
  header { position: sticky; top: 0; z-index: 10; background: linear-gradient(150deg, #22a75e 0%, #0e6b3a 58%, #093f23 100%); color: #fff; padding: calc(16px + env(safe-area-inset-top)) 18px 16px; box-shadow: 0 2px 14px rgba(10,60,35,.38); border-bottom: 1px solid rgba(255,255,255,.14); }
  .headrow { display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; text-shadow: 0 1px 3px rgba(0,0,0,.22); }
  .sub { font-size: 13px; opacity: .85; margin-top: 2px; font-weight: 500; }
  #whoBtn { border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.16); color: #fff; font-size: 14px; font-weight: 600; padding: 8px 14px; border-radius: 999px; cursor: pointer; transition: transform .12s ease; }
  #whoBtn:active { transform: scale(.94); }
  .headbtns { display: flex; gap: 8px; align-items: center; }
  #bellBtn { border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.16); color: #fff; font-size: 17px; padding: 7px 11px; border-radius: 999px; cursor: pointer; opacity: .45; transition: opacity .15s ease, transform .12s ease; }
  #bellBtn.on { opacity: 1; }
  #bellBtn:active { transform: scale(.94); }
  .ver { text-align: center; font-size: 11px; opacity: .55; margin-top: 10px; }
  .chips { display: flex; gap: 8px; margin-top: 14px; }
  .chip { flex: 1; padding: 11px 0; border: none; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-size: 15px; font-weight: 700; text-align: center; cursor: pointer; transition: all .15s ease; }
  .chip.active { background: #fff; color: #0b5a34; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .section { margin: 22px 18px 0; font-size: 12.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.2px; color: #8a9187; }
  ul { list-style: none; margin: 10px 0 0; padding: 0 14px; }
  li { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; background: #fff; border-radius: 20px; padding: 14px 14px 14px 12px; margin-bottom: 10px; border-left: 5px solid #d8dcd4;
    box-shadow: 0 1px 2px rgba(25,35,25,.04), 0 8px 22px rgba(25,35,25,.07);
    transition: transform .15s ease, box-shadow .15s ease; }
  li:active { transform: scale(.985); }
  li.s-heb { border-left-color: #2f7de1; }
  li.s-tjs { border-left-color: #e05757; }
  li.s-costco { border-left-color: #123a7d; }
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
  .tag.costco { background: #e4ebfa; color: #1d3f8f; }
  .rowbtn { flex: none; border: none; background: none; font-size: 18px; color: #b3b8b0; padding: 8px 6px; cursor: pointer; }
  .empty { text-align: center; color: #9aa097; margin: 44px 32px; font-size: 15px; line-height: 1.7; }
  footer { position: fixed; bottom: 12px; left: 12px; right: 12px; background: rgba(255,255,255,.98); border-radius: 22px; border: 1px solid rgba(20,40,25,.07); box-shadow: 0 8px 28px rgba(20,40,25,.16), 0 2px 6px rgba(20,40,25,.08); padding: 12px 12px calc(12px + env(safe-area-inset-bottom)); }
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
  .actions { flex: 1 1 100%; display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .actions .spacer { flex: 1; }
  .abtn { border: 1.5px solid #d5dad2; background: #f7f9f5; border-radius: 12px; font-size: 14px; font-weight: 700; color: #4a5148; padding: 9px 14px; cursor: pointer; transition: transform .12s ease; }
  /* Quantities, staples, details, in-store mode, offline */
  #itemQty { width: 64px; flex: none; font-size: 17px; padding: 14px 10px; border: 1.5px solid #d5dad2; border-radius: 16px; background: #f7f9f5; outline: none; text-align: center; }
  #itemQty:focus { border-color: #1d9a55; background: #fff; }
  #recipeBtn { flex: none; font-size: 18px; padding: 12px 14px; border: 1.5px solid #d5dad2; border-radius: 16px; background: #f7f9f5; cursor: pointer; }
  .qwrap { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; vertical-align: middle; }
  .qbtn { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid #d5dad2; background: #f7f9f5; font-size: 17px; font-weight: 800; color: #0e6b3a; cursor: pointer; line-height: 1; }
  .qbadge { font-size: 14px; font-weight: 800; color: #0e6b3a; background: #e9f5ee; border-radius: 999px; padding: 4px 10px; white-space: nowrap; }
  button.qbadge.textq { border: 1.5px dashed #b9c4b6; background: none; color: #8a938a; cursor: pointer; }
  .noteline { color: #6b6250; font-style: italic; cursor: pointer; }
  .priceline { color: #0e6b3a; font-weight: 700; cursor: pointer; }
  .thumb { width: 44px; height: 44px; object-fit: cover; border-radius: 10px; margin-top: 6px; cursor: pointer; }
  .triptotal { font-weight: 700; color: #0e6b3a; }
  .staplesbtn { width: 100%; margin-top: 10px; border: 1.5px dashed #cfe3d6; background: #f4faf6; color: #0e6b3a; font-size: 15px; font-weight: 800; border-radius: 12px; padding: 12px; cursor: pointer; }
  .staplesbtn:active { transform: scale(.99); }
  .sheetCard.tall { max-height: 78vh; display: flex; flex-direction: column; }
  .staplelist { overflow-y: auto; -webkit-overflow-scrolling: touch; margin: 2px -4px; }
  .staplerow { display: flex; align-items: center; gap: 10px; padding: 11px 4px; border-bottom: 1px solid #eef2ee; }
  .stapleinfo { flex: 1; min-width: 0; }
  .staplename { font-weight: 700; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .staplemeta { font-size: 12px; color: #8a938a; margin-top: 2px; }
  .sadd { border: none; background: #0e6b3a; color: #fff; font-weight: 800; border-radius: 999px; padding: 10px 18px; font-size: 14px; cursor: pointer; flex: none; }
  .sadd:active { transform: scale(.96); }
  .sdel2 { border: none; background: #f3e2de; color: #b3402e; font-weight: 800; border-radius: 50%; width: 34px; height: 34px; font-size: 17px; line-height: 1; cursor: pointer; flex: none; }
  .dlabel { display: block; font-size: 14px; font-weight: 700; color: #4a5148; margin: 12px 0; }
  .dlabel input { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; font-size: 16px; padding: 12px; border: 1.5px solid #d5dad2; border-radius: 12px; outline: none; }
  .dlabel input:focus { border-color: #1d9a55; }
  .dpreview { width: 100%; max-height: 220px; object-fit: contain; border-radius: 12px; margin: 4px 0 8px; }
  #recipeText { width: 100%; box-sizing: border-box; font-size: 16px; padding: 12px; border: 1.5px solid #d5dad2; border-radius: 12px; outline: none; resize: vertical; }
  #recipeText:focus { border-color: #1d9a55; }
  .netbadge { border: none; background: #b7791f; color: #fff; font-size: 12px; font-weight: 800; border-radius: 999px; padding: 7px 11px; cursor: pointer; }
  .lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(10,15,12,.93); display: none; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 14px; box-shadow: 0 12px 48px rgba(0,0,0,.5); }
  #storeBtn.on { background: #0e6b3a; color: #fff; border-color: #0e6b3a; }
  body.instore { font-size: 19px; }
  body.instore li { padding: 20px 14px; }
  body.instore li .name { font-size: 23px; }
  body.instore .check { width: 62px; height: 62px; font-size: 30px; }
  body.instore .meta, body.instore .actions, body.instore .thumb { display: none; }
  body.instore .qbtn { width: 44px; height: 44px; font-size: 22px; }
  body.instore .qbadge { font-size: 18px; padding: 8px 14px; }
  .abtn:active { transform: scale(.95); }
  .urgentbtn.on { background: #ffe6e6; border-color: #e05240; color: #c74343; }
  .claimbtn.claimed { background: #e9f5ee; border-color: #1d9a55; color: #0e6b3a; }
  body.selecting .actions { display: none; }
  .claimedline { color: #1d9a55; font-weight: 600; }
  footer .bulkactions { display: none; }
  body.selecting footer .normal { display: none; }
  body.selecting footer .bulkactions { display: block; }
  .selcount { text-align: center; font-size: 14px; font-weight: 700; color: #4a5148; margin-bottom: 8px; }
  #bulkAll { background: none; border: none; color: #1663cc; font-size: 14px; font-weight: 700; cursor: pointer; padding: 2px 8px; }
  .abtns { display: flex; gap: 8px; }
  .abtns button { flex: 1; padding: 13px 0; font-size: 15px; font-weight: 800; border: none; border-radius: 14px; cursor: pointer; }
  #bulkClaim { background: #e2efff; color: #1663cc; }
  #bulkBuy { background: linear-gradient(150deg, #1d9a55, #0e6b3a); color: #fff; }
  #bulkDel { background: #ffe6e6; color: #c74343; }
  #bulkCancel { background: #eef0ec; color: #4a5148; }
  li.urgent { border-left-color: #e05240; background: #fff9f7; box-shadow: 0 1px 2px rgba(224,82,64,.14), 0 8px 22px rgba(224,82,64,.10); }
  .utag { flex: none; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; padding: 6px 10px; border-radius: 999px; background: #ffe6e6; color: #c74343; }
  #bulkUrgent { background: #fff3e0; color: #d97a1f; }
  #bellBtn { position: relative; }
  #bellBtn .dot { position: absolute; top: 5px; right: 7px; width: 9px; height: 9px; border-radius: 50%; background: #ff453a; border: 1.5px solid #0e6b3a; display: none; }
  #bellBtn.hasunseen .dot { display: block; }
  #actBanner { display: none; margin: 12px 16px 0; background: #fff; border-radius: 16px; box-shadow: 0 1px 2px rgba(25,35,25,.05), 0 6px 18px rgba(25,35,25,.06); padding: 4px 12px 6px; font-size: 14px; }
  #actBanner.show { display: block; }
  #actBanner .ahead { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; }
  #actBanner .atitle { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #979d94; }
  #actBanner .ax { border: none; background: none; font-size: 18px; line-height: 1; color: #b3b8b0; cursor: pointer; padding: 4px 2px; }
  #actBanner .arow { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid #f0f2ee; }
  #actBanner .arow:last-child { border-bottom: none; }
  #actBanner .abody { flex: 1; min-width: 0; }
  #actBanner .atime { color: #9aa097; font-size: 12px; flex: none; }
  .sheet { position: fixed; inset: 0; z-index: 50; background: rgba(20,30,22,.45); display: none; align-items: flex-end; justify-content: center; }
  .sheet.open { display: flex; }
  .sheetCard { background: #fff; border-radius: 22px 22px 0 0; width: 100%; max-width: 560px; max-height: 82vh; overflow-y: auto; padding: 6px 16px calc(20px + env(safe-area-inset-bottom)); animation: sheetup .18s ease-out; }
  .sheetCard::before { content: ''; display: block; width: 42px; height: 5px; border-radius: 999px; background: #dcded8; margin: 8px auto 2px; }
  @keyframes sheetup { from { transform: translateY(30px); opacity: .5; } to { transform: none; opacity: 1; } }
  .sheetHead { display: flex; align-items: center; justify-content: space-between; padding: 10px 0 2px; }
  .sheetHead .atitle { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #979d94; }
  .pushrow { display: flex; align-items: center; justify-content: space-between; width: 100%; border: none; background: #f4f6f3; border-radius: 14px; padding: 13px 14px; font-size: 16px; font-weight: 600; color: #20241f; cursor: pointer; margin: 8px 0 2px; font-family: inherit; }
  .pushrow .switch { width: 46px; height: 28px; border-radius: 999px; background: #c3cbc0; position: relative; transition: background .15s ease; flex: none; }
  .pushrow .knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: left .15s ease; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .pushrow.on .switch { background: #1d9a55; }
  .pushrow.on .knob { left: 21px; }
  .sheetSub { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #979d94; margin: 14px 0 2px; }
  .srow { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid #f0f2ee; font-size: 14.5px; }
  .srow:last-child { border-bottom: none; }
  .srow .abody { flex: 1; min-width: 0; }
  .srow.unseen .abody { font-weight: 700; }
  .srow .atime { color: #9aa097; font-size: 12px; flex: none; }
  .srow .udot { width: 8px; height: 8px; border-radius: 50%; background: #1d9a55; flex: none; }
  .sempty { color: #9aa097; font-size: 14px; padding: 14px 0; text-align: center; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <div class="headrow">
    <div><h1>🧺 Grocery List</h1><div class="sub" id="buyCount"></div></div>
    <span class="headbtns">
      <button id="netBadge" class="netbadge" style="display:none" title="queued changes"></button>
      <button id="storeBtn" aria-label="in-store mode" title="in-store mode">&#x1F3EC;</button>
      <button id="bellBtn" aria-label="notifications" title="notifications">&#128276;<span class="dot"></span></button>
      <button id="whoBtn" aria-label="change name"></button>
    </span>
  </div>
  <div class="chips" id="filters">
    <button class="chip active" data-f="all">All</button>
    <button class="chip" data-f="heb">H-E-B</button>
    <button class="chip" data-f="tjs">Trader Joe&rsquo;s</button>
    <button class="chip" data-f="costco">Costco</button>
  </div>
</header>
<div id="actBanner"></div>
<div class="section"><span>To buy<span id="tripTotal" class="triptotal"></span></span><button id="selectBtn">Select</button></div>
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
    <button data-s="costco">Costco</button>
  </div>
  <div class="addrow">
    <input id="itemName" type="text" placeholder="Add an item&hellip;" autocomplete="off" enterkeyhint="done">
    <input id="itemQty" type="text" placeholder="Qty" autocomplete="off" enterkeyhint="done">
    <button id="addBtn">Add</button>
    <button id="recipeBtn" title="import recipe">&#x1F4CB;</button>
  </div>
  <button id="staplesOpen" class="staplesbtn">&#128204; Staples</button>
  <button id="clearBtn">Clear purchased</button>
  <div class="ver" id="ver">v7 fullspread</div>
  </div>
  <div class="bulkactions">
    <div class="selcount"><span id="selCount"></span><button id="bulkAll">Select all</button></div>
    <div class="abtns">
      <button id="bulkClaim">Claim</button>
      <button id="bulkUrgent">Urgent</button>
      <button id="bulkBuy">Buy</button>
      <button id="bulkDel">Delete</button>
      <button id="bulkCancel">Done</button>
    </div>
  </div>
</footer>
<div id=\"bellSheet\" class=\"sheet\" role=\"dialog\" aria-label=\"Notifications\">
  <div class=\"sheetCard\">
    <div class=\"sheetHead\"><span class=\"atitle\">Notifications</span><button class=\"ax\" id=\"sheetX\" aria-label=\"close\">&times;</button></div>
    <button class=\"pushrow\" id=\"pushRow\" role=\"switch\" aria-checked=\"false\">
      <span>Push notifications</span>
      <span class=\"switch\"><span class=\"knob\"></span></span>
    </button>
    <div class=\"sheetSub\">Activity</div>
    <div id=\"sheetAct\"></div>
  </div>
</div>
<div id="detailSheet" class="sheet" role="dialog" aria-label="Item details">
  <div class="sheetCard">
    <div class="sheetHead"><span class="atitle" id="detailTitle">Item details</span><button class="ax" id="detailX" aria-label="close">&times;</button></div>
    <label class="dlabel">Note<input id="detailNote" type="text" maxlength="200" placeholder="e.g. organic only"></label>
    <label class="dlabel">Price estimate ($)<input id="detailPrice" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
    <label class="dlabel">Photo<input id="detailPhoto" type="file" accept="image/*"></label>
    <img id="detailPreview" class="dpreview" alt="" style="display:none">
    <div class="abtns">
      <button id="detailSave" class="abtn">Save</button>
      <button id="detailClearPhoto" class="abtn">Remove photo</button>
    </div>
  </div>
</div>
<div id="recipeSheet" class="sheet" role="dialog" aria-label="Import recipe">
  <div class="sheetCard">
    <div class="sheetHead"><span class="atitle">Import recipe</span><button class="ax" id="recipeX" aria-label="close">&times;</button></div>
    <div class="sheetSub">Paste ingredients, one per line</div>
    <textarea id="recipeText" rows="8" placeholder="2 cups flour&#10;3 eggs&#10;1 gal milk"></textarea>
    <div class="abtns"><button id="recipeAdd" class="abtn">Add items</button></div>
  </div>
</div>
<div id="lightbox" class="lightbox" role="dialog" aria-label="Photo viewer">
  <img id="lightboxImg" alt="">
</div>
<div id="stapleSheet" class="sheet" role="dialog" aria-label="Staples">
  <div class="sheetCard tall">
    <div class="sheetHead"><span class="atitle">Staples</span><button class="ax" id="stapleSheetX" aria-label="close">&times;</button></div>
    <div class="sheetSub">Tap Add to put a staple on the list</div>
    <div id="stapleList" class="staplelist"></div>
    <div class="abtns"><button id="stapleNew" class="abtn">&#65291; New staple</button></div>
  </div>
</div>
<script>
// If anything in this script throws on load, say so instead of looking dead.
window.onerror = function (msg) {
  var e = document.getElementById('err');
  if (e) { e.textContent = 'Page error: ' + msg; e.style.display = 'block'; }
};
function storeGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
var filter = 'all';
var addStore = 'either';
var items = [];
var who = storeGet('groceryWho');
var listEl = document.getElementById('list');
var purchEl = document.getElementById('purchased');
var emptyEl = document.getElementById('empty');
var purchHead = document.getElementById('purchHead');
var errEl = document.getElementById('err');
var whoBtn = document.getElementById('whoBtn');

function ensureWho() {
  if (!who) {
    var n = prompt('Your name (shown on items you add/buy):', '');
    if (n && n.trim()) { who = n.trim(); storeSet('groceryWho', who); }
    else { who = 'Someone'; }
  }
  whoBtn.textContent = who;
}
whoBtn.onclick = function () {
  var n = prompt('Your name:', who);
  if (n && n.trim()) { who = n.trim(); storeSet('groceryWho', who); whoBtn.textContent = who; }
};
ensureWho();

// ---- Notifications bell ----
// Tap-gated on purpose: no Push API or service-worker work happens until the
// user taps the bell. If this step breaks the page, the error banner above
// will say exactly which line failed.
var VAPID_PUBLIC_KEY = 'BFoQfkwwjzJKXqOqvzuieNMEH9w12Ire-X6F1vvGMwnpnF7rsJ_qMy6_fD4g4o2f5EMvZtDSTOwNEKmnVd7-XI4';
var bellBtn = document.getElementById('bellBtn');
var actBanner = document.getElementById('actBanner');
// Paint the last known bell state instantly; updateBell() below verifies it
// against the real subscription (passive read, no prompts).
if (storeGet('bellOn') === '1') bellBtn.classList.add('on');
function pushSupported() { return ('serviceWorker' in navigator) && ('PushManager' in window); }
function b64urlToBytes(b64) {
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bufToB64url(buf) {
  var bytes = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
if (!pushSupported()) { bellBtn.style.display = 'none'; }
// Debug tracer: persistent banner text so a phone tap can report each step.
function bellSay(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
}
async function postSubscription(sub) {
  await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint,
      keys: { p256dh: bufToB64url(sub.getKey('p256dh')), auth: bufToB64url(sub.getKey('auth')) },
      name: who }) });
}
async function updateBell() {
  try {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg ? await reg.pushManager.getSubscription() : null;
    bellBtn.classList.toggle('on', !!sub);
    storeSet('bellOn', sub ? '1' : '0');
  } catch (e) { bellSay('bell check FAILED: ' + (e && e.message || e)); }
}
async function toggleNotifications() {
  try {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await sub.unsubscribe();
      try {
        await api('/subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }) });
      } catch (e) { /* server cleanup is best effort */ }
      storeSet('bellOn', '0');
      updateBell();
      return;
    }
    if (!pushSupported()) { alert('Push notifications are not supported in this browser.'); return; }
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notifications are blocked. Allow them in Settings to get alerts.'); return; }
    reg = await navigator.serviceWorker.register('sw.js');
    reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) });
    await postSubscription(sub);
    storeSet('bellOn', '1');
    updateBell();
  } catch (e) { bellSay('bell FAILED: ' + (e && e.message || e)); }
}
bellBtn.onclick = openSheet;
// Passive subscription check on load: keeps the bell in sync after redeploys.
// getRegistration/getSubscription never prompt and register nothing.
updateBell();

// ---- Bell sheet: push toggle + activity ----
// Tapping the bell opens a panel: a push-notifications switch on top, then
// the recent activity feed. Opening the panel marks activity seen.
var sheet = document.getElementById('bellSheet');
var sheetAct = document.getElementById('sheetAct');
var pushRow = document.getElementById('pushRow');
var lastEvents = [];
function markSeen() {
  storeSet('seenTs', new Date().toISOString());
  actBanner.className = '';
  actBanner.innerHTML = '';
  bellBtn.classList.remove('hasunseen');
}
function syncPushRow() {
  var on = bellBtn.classList.contains('on');
  pushRow.classList.toggle('on', on);
  pushRow.setAttribute('aria-checked', on ? 'true' : 'false');
}
function renderSheetAct() {
  var seen = storeGet('seenTs') || '';
  var evs = lastEvents.slice(0, 15);
  var html = '';
  for (var i = 0; i < evs.length; i++) {
    var unseen = evs[i].updated_at > seen && (!who || evs[i].actor !== who);
    html += '<div class="srow' + (unseen ? ' unseen' : '') + '">' +
      (unseen ? '<span class="udot"></span>' : '') +
      '<span class="abody"></span><span class="atime">' + relTime(evs[i].updated_at) + '</span></div>';
  }
  sheetAct.innerHTML = html || '<div class="sempty">No activity yet.</div>';
  var bodies = sheetAct.querySelectorAll('.abody');
  for (var j = 0; j < evs.length; j++) { bodies[j].textContent = evs[j].body; }
}
async function openSheet() {
  syncPushRow();
  renderSheetAct();
  sheet.classList.add('open');
  markSeen();
  try { await refreshActivity(); } catch (e) { /* best effort */ }
  if (sheet.classList.contains('open')) renderSheetAct();
}
function closeSheet() {
  markSeen();
  sheet.classList.remove('open');
}
document.getElementById('sheetX').onclick = closeSheet;
sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
pushRow.onclick = async function () {
  pushRow.disabled = true;
  try { await toggleNotifications(); }
  finally { pushRow.disabled = false; syncPushRow(); }
};

// ---- Notification activity feed (unread marker) ----
function relTime(iso) {
  var t = new Date(iso).getTime(), d = Date.now() - t;
  if (!(d >= 0)) return '';
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}
async function refreshActivity() {
  try {
    var data = await api('/events');
    var events = data.events || [];
    lastEvents = events;
    var seen = storeGet('seenTs');
    if (!seen) { storeSet('seenTs', new Date().toISOString()); return; } // first run: don't flag history
    var unseen = events.filter(function (e) {
      return e.updated_at > seen && (!who || e.actor !== who);
    });
    bellBtn.classList.toggle('hasunseen', unseen.length > 0);
    if (sheet.classList.contains('open')) renderSheetAct();
    if (!unseen.length) { actBanner.className = ''; actBanner.innerHTML = ''; return; }
    var html = '<div class="ahead"><span class="atitle">Activity</span>' +
      '<button class="ax" id="actX" aria-label="dismiss">&times;</button></div>';
    var show = unseen.slice(0, 3);
    for (var i = 0; i < show.length; i++) {
      html += '<div class="arow"><span class="abody"></span><span class="atime">' + relTime(show[i].updated_at) + '</span></div>';
    }
    actBanner.innerHTML = html;
    var bodies = actBanner.querySelectorAll('.abody');
    for (var j = 0; j < show.length; j++) { bodies[j].textContent = show[j].body; }
    actBanner.className = 'show';
    document.getElementById('actX').onclick = markSeen;
  } catch (e) { /* activity feed is best effort */ }
}
if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'push') refreshActivity();
  });
}

function api(path, opts) {
  opts = opts || {};
  var method = (opts.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return fetch('api/items' + path, opts).then(function (r) {
      if (!r.ok) throw new Error('Request failed');
      return r.json();
    });
  }
  // Mutations made offline are queued and replayed on reconnect.
  if (!navigator.onLine) {
    enqueueApi({ path: path, opts: opts });
    return Promise.resolve({ ok: true, queued: true });
  }
  return fetch('api/items' + path, opts).then(function (r) {
    if (!r.ok) throw new Error('Request failed: ' + r.status);
    return r.json();
  }).catch(function (err) {
    // Only queue when the network itself failed (offline). Surface HTTP errors
    // so a failed tap shows an error instead of silently doing nothing.
    if (err instanceof TypeError) {
      enqueueApi({ path: path, opts: opts });
      return { ok: true, queued: true };
    }
    throw err;
  });
}
var apiQueue = [];
try { apiQueue = JSON.parse(localStorage.getItem('apiQueue') || '[]'); } catch (e) { apiQueue = []; }
function saveQueue() { try { localStorage.setItem('apiQueue', JSON.stringify(apiQueue)); } catch (e) {} }
function enqueueApi(req) {
  apiQueue.push(req);
  saveQueue();
  updateNetBadge();
  toast('Offline — change queued');
}
function updateNetBadge() {
  var b = document.getElementById('netBadge');
  if (!b) return;
  if (!navigator.onLine) {
    b.style.display = '';
    b.textContent = 'offline' + (apiQueue.length ? ' · ' + apiQueue.length + ' queued' : '');
  } else if (apiQueue.length) {
    b.style.display = '';
    b.textContent = apiQueue.length + ' queued — tap to sync';
  } else {
    b.style.display = 'none';
  }
}
function flushQueue() {
  if (!navigator.onLine || !apiQueue.length) { updateNetBadge(); return; }
  var q = apiQueue.slice();
  var chain = Promise.resolve();
  q.forEach(function (req) {
    chain = chain.then(function () { return fetch('api/items' + req.path, req.opts).catch(function () {}); });
  });
  chain.then(function () {
    apiQueue = apiQueue.slice(q.length);
    saveQueue();
    updateNetBadge();
    refresh();
    loadStaples();
  });
}
window.addEventListener('online', function () { updateNetBadge(); flushQueue(); });
window.addEventListener('offline', updateNetBadge);
function showErr(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
  errEl.style.background = '';
  setTimeout(function () { errEl.style.display = 'none'; }, 3000);
}
function toast(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
  errEl.style.background = '#1d7a44';
  setTimeout(function () { errEl.style.display = 'none'; errEl.style.background = ''; }, 2500);
}
function storeLabel(s) { return s === 'heb' ? 'H-E-B' : (s === 'tjs' ? "Trader Joe's" : (s === 'costco' ? 'Costco' : 'Either')); }
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
  mid.appendChild(name);
  mid.appendChild(qtyControl(it, purchased));
  mid.appendChild(meta);
  if (!purchased && it.note) {
    var nt = document.createElement('div');
    nt.className = 'meta noteline';
    nt.textContent = '\uD83D\uDCDD ' + it.note;
    nt.onclick = function (e) { e.stopPropagation(); openDetail(it); };
    mid.appendChild(nt);
  }
  if (!purchased && it.price !== null && it.price !== undefined && it.price !== '') {
    var pr = document.createElement('div');
    pr.className = 'meta priceline';
    pr.textContent = '$' + Number(it.price).toFixed(2) + ' est.';
    pr.onclick = function (e) { e.stopPropagation(); openDetail(it); };
    mid.appendChild(pr);
  }
  if (it.photo) {
    var th = document.createElement('img');
    th.className = 'thumb';
    th.src = it.photo;
    th.alt = '';
    th.onclick = function (e) { e.stopPropagation(); openLightbox(it.photo); };
    mid.appendChild(th);
  }
  if (!purchased && it.claimed_by) {
    var cl = document.createElement('div');
    cl.className = 'meta claimedline';
    cl.textContent = '\\uD83D\\uDE4B ' + it.claimed_by + ' will get this' + (it.claim_when ? ' \\u00B7 ' + it.claim_when : '');
    mid.appendChild(cl);
  }
  var del = document.createElement('button');
  del.className = 'rowbtn delbtn';
  del.textContent = '\\u00D7';
  del.setAttribute('aria-label', 'delete');
  del.onclick = function (e) { e.stopPropagation(); remove(it); };
  li.appendChild(check); li.appendChild(sel); li.appendChild(mid); li.appendChild(del);
  if (!purchased) {
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (it.urgent) {
      li.classList.add('urgent');
      var utag = document.createElement('span');
      utag.className = 'utag';
      utag.textContent = '\\u26A1 Urgent';
      actions.appendChild(utag);
    }
    var tag = document.createElement('span');
    tag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
    tag.textContent = storeLabel(it.store);
    actions.appendChild(tag);
    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    actions.appendChild(spacer);
    var urgent = document.createElement('button');
    urgent.className = 'abtn urgentbtn' + (it.urgent ? ' on' : '');
    urgent.textContent = '\\u26A1 ' + (it.urgent ? 'Urgent' : 'Mark urgent');
    urgent.setAttribute('aria-label', 'toggle urgent');
    urgent.onclick = function (e) { e.stopPropagation(); toggleUrgent(it); };
    actions.appendChild(urgent);
    var claim = document.createElement('button');
    claim.className = 'abtn claimbtn' + (it.claimed_by ? ' claimed' : '');
    claim.textContent = '\\uD83D\\uDE4B ' + (it.claimed_by ? it.claimed_by : 'Claim');
    claim.setAttribute('aria-label', 'claim');
    claim.title = it.claimed_by ? it.claimed_by + ' will get this' + (it.claim_when ? ' \\u00B7 ' + it.claim_when : '') : 'Claim this item';
    claim.onclick = function (e) { e.stopPropagation(); claimItem(it); };
    actions.appendChild(claim);
    var det = document.createElement('button');
    det.className = 'abtn';
    det.textContent = '\u270F\uFE0F';
    det.title = 'Note, price, photo';
    det.setAttribute('aria-label', 'edit details');
    det.onclick = function (e) { e.stopPropagation(); openDetail(it); };
    actions.appendChild(det);
    var st = document.createElement('button');
    st.className = 'abtn';
    st.textContent = '\uD83D\uDCCC';
    st.title = 'Save as staple';
    st.setAttribute('aria-label', 'save as staple');
    st.onclick = function (e) { e.stopPropagation(); saveStaple(it); };
    actions.appendChild(st);
    li.appendChild(actions);
  } else {
    var ptag = document.createElement('span');
    ptag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
    ptag.textContent = storeLabel(it.store);
    li.insertBefore(ptag, del);
  }
  return li;
}

// ---- Photo lightbox: tap a thumbnail to enlarge, tap anywhere to close ----
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightboxImg').src = '';
}
document.getElementById('lightbox').addEventListener('click', closeLightbox);
document.getElementById('detailPreview').addEventListener('click', function () {
  if (this.src) openLightbox(this.src);
});

function setQty(it, v) {
  var s = (v === null || v === undefined) ? null : String(v).trim().slice(0, 20) || null;
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qty: s }) })
    .then(refresh).catch(function () { showErr('Could not update quantity'); });
}
function askQty(it) {
  var v = prompt('Quantity for "' + it.name + '"', it.qty || '');
  if (v === null) return;
  setQty(it, v);
}
function qtyControl(it, purchased) {
  var wrap = document.createElement('span');
  wrap.className = 'qwrap';
  var q = (it.qty || '').toString().trim();
  if (q && /^[0-9]+(\.[0-9]+)?$/.test(q) && !purchased) {
    var minus = document.createElement('button');
    minus.className = 'qbtn'; minus.textContent = '\u2212';
    minus.setAttribute('aria-label', 'decrease quantity');
    minus.onclick = function (e) { e.stopPropagation(); setQty(it, Math.max(1, parseFloat(q) - 1)); };
    var qd = document.createElement('span');
    qd.className = 'qbadge'; qd.textContent = '\u00D7' + q;
    var plus = document.createElement('button');
    plus.className = 'qbtn'; plus.textContent = '+';
    plus.setAttribute('aria-label', 'increase quantity');
    plus.onclick = function (e) { e.stopPropagation(); setQty(it, parseFloat(q) + 1); };
    wrap.appendChild(minus); wrap.appendChild(qd); wrap.appendChild(plus);
  } else {
    var qb = document.createElement(purchased ? 'span' : 'button');
    qb.className = 'qbadge' + (q ? '' : ' textq');
    qb.textContent = q ? (purchased ? '\u00D7' + q : q) : '+ qty';
    if (!purchased) qb.onclick = function (e) { e.stopPropagation(); askQty(it); };
    wrap.appendChild(qb);
  }
  return wrap;
}

// ---- Item details sheet: note, price estimate, photo ----
var detailItem = null;
var detailPhotoData = null;
function fileToDataUrl(file, cb) {
  var img = new Image();
  var url = URL.createObjectURL(file);
  img.onload = function () {
    try {
      var max = 800, w = img.width, h = img.height;
      var scale = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/jpeg', 0.7));
    } catch (e) { URL.revokeObjectURL(url); cb(null); }
  };
  img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}
function openDetail(it) {
  detailItem = it;
  detailPhotoData = null;
  document.getElementById('detailTitle').textContent = it.name;
  document.getElementById('detailNote').value = it.note || '';
  document.getElementById('detailPrice').value = (it.price === null || it.price === undefined || it.price === '') ? '' : it.price;
  var prev = document.getElementById('detailPreview');
  prev.src = it.photo || '';
  prev.style.display = it.photo ? 'block' : 'none';
  document.getElementById('detailPhoto').value = '';
  document.getElementById('detailSheet').classList.add('open');
}
function closeDetail() {
  document.getElementById('detailSheet').classList.remove('open');
  detailItem = null;
  detailPhotoData = null;
}
document.getElementById('detailX').onclick = closeDetail;
document.getElementById('detailSheet').addEventListener('click', function (e) { if (e.target === this) closeDetail(); });
document.getElementById('detailPhoto').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (!f) return;
  fileToDataUrl(f, function (dataUrl) {
    if (!dataUrl) { showErr('Could not read photo'); return; }
    detailPhotoData = dataUrl;
    var prev = document.getElementById('detailPreview');
    prev.src = dataUrl;
    prev.style.display = 'block';
  });
});
document.getElementById('detailSave').onclick = function () {
  if (!detailItem) return;
  var body = {
    note: document.getElementById('detailNote').value,
    price: document.getElementById('detailPrice').value
  };
  if (detailPhotoData) body.photo = detailPhotoData;
  api('/' + detailItem.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(function () { closeDetail(); refresh(); })
    .catch(function () { showErr('Could not save details'); });
};
document.getElementById('detailClearPhoto').onclick = function () {
  if (!detailItem) return;
  api('/' + detailItem.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo: null }) })
    .then(function () { closeDetail(); refresh(); })
    .catch(function () { showErr('Could not remove photo'); });
};

function claimItem(it) {
  if (it.claimed_by) {
    api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimed: 0 }) })
      .then(refresh).catch(function () { showErr('Could not update item'); });
    return;
  }
  var when = prompt('When will you get "' + it.name + '"?', 'today');
  if (when === null) return;
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimed: 1, claimed_by: who, claim_when: when.trim() }) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}

function toggleUrgent(it) {
  api('/' + it.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urgent: it.urgent ? 0 : 1 }) })
    .then(refresh).catch(function () { showErr('Could not update item'); });
}

var selecting = false;
var selected = {};
function visibleActive() {
  return items.filter(function (it) {
    return !it.checked && (filter === 'all' || it.store === 'either' || it.store === filter);
  });
}
function updateSel() {
  var n = Object.keys(selected).length;
  document.getElementById('selCount').textContent = n === 0 ? 'Tap items to select' : n + ' selected';
  var vis = visibleActive();
  var allSel = vis.length > 0 && vis.every(function (it) { return selected[it.id]; });
  document.getElementById('bulkAll').textContent = allSel ? 'Deselect all' : 'Select all';
}
document.getElementById('bulkAll').onclick = function () {
  var vis = visibleActive();
  var allSel = vis.length > 0 && vis.every(function (it) { return selected[it.id]; });
  vis.forEach(function (it) { if (allSel) delete selected[it.id]; else selected[it.id] = 1; });
  render(); updateSel();
};
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
document.getElementById('bulkClaim').onclick = function () {
  var ids = Object.keys(selected);
  if (!ids.length) return;
  var when = prompt('When will you get these ' + ids.length + (ids.length === 1 ? ' item' : ' items') + '?', 'today');
  if (when === null) return;
  api('/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids, op: 'claim', by: who, when: when.trim() }) })
    .then(function () { endSelect(); refresh(); })
    .catch(function () { showErr('Bulk update failed'); });
};
document.getElementById('bulkUrgent').onclick = function () { bulkOp('urgent'); };
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
  var active = visibleActive();
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
  var qtyInput = document.getElementById('itemQty');
  var name = input.value.trim();
  if (!name) return;
  var dup = isDupName(name);
  if (dup && !confirm('"' + name + '" is already on the list. Add anyway?')) return;
  var qty = qtyInput ? qtyInput.value.trim().slice(0, 20) : '';
  api('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, store: addStore, added_by: who, qty: qty || undefined }) })
    .then(function () { input.value = ''; if (qtyInput) qtyInput.value = ''; refresh(); })
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

// ---- Staples: scrollable menu, tap Add to put a staple on the list ----
var staples = [];
function loadStaples() {
  api('/staples').then(function (data) { staples = data || []; updateStaplesBtn(); })
    .catch(function () { staples = []; updateStaplesBtn(); });
}
function updateStaplesBtn() {
  document.getElementById('staplesOpen').innerHTML =
    '&#128204; Staples' + (staples.length ? ' (' + staples.length + ')' : '');
}
function isDupName(name) {
  return items.some(function (it) { return !it.checked && it.name.toLowerCase() === name.toLowerCase(); });
}
function openStapleSheet() {
  renderStapleSheet();
  document.getElementById('stapleSheet').classList.add('open');
}
function closeStapleSheet() {
  document.getElementById('stapleSheet').classList.remove('open');
}
function renderStapleSheet() {
  var list = document.getElementById('stapleList');
  list.innerHTML = '';
  if (!staples.length) {
    var empty = document.createElement('div');
    empty.className = 'sheetSub';
    empty.textContent = 'No staples yet. Pin an item with \uD83D\uDCCC or add one below.';
    list.appendChild(empty);
    return;
  }
  staples.forEach(function (s) {
    var row = document.createElement('div');
    row.className = 'staplerow';
    var info = document.createElement('div');
    info.className = 'stapleinfo';
    var nm = document.createElement('div');
    nm.className = 'staplename';
    nm.textContent = ((s.qty || '').trim() ? s.qty.trim() + ' ' : '') + s.name;
    info.appendChild(nm);
    var meta = document.createElement('div');
    meta.className = 'staplemeta';
    var bits = [storeLabel(s.store)];
    if ((s.note || '').trim()) bits.push(s.note.trim());
    meta.textContent = bits.join(' \u00B7 ');
    info.appendChild(meta);
    var add = document.createElement('button');
    add.className = 'sadd';
    add.textContent = 'Add';
    add.onclick = function () { addStapleToList(s); };
    var del = document.createElement('button');
    del.className = 'sdel2';
    del.textContent = '\u00D7';
    del.setAttribute('aria-label', 'delete staple');
    del.onclick = function () {
      if (confirm('Delete staple "' + s.name + '"?')) {
        api('/staples/' + s.id, { method: 'DELETE' })
          .then(function () { loadStaples(); renderStapleSheet(); })
          .catch(function () { showErr('Could not delete staple'); });
      }
    };
    row.appendChild(info);
    row.appendChild(add);
    row.appendChild(del);
    list.appendChild(row);
  });
}
function addStapleToList(s) {
  if (isDupName(s.name) && !confirm('"' + s.name + '" is already on the list. Add anyway?')) return;
  api('/staples/' + s.id + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: who }) })
    .then(function () { refresh(); toast('Added ' + s.name); })
    .catch(function () { showErr('Could not add staple'); });
}
document.getElementById('staplesOpen').onclick = openStapleSheet;
document.getElementById('stapleSheetX').onclick = closeStapleSheet;
function saveStaple(it) {
  if (staples.some(function (s) { return s.name.toLowerCase() === it.name.toLowerCase(); })) {
    toast('Already a staple');
    return;
  }
  api('/staples', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: it.name, store: it.store, qty: it.qty, note: it.note, created_by: who }) })
    .then(function () { loadStaples(); toast('Saved as staple'); })
    .catch(function () { showErr('Could not save staple'); });
}
document.getElementById('stapleNew').onclick = function () {
  var name = prompt('Staple name:');
  if (name === null) return;
  name = name.trim().slice(0, 60);
  if (!name) return;
  api('/staples', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, store: addStore, created_by: who }) })
    .then(function () { loadStaples(); renderStapleSheet(); })
    .catch(function () { showErr('Could not add staple'); });
};

// ---- Recipe import: paste ingredients, one per line ----
function openRecipe() {
  document.getElementById('recipeText').value = '';
  document.getElementById('recipeSheet').classList.add('open');
}
function closeRecipe() { document.getElementById('recipeSheet').classList.remove('open'); }
document.getElementById('recipeBtn').onclick = openRecipe;
document.getElementById('recipeX').onclick = closeRecipe;
document.getElementById('recipeSheet').addEventListener('click', function (e) { if (e.target === this) closeRecipe(); });
document.getElementById('recipeAdd').onclick = function () {
  var parsed = [];
  document.getElementById('recipeText').value.split('\\n').forEach(function (line) {
    var l = line.trim().replace(/^([\\s\\-\\*\u2022]+|\\d+[\\.\\)\\]]\\s+|\\d+[\\.\\)\\]]$)/, '').trim();
    if (!l) return;
    var m = l.match(/^(\\d+(?:\\.\\d+)?(?:\\/\\d+)?)\\s*([a-zA-Z]*)\\s+(.+)$/);
    var qty = '', pname = l;
    if (m) { qty = (m[1] + (m[2] ? ' ' + m[2] : '')).slice(0, 20); pname = m[3]; }
    parsed.push({ name: pname.slice(0, 60), qty: qty });
  });
  parsed = parsed.slice(0, 50);
  if (!parsed.length) return;
  var fresh = parsed.filter(function (p) { return !isDupName(p.name); });
  var skipped = parsed.length - fresh.length;
  closeRecipe();
  if (!fresh.length) { toast(skipped ? 'All already on the list' : 'Nothing to add'); return; }
  var chain = Promise.resolve();
  fresh.forEach(function (p) {
    chain = chain.then(function () {
      return api('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, store: addStore, added_by: who, qty: p.qty || undefined }) })
        .catch(function () {});
    });
  });
  chain.then(function () { refresh(); toast('Added ' + fresh.length + ' items' + (skipped ? ' (' + skipped + ' already on list)' : '')); });
};

// ---- In-store mode: big type, big checkboxes, no clutter ----
document.getElementById('storeBtn').onclick = function () {
  var on = document.body.classList.toggle('instore');
  this.classList.toggle('on', on);
};
document.getElementById('netBadge').onclick = function () { flushQueue(); };

function qtyNum(q) {
  var n = parseFloat(q);
  return (isFinite(n) && n > 0) ? n : 1;
}

refresh();
loadStaples();
updateNetBadge();
refreshActivity();
setInterval(refresh, 10000); // near-live sync between the two phones
setInterval(refreshActivity, 60000);
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) { refresh(); refreshActivity(); }
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

async function handleApi(request, env, ctx, rest) {
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
    const when = (body.when || '').toString().trim().slice(0, 60) || null;
    if (!ids.length) return badRequest('ids required');
    if (['claim', 'unclaim', 'purchase', 'restore', 'delete', 'urgent', 'unurgent'].indexOf(op) < 0) return badRequest('bad op');
    const now = new Date().toISOString();
    const m9 = await hasM9Cols(db);
    const claimUntilIso = m9 ? claimUntil(when, now) : null;
    const stmts = ids.map(function (id) {
      switch (op) {
        case 'claim': return m9
          ? db.prepare('UPDATE items SET claimed_by = ?, claimed_at = ?, claim_when = ?, claim_until = ?, updated_at = ? WHERE id = ?').bind(by, now, when, claimUntilIso, now, id)
          : db.prepare('UPDATE items SET claimed_by = ?, claimed_at = ?, claim_when = ?, updated_at = ? WHERE id = ?').bind(by, now, when, now, id);
        case 'unclaim': return m9
          ? db.prepare('UPDATE items SET claimed_by = NULL, claimed_at = NULL, claim_when = NULL, claim_until = NULL, updated_at = ? WHERE id = ?').bind(now, id)
          : db.prepare('UPDATE items SET claimed_by = NULL, claimed_at = NULL, claim_when = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'purchase': return db.prepare('UPDATE items SET checked = 1, purchased_by = ?, purchased_at = ?, updated_at = ? WHERE id = ?').bind(by, now, now, id);
        case 'restore': return db.prepare('UPDATE items SET checked = 0, purchased_by = NULL, purchased_at = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'delete': return db.prepare('DELETE FROM items WHERE id = ?').bind(id);
        case 'urgent': return db.prepare('UPDATE items SET urgent = 1, updated_at = ? WHERE id = ?').bind(now, id);
        case 'unurgent': return db.prepare('UPDATE items SET urgent = 0, updated_at = ? WHERE id = ?').bind(now, id);
      }
    });
    await db.batch(stmts);
    if ((op === 'purchase' || op === 'claim') && by) {
      ctx.waitUntil(recordActivity(env, by, op, null, { count: ids.length, when: when }));
    }
    return json({ ok: true, count: ids.length });
  }

  // POST /api/items/clear-checked
  if (rest.length === 1 && rest[0] === 'clear-checked') {
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    await db.prepare('DELETE FROM items WHERE checked = 1').run();
    return json({ ok: true });
  }

  // GET /api/items/events — recent notification activity for the unread marker.
  // Table created by migrate7.sql; returns [] if the migration hasn't run yet.
  if (rest.length === 1 && rest[0] === 'events') {
    if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    try {
      const rows = await db.prepare(
        'SELECT actor, kind, body, created_at, updated_at FROM notification_events ORDER BY updated_at DESC LIMIT 20'
      ).all();
      return json({ events: rows.results || [] });
    } catch (e) {
      return json({ events: [] });
    }
  }

  // POST/DELETE /api/items/subscriptions — manage Web Push subscriptions.
  // Table created by migrate6.sql. Events are queued by recordActivity() and
  // flushed as one push per batch by the cron trigger (flushDuePushes).
  if (rest.length === 1 && rest[0] === 'subscriptions') {
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
      const endpoint = (body.endpoint || '').toString();
      const p256dh = body.keys && body.keys.p256dh ? body.keys.p256dh.toString() : '';
      const auth = body.keys && body.keys.auth ? body.keys.auth.toString() : '';
      const name = (body.name || '').toString().trim().slice(0, 60) || null;
      if (!endpoint || !p256dh || !auth) return badRequest('endpoint and keys required');
      await db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(endpoint, p256dh, auth, name, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      let body = {};
      try { body = await request.json(); } catch { /* endpoint may be absent */ }
      const endpoint = (body.endpoint || '').toString();
      if (!endpoint) return badRequest('endpoint required');
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  // GET /api/items  |  POST /api/items
  if (rest.length === 0) {
    if (method === 'GET') {
      const cols = (await hasM9Cols(db))
        ? 'id, name, store, checked, urgent, added_by, claimed_by, claimed_at, claim_when, created_at, updated_at, purchased_by, purchased_at, qty, note, price, photo, claim_until'
        : 'id, name, store, checked, urgent, added_by, claimed_by, claimed_at, claim_when, created_at, updated_at, purchased_by, purchased_at';
      const rows = await db
        .prepare('SELECT ' + cols + ' FROM items ORDER BY checked ASC, urgent DESC, created_at ASC')
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
      const m9 = await hasM9Cols(db);
      const qty = m9 ? ((body.qty || '').toString().trim().slice(0, 20) || null) : null;
      const note = m9 ? ((body.note || '').toString().trim().slice(0, 200) || null) : null;
      let price = null;
      if (m9 && body.price !== undefined && body.price !== null && body.price !== '') {
        price = Number(body.price);
        if (!(price >= 0) || !isFinite(price)) return badRequest('price must be a non-negative number');
      }
      if (m9) {
        await db
          .prepare('INSERT INTO items (id, name, store, checked, added_by, created_at, updated_at, qty, note, price) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
          .bind(id, name, store, addedBy, now, now, qty, note, price)
          .run();
      } else {
        await db
          .prepare('INSERT INTO items (id, name, store, checked, added_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
          .bind(id, name, store, addedBy, now, now)
          .run();
      }
      if (addedBy) {
        ctx.waitUntil(recordActivity(env, addedBy, 'add', name, { store: store }));
      }
      return json({ id, name, store, checked: 0, added_by: addedBy, created_at: now, updated_at: now, qty, note, price }, 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  // GET /api/items/staples  |  POST /api/items/staples
  // Table created by migrate9.sql; returns [] if the migration hasn't run yet.
  if (rest.length === 1 && rest[0] === 'staples') {
    try {
      if (method === 'GET') {
        const rows = await db.prepare(
          'SELECT id, name, store, qty, note, created_by, created_at FROM staples ORDER BY created_at'
        ).all();
        return json(rows.results || []);
      }
      if (method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return badRequest('Invalid JSON'); }
        const name = (body.name || '').toString().trim();
        const store = (body.store || 'either').toString();
        const createdBy = (body.created_by || '').toString().trim().slice(0, 60) || null;
        if (!name) return badRequest('name is required');
        if (!STORES.includes(store)) return badRequest('store must be heb, tjs, or either');
        const qty = (body.qty || '').toString().trim().slice(0, 20) || null;
        const note = (body.note || '').toString().trim().slice(0, 200) || null;
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.prepare(
          'INSERT INTO staples (id, name, store, qty, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, store, qty, note, createdBy, now).run();
        return json({ id, name, store, qty, note, created_by: createdBy, created_at: now }, 201);
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (e) {
      if (method === 'GET') return json([]);
      throw e;
    }
  }

  // DELETE /api/items/staples/:id
  if (rest.length === 2 && rest[0] === 'staples') {
    const stapleId = rest[1];
    if (method === 'DELETE') {
      try {
        const res = await db.prepare('DELETE FROM staples WHERE id = ?').bind(stapleId).run();
        if (res.meta.changes === 0) return json({ error: 'Not found' }, 404);
        return json({ ok: true });
      } catch (e) {
        return json({ error: 'Not found' }, 404);
      }
    }
    return json({ error: 'Not found' }, 404);
  }
  if (rest.length === 3 && rest[0] === 'staples' && rest[2] === 'add') {
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body = {};
    try { body = await request.json(); } catch { /* by is optional */ }
    const by = (body.by || '').toString().trim().slice(0, 60) || null;
    try {
      const s = await db.prepare('SELECT name, store, qty, note FROM staples WHERE id = ?').bind(rest[1]).first();
      if (!s) return json({ error: 'Not found' }, 404);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const m9 = await hasM9Cols(db);
      if (m9) {
        await db.prepare(
          'INSERT INTO items (id, name, store, checked, added_by, created_at, updated_at, qty, note) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)'
        ).bind(id, s.name, s.store, by, now, now, s.qty, s.note).run();
      } else {
        await db.prepare(
          'INSERT INTO items (id, name, store, checked, added_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
        ).bind(id, s.name, s.store, by, now, now).run();
      }
      if (by) ctx.waitUntil(recordActivity(env, by, 'add', s.name, { store: s.store }));
      return json({ id, name: s.name, store: s.store }, 201);
    } catch (e) {
      return json({ error: 'Not found' }, 404);
    }
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
      if (body.urgent !== undefined) {
        sets.push('urgent = ?'); binds.push(body.urgent ? 1 : 0);
      }
      const m9 = await hasM9Cols(db);
      if (m9 && body.qty !== undefined) {
        sets.push('qty = ?'); binds.push(body.qty === null ? null : body.qty.toString().trim().slice(0, 20) || null);
      }
      if (m9 && body.note !== undefined) {
        sets.push('note = ?'); binds.push(body.note === null ? null : body.note.toString().trim().slice(0, 200) || null);
      }
      if (m9 && body.price !== undefined) {
        let price = null;
        if (body.price !== null && body.price !== '') {
          price = Number(body.price);
          if (!(price >= 0) || !isFinite(price)) return badRequest('price must be a non-negative number');
        }
        sets.push('price = ?'); binds.push(price);
      }
      if (m9 && body.photo !== undefined) {
        sets.push('photo = ?'); binds.push(body.photo === null ? null : body.photo.toString().slice(0, 200000) || null);
      }
      if (body.claimed !== undefined) {
        if (body.claimed) {
          const claimedBy = (body.claimed_by || '').toString().trim().slice(0, 60) || null;
          const claimWhen = (body.claim_when || '').toString().trim().slice(0, 60) || null;
          const nowIso = new Date().toISOString();
          sets.push('claimed_by = ?'); binds.push(claimedBy);
          sets.push('claimed_at = ?'); binds.push(nowIso);
          sets.push('claim_when = ?'); binds.push(claimWhen);
          if (m9) { sets.push('claim_until = ?'); binds.push(claimUntil(claimWhen, nowIso)); }
        } else {
          sets.push('claimed_by = NULL');
          sets.push('claimed_at = NULL');
          sets.push('claim_when = NULL');
          if (m9) sets.push('claim_until = NULL');
        }
      }
      if (body.checked !== undefined) {
        const checked = body.checked ? 1 : 0;
        sets.push('checked = ?'); binds.push(checked);
        if (checked) {
          const purchasedBy = (body.purchased_by || '').toString().trim().slice(0, 60) || null;
          sets.push('purchased_by = ?'); binds.push(purchasedBy);
          sets.push('purchased_at = ?'); binds.push(new Date().toISOString());
          sets.push('urgent = 0');
        } else {
          sets.push('purchased_by = NULL');
          sets.push('purchased_at = NULL');
        }
      }
      if (sets.length === 0) return badRequest('nothing to update');
      sets.push('updated_at = ?');
      binds.push(new Date().toISOString(), id);
      let existing = null;
      if (body.checked || body.claimed) {
        existing = await db.prepare('SELECT name, checked FROM items WHERE id = ?').bind(id).first();
      }
      const res = await db
        .prepare('UPDATE items SET ' + sets.join(', ') + ' WHERE id = ?')
        .bind(...binds)
        .run();
      if (res.meta.changes === 0) return json({ error: 'Not found' }, 404);
      if (existing) {
        if (body.checked && !existing.checked) {
          const actor = (body.purchased_by || '').toString().trim().slice(0, 60);
          if (actor) ctx.waitUntil(recordActivity(env, actor, 'purchase', existing.name));
        } else if (body.claimed) {
          const actor = (body.claimed_by || '').toString().trim().slice(0, 60);
          const when = (body.claim_when || '').toString().trim().slice(0, 60);
          if (actor) ctx.waitUntil(recordActivity(env, actor, 'claim', existing.name, { when: when }));
        }
      }
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
  async fetch(request, env, ctx) {
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
      return handleApi(request, env, ctx, rest.slice(2));
    }
    if (rest.length === 1 && rest[0] === 'sw.js') {
      return new Response(SW_JS, { headers: { 'Content-Type': 'application/javascript' } });
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron trigger (see [triggers] in wrangler.toml): flush pending notification
  // batches — one push per batch after the actor goes quiet — purge items
  // purchased more than 24 hours ago, and release expired claims.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(flushDuePushes(env));
    ctx.waitUntil(purgeOldPurchased(env));
    ctx.waitUntil(releaseExpiredClaims(env));
  },
};
