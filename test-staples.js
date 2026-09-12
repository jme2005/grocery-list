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
  const e = { children:[], _html:'', textContent:'', value:'', src:'', title:'', style:{},
  classList:{ add(){}, remove(){}, toggle(){}, contains(){return false;} },
  appendChild(c){ this.children.push(c); return c; },
  addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
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

  console.log('DONE');
  process.exit(process.exitCode || 0);
})();
`;
eval(harness + script + tests);
