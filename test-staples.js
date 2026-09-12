// Functional test: staples sheet, duplicate warnings, api() error surfacing.
// Runs the served client script against DOM stubs and asserts behavior.
// Run: node test-staples.js   (exit 0 = all assertions passed)
import fs from 'fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const stub = 'const STORES=[]; const STORE_LABEL={}; const SW_JS="";';
const tplMatch = src.match(/const PAGE = (`[\s\S]*?`);/);
eval(stub + 'const PAGE = ' + tplMatch[1] + '; globalThis.__page = PAGE;');
const script = globalThis.__page.split('<script>')[1].split('</script>')[0];

const harness = `
// ---- DOM stubs ----
function makeEl(){
  const e = { children:[], _html:'', textContent:'', value:'', src:'', title:'', style:{}, _ev:{},
  classList:{ add(){}, remove(){}, toggle(){}, contains(){return false;} },
  appendChild(c){ this.children.push(c); return c; },
  addEventListener(t,fn){ (e._ev[t] = e._ev[t] || []).push(fn); },
  fire(t,ev){ (e._ev[t]||[]).forEach(function(f){ f(ev || {}); }); },
  setAttribute(){}, getAttribute(){ return null; },
  closest(){ return null; }, focus(){},
  };
  Object.defineProperty(e, 'innerHTML', { get(){ return e._html; }, set(v){ e._html = v; if(v === '') e.children = []; } });
  return e;}
const __els = {};
globalThis.document = {
  getElementById(id){ return __els[id] || (__els[id] = makeEl()); },
  createElement(tag){ const e = makeEl(); e.tagName = tag; return e; },
  addEventListener(){}, hidden:false, title:'',
};
globalThis.window = globalThis;
globalThis.addEventListener = function(){};
Object.defineProperty(globalThis, 'navigator', { value: { onLine:true }, configurable: true });
globalThis.location = { pathname:'/SECRET/', search:'' };
const __ls = {};
globalThis.localStorage = { getItem(k){return k in __ls?__ls[k]:null;}, setItem(k,v){__ls[k]=String(v);}, removeItem(k){delete __ls[k];} };
let __confirmResult = true;
globalThis.confirm = function(){ return __confirmResult; };
globalThis.prompt = function(){ return 'TestStaple'; };
globalThis.alert = function(){};
const __apiCalls = [];
let __fetchImpl = async (url, opts) => ({ ok:true, status:200, json: async () => [] });
globalThis.fetch = (url, opts) => __fetchImpl(url, opts);
const __toasts = [], __errs = [];
`;
const tests = `
// ---- tests ----
(async function(){
  const assert = (c, m) => { if(!c){ console.error('FAIL: '+m); process.exitCode = 1; } else { console.log('ok: '+m); } };

  // 1. isDupName: unchecked dup detected, checked ignored
  items = [{name:'Milk', checked:0}, {name:'Eggs', checked:1}];
  assert(isDupName('milk') === true, 'isDupName finds unchecked duplicate (case-insensitive)');
  assert(isDupName('eggs') === false, 'isDupName ignores purchased items');
  assert(isDupName('Bread') === false, 'isDupName false for absent item');

  // 2. staple sheet renders rows with Add + delete
  staples = [{id:'s1', name:'Milk', store:'heb', qty:'1 gal', note:'whole'}];
  renderStapleSheet();
  const list = document.getElementById('stapleList');
  assert(list.children.length === 1, 'sheet renders one row per staple');
  const row = list.children[0];
  assert(row.children.length === 3, 'row has info + Add + delete');
  assert(row.children[1].textContent === 'Add', 'Add button present');
  assert(row.children[0].children[0].textContent === '1 gal Milk', 'qty shown with name');

  // 3. addStapleToList: dup + cancel => no POST
  __confirmResult = false;
  let posted = [];
  __fetchImpl = async (url, opts) => { posted.push(url); return { ok:true, status:201, json: async () => ({}) }; };
  await addStapleToList(staples[0]);
  assert(posted.length === 0, 'duplicate staple cancelled: no POST');

  // 4. addStapleToList: non-dup => POSTs to /add then refreshes
  __confirmResult = true;
  posted = [];
  await addStapleToList({id:'s2', name:'Bread', store:'either', qty:'', note:''});
  assert(posted.some(u => u.endsWith('/staples/s2/add')), 'non-dup staple POSTs to /staples/:id/add');

  // 5. api(): HTTP 500 now rejects (surfaces error) instead of silently queueing
  __fetchImpl = async () => ({ ok:false, status:500, json: async () => ({}) });
  let rejected = false;
  try { await api('/staples/x/add', { method:'POST' }); } catch(e){ rejected = true; }
  assert(rejected === true, 'api() rejects on HTTP 500 (no silent swallow)');

  // 6. api(): network failure (TypeError) still queues offline
  __fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const q = await api('/staples/x/add', { method:'POST' });
  assert(q && q.queued === true, 'api() queues on network TypeError');

  // 7. empty staples => friendly empty state, no crash
  staples = [];
  renderStapleSheet();
  assert(document.getElementById('stapleList').children.length === 1, 'empty staples renders placeholder');

  // 8. stale refresh responses are ignored: last request wins, not last response
  items = [];
  const pending = [];
  __fetchImpl = () => new Promise(resolve => pending.push(resolve));
  refresh(); // seq N+1 (older request)
  refresh(); // seq N+2 (newer request)
  assert(pending.length === 2, 'two refreshes in flight');
  // newer response arrives FIRST, older response arrives LAST (out of order)
  pending[1]({ ok:true, status:200, json: async () => [{name:'BBB', checked:0}] });
  await new Promise(r => setTimeout(r, 20));
  pending[0]({ ok:true, status:200, json: async () => [{name:'AAA', checked:0}] });
  await new Promise(r => setTimeout(r, 20));
  assert(items.length === 1 && items[0].name === 'BBB', 'stale older refresh response ignored');

  // 9. clicking Add POSTs to /add; clicking x sends DELETE (wiring check)
  staples = [{id:'s9', name:'Yogurt', store:'tjs', qty:'', note:''}];
  items = [];
  renderStapleSheet();
  const r9 = document.getElementById('stapleList').children[0];
  let hits = [];
  __fetchImpl = async (url, opts) => { hits.push(opts.method + ' ' + url); return { ok:true, status:200, json: async () => [] }; };
  __confirmResult = true;
  await r9.children[1].onclick(); // Add
  await new Promise(r => setTimeout(r, 20));
  assert(hits.some(h => h === 'POST api/items/staples/s9/add'), 'Add button POSTs to /staples/:id/add, got: ' + JSON.stringify(hits));
  hits = [];
  await r9.children[2].onclick(); // x
  await new Promise(r => setTimeout(r, 20));
  assert(hits.some(h => h === 'DELETE api/items/staples/s9'), 'x button DELETEs /staples/:id, got: ' + JSON.stringify(hits));
  assert(!hits.some(h => h.includes('/add')), 'x button does NOT add');

  // 10. open sheet live-updates on delete and new-staple (no close/reopen needed)
  let serverStaples = [{id:'a1', name:'Milk', store:'heb', qty:'', note:''}];
  __fetchImpl = async (url, opts) => {
    const m = (opts && opts.method) || 'GET';
    if (url === 'api/items/staples' && m === 'GET') return { ok:true, status:200, json: async () => serverStaples.slice() };
    if (url === 'api/items/staples' && m === 'POST') {
      const b = JSON.parse(opts.body);
      serverStaples.push({id:'n' + serverStaples.length, name:b.name, store:b.store, qty:'', note:''});
      return { ok:true, status:201, json: async () => ({}) };
    }
    if (m === 'DELETE') {
      const id = url.split('/staples/')[1];
      serverStaples = serverStaples.filter(s => s.id !== id);
      return { ok:true, status:200, json: async () => ({}) };
    }
    return { ok:true, status:200, json: async () => [] };
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
  staples = [];
  __confirmResult = true;
  openStapleSheet();
  await loadStaples();
  await tick();
  let sl = document.getElementById('stapleList');
  assert(sl.children.length === 1 && sl.children[0].className === 'staplerow', 'sheet shows the staple');
  await sl.children[0].children[2].onclick(); // x -> delete
  await tick(); await tick();
  sl = document.getElementById('stapleList');
  assert(sl.children.length === 1 && sl.children[0].className === 'sheetSub', 'deleted staple disappears without reopening');
  await document.getElementById('stapleNew').onclick(); // prompt stub returns 'TestStaple'
  await tick(); await tick();
  sl = document.getElementById('stapleList');
  assert(sl.children.length === 1 && sl.children[0].className === 'staplerow' &&
    sl.children[0].children[0].children[0].textContent === 'TestStaple',
    'new staple appears without reopening, got: ' + JSON.stringify(sl.children[0].children[0].children[0].textContent));
  closeStapleSheet();

  // 11. grab handle drag: long pull dismisses, short pull snaps back
  const dcard = makeEl(); const dgrab = makeEl();
  dgrab.parentNode = dcard;
  __els['stapleGrab'] = dgrab;
  initSheetDrag('stapleGrab', closeStapleSheet);
  stapleSheetOpen = true;
  dgrab.fire('touchstart', { touches:[{clientY:200}] });
  dgrab.fire('touchmove', { touches:[{clientY:340}], cancelable:true, preventDefault(){} });
  assert(dcard.style.transform === 'translateY(140px)', 'sheet follows finger, got: ' + dcard.style.transform);
  dgrab.fire('touchend', {});
  assert(stapleSheetOpen === false, 'long pull dismisses the sheet');
  assert(dcard.style.transform === '', 'transform reset after dismiss');
  stapleSheetOpen = true;
  dgrab.fire('touchstart', { touches:[{clientY:200}] });
  dgrab.fire('touchmove', { touches:[{clientY:230}], cancelable:true, preventDefault(){} });
  dgrab.fire('touchend', {});
  assert(dcard.style.transform === '', 'short pull snaps back');
  assert(stapleSheetOpen === true, 'short pull keeps sheet open');

  console.log('DONE');
  process.exit(process.exitCode || 0);
})();
`;
eval(harness + script + tests);
