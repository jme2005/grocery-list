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



// ---- Web Push notifications (RFC 8291 aes128gcm + RFC 8292 VAPID) ----
// The public VAPID key is baked in (it's public). The private JWK is a secret
// and is never committed:  npx wrangler secret put VAPID_PRIVATE_JWK
const VAPID_PUBLIC_KEY = 'BB0k6VaPs-X82jiyvJeo_eaaDJLOhel0RD8-kkRRM9V8ePzRChnwsWAIMN_IHtE3wfLFomoZJ9OMtMj_AfLEQpw';
const VAPID_SUBJECT = 'mailto:johan.m.edvinsson@gmail.com';

const SW_JS = `self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title || 'Grocery List', {
    body: data.body || '',
    tag: 'grocery-list'
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(self.registration.scope));
});
`;

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
  const keyInfo = new Uint8Array(13 + 65 + 65);
  keyInfo.set(te.encode('WebPush: info\0'), 0);
  keyInfo.set(uaPub, 13);
  keyInfo.set(asPub, 78);
  const ikm = await hkdfExpand(await hkdfExtract(authSecret, shared), keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, te.encode('Content-Encoding: nonce\0'), 12);

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

// Fan out a notification to every subscribed device except the actor's own.
async function notifyOthers(env, actorName, bodyText) {
  try {
    if (!bodyText) return;
    const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth, name FROM push_subscriptions').all();
    const subs = (rows.results || []).filter(s => !actorName || s.name !== actorName);
    if (!subs.length) return;
    const payload = { title: '🧺 Grocery List', body: bodyText };
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
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: #f4f2ec; color: #20241f; padding-bottom: 200px; }
  header { position: sticky; top: 0; z-index: 10; background: linear-gradient(150deg, #1d9a55 0%, #0e6b3a 60%, #0a4f2c 100%); color: #fff; padding: calc(16px + env(safe-area-inset-top)) 18px 16px; box-shadow: 0 2px 12px rgba(10,60,35,.35); }
  .headrow { display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
  .sub { font-size: 13px; opacity: .85; margin-top: 2px; font-weight: 500; }
  #whoBtn { border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.16); color: #fff; font-size: 14px; font-weight: 600; padding: 8px 14px; border-radius: 999px; cursor: pointer; transition: transform .12s ease; }
  #whoBtn:active { transform: scale(.94); }
  .headbtns { display: flex; align-items: center; gap: 10px; }
  #bellBtn { border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.16); color: #fff; font-size: 17px; padding: 7px 11px; border-radius: 999px; cursor: pointer; opacity: .45; transition: opacity .15s ease, transform .12s ease; }
  #bellBtn.on { opacity: 1; }
  #bellBtn:active { transform: scale(.94); }
  .chips { display: flex; gap: 8px; margin-top: 14px; }
  .chip { flex: 1; padding: 11px 0; border: none; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-size: 15px; font-weight: 700; text-align: center; cursor: pointer; transition: all .15s ease; }
  .chip.active { background: #fff; color: #0b5a34; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .section { margin: 20px 16px 0; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #979d94; }
  ul { list-style: none; margin: 10px 0 0; padding: 0 14px; }
  li { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; background: #fff; border-radius: 18px; padding: 14px 14px 14px 12px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(25,35,25,.05), 0 6px 18px rgba(25,35,25,.06); border-left: 5px solid #d8dcd4; }
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
  .actions { flex: 1 1 100%; display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .actions .spacer { flex: 1; }
  .abtn { border: 1.5px solid #d5dad2; background: #f7f9f5; border-radius: 12px; font-size: 14px; font-weight: 700; color: #4a5148; padding: 9px 14px; cursor: pointer; transition: transform .12s ease; }
  .abtn:active { transform: scale(.95); }
  .urgentbtn.on { background: #ffe6e6; border-color: #e05240; color: #c74343; }
  .claimbtn.claimed { background: #e9f5ee; border-color: #1d9a55; color: #0e6b3a; }
  body.selecting .actions { display: none; }
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
  li.urgent { border-left-color: #e05240; }
  .utag { flex: none; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; padding: 6px 10px; border-radius: 999px; background: #ffe6e6; color: #c74343; }
  #bulkUrgent { background: #fff3e0; color: #d97a1f; }
</style>
</head>
<body>
<div id="err"></div>
<header>
  <div class="headrow">
    <div><h1>🧺 Grocery List</h1><div class="sub" id="buyCount"></div></div>
    <div class="headbtns">
      <button id="bellBtn" aria-label="notifications" title="notifications">&#128276;</button>
      <button id="whoBtn" aria-label="change name"></button>
    </div>
  </div>
  <div class="chips" id="filters">
    <button class="chip active" data-f="all">All</button>
    <button class="chip" data-f="heb">H-E-B</button>
    <button class="chip" data-f="tjs">Trader Joe&rsquo;s</button>
    <button class="chip" data-f="costco">Costco</button>
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
    <button data-s="costco">Costco</button>
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
      <button id="bulkUrgent">Urgent</button>
      <button id="bulkBuy">Buy</button>
      <button id="bulkDel">Delete</button>
      <button id="bulkCancel">Done</button>
    </div>
  </div>
</footer>
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
  // Never prompt() at page load: on iOS it freezes the page before any
  // button gets wired up. The header name button handles setup on tap.
  whoBtn.textContent = who || 'Set name';
}
whoBtn.onclick = function () {
  var n = prompt('Your name:', who);
  if (n && n.trim()) { who = n.trim(); storeSet('groceryWho', who); whoBtn.textContent = who; refreshPushName(); }
};
ensureWho();

// ---- Web Push client ----
var VAPID_PUBLIC_KEY = 'BB0k6VaPs-X82jiyvJeo_eaaDJLOhel0RD8-kkRRM9V8ePzRChnwsWAIMN_IHtE3wfLFomoZJ9OMtMj_AfLEQpw';
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
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pushSupported() { return ('serviceWorker' in navigator) && ('PushManager' in window); }
var bellBtn = document.getElementById('bellBtn');
async function postSubscription(sub) {
  await api('/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint,
      keys: { p256dh: bufToB64url(sub.getKey('p256dh')), auth: bufToB64url(sub.getKey('auth')) },
      name: who }) });
}
async function refreshPushName() {
  try {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await postSubscription(sub);
  } catch (e) { /* best effort */ }
}
async function updateBell() {
  try {
    if (!pushSupported()) { bellBtn.style.display = 'none'; return; }
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg ? await reg.pushManager.getSubscription() : null;
    bellBtn.classList.toggle('on', !!sub);
  } catch (e) { /* leave the bell as-is */ }
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
      updateBell();
      return;
    }
    if (!pushSupported()) { alert('Push notifications are not supported in this browser.'); return; }
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notifications are blocked. Allow them in Settings to get alerts.'); return; }
    reg = await navigator.serviceWorker.register('sw.js');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) });
    await postSubscription(sub);
    updateBell();
  } catch (e) { alert('Could not turn on notifications.'); }
}
bellBtn.onclick = toggleNotifications;
updateBell();

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
  mid.appendChild(name); mid.appendChild(meta);
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
    li.appendChild(actions);
  } else {
    var ptag = document.createElement('span');
    ptag.className = 'tag ' + (it.store === 'either' ? '' : it.store);
    ptag.textContent = storeLabel(it.store);
    li.insertBefore(ptag, del);
  }
  return li;
}

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

async function handleApi(request, env, ctx, rest) {
  const method = request.method;
  const db = env.DB;

  // POST/DELETE /api/items/subscriptions — manage Web Push subscriptions
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
    const stmts = ids.map(function (id) {
      switch (op) {
        case 'claim': return db.prepare('UPDATE items SET claimed_by = ?, claimed_at = ?, claim_when = ?, updated_at = ? WHERE id = ?').bind(by, now, when, now, id);
        case 'unclaim': return db.prepare('UPDATE items SET claimed_by = NULL, claimed_at = NULL, claim_when = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'purchase': return db.prepare('UPDATE items SET checked = 1, purchased_by = ?, purchased_at = ?, updated_at = ? WHERE id = ?').bind(by, now, now, id);
        case 'restore': return db.prepare('UPDATE items SET checked = 0, purchased_by = NULL, purchased_at = NULL, updated_at = ? WHERE id = ?').bind(now, id);
        case 'delete': return db.prepare('DELETE FROM items WHERE id = ?').bind(id);
        case 'urgent': return db.prepare('UPDATE items SET urgent = 1, updated_at = ? WHERE id = ?').bind(now, id);
        case 'unurgent': return db.prepare('UPDATE items SET urgent = 0, updated_at = ? WHERE id = ?').bind(now, id);
      }
    });
    await db.batch(stmts);
    if ((op === 'purchase' || op === 'claim') && by) {
      const what = ids.length === 1 ? '1 item' : ids.length + ' items';
      const msg = op === 'purchase'
        ? by + ' bought ' + what
        : by + ' will get ' + what + (when ? ' · ' + when : '');
      ctx.waitUntil(notifyOthers(env, by, msg));
    }
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
        .prepare('SELECT id, name, store, checked, urgent, added_by, claimed_by, claimed_at, claim_when, created_at, updated_at, purchased_by, purchased_at FROM items ORDER BY checked ASC, urgent DESC, created_at ASC')
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
      if (addedBy) {
        ctx.waitUntil(notifyOthers(env, addedBy,
          addedBy + ' added "' + name + '"' + (store !== 'either' ? ' · ' + storeLabel(store) : '')));
      }
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
      const existing = await db.prepare('SELECT name, checked FROM items WHERE id = ?').bind(id).first();
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
      if (body.claimed !== undefined) {
        if (body.claimed) {
          const claimedBy = (body.claimed_by || '').toString().trim().slice(0, 60) || null;
          const claimWhen = (body.claim_when || '').toString().trim().slice(0, 60) || null;
          sets.push('claimed_by = ?'); binds.push(claimedBy);
          sets.push('claimed_at = ?'); binds.push(new Date().toISOString());
          sets.push('claim_when = ?'); binds.push(claimWhen);
        } else {
          sets.push('claimed_by = NULL');
          sets.push('claimed_at = NULL');
          sets.push('claim_when = NULL');
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
      const res = await db
        .prepare('UPDATE items SET ' + sets.join(', ') + ' WHERE id = ?')
        .bind(...binds)
        .run();
      if (res.meta.changes === 0) return json({ error: 'Not found' }, 404);
      if (body.checked && existing && !existing.checked) {
        const actor = (body.purchased_by || '').toString().trim().slice(0, 60);
        if (actor) ctx.waitUntil(notifyOthers(env, actor, actor + ' bought "' + existing.name + '"'));
      } else if (body.claimed && existing) {
        const actor = (body.claimed_by || '').toString().trim().slice(0, 60);
        const when = (body.claim_when || '').toString().trim().slice(0, 60);
        if (actor) ctx.waitUntil(notifyOthers(env, actor,
          actor + ' will get "' + existing.name + '"' + (when ? ' · ' + when : '')));
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
    if (rest.length === 1 && rest[0] === 'sw.js') {
      return new Response(SW_JS, { headers: { 'Content-Type': 'application/javascript' } });
    }
    if (rest[0] === 'api' && rest[1] === 'items') {
      return handleApi(request, env, ctx, rest.slice(2));
    }
    return new Response('Not found', { status: 404 });
  },
};
