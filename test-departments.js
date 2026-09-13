// Tests for department grouping: deptOf() keyword mapping + overrides.
// Run: node test-departments.js   (exit 0 = all assertions passed)
import fs from 'fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

// deptOf lives inside the PAGE template literal, so test the RENDERED script
// (backslashes are processed when the worker serves the page).
const stub = 'const STORES=[]; const STORE_LABEL={}; const SW_JS="";';
const tplMatch = src.match(/const PAGE = (`[\s\S]*?`);/);
if (!tplMatch) throw new Error('PAGE template not found');
eval(stub + 'const PAGE = ' + tplMatch[1] + '; globalThis.__page = PAGE;');
const script = globalThis.__page.split('<script>')[1].split('</script>')[0];

function grab(re) {
  const m = script.match(re);
  if (!m) throw new Error('not found: ' + re);
  return m[0];
}
const getFns = new Function(
  grab(/var DEPTS = \[[\s\S]*?\];/) + '\n' +
  grab(/var DEPT_ORDER = \{\};[\s\S]*?\}\);/) + '\n' +
  grab(/var DEPT_KEYS = \[[\s\S]*?\n\];/) + '\n' +
  grab(/function deptOf\(name, overrides\) \{[\s\S]*?\n\}/) + '\n' +
  'return { DEPTS: DEPTS, DEPT_KEYS: DEPT_KEYS, deptOf: deptOf };'
);
const { DEPTS, DEPT_KEYS, deptOf } = getFns();

let n = 0;
function ok(cond, label) {
  n++;
  if (!cond) { console.error('not ok ' + n + ' - ' + label); process.exitCode = 1; }
  else console.log('ok ' + n + ' - ' + label);
}
const t = (name, dept, ov) => ok(deptOf(name, ov) === dept, JSON.stringify(name) + ' → ' + dept);

// walking order sanity
ok(DEPTS[0] === 'Produce' && DEPTS[DEPTS.length - 1] === 'Other', 'Produce first, Other last');
ok(DEPT_KEYS.every(function (k) { return DEPTS.indexOf(k[1]) >= 0; }), 'every keyword maps to a known dept');

// traps: phrases beat the single words they contain
t('peanut butter', 'Pantry');
t('black pepper', 'Pantry');
t('bell peppers', 'Produce');
t('bread crumbs', 'Pantry');
t('whole wheat bread', 'Bakery');
t('mac and cheese', 'Pantry');
t('cheddar cheese', 'Dairy & Eggs');
t('coconut milk', 'Pantry');
t('whole milk', 'Dairy & Eggs');
t('coconut', 'Produce');
t('orange juice', 'Beverages');
t('oranges', 'Produce');
t('green beans', 'Produce');
t('black beans', 'Pantry');
t('tomato sauce', 'Pantry');
t('cherry tomatoes', 'Produce');
t('ice cream', 'Frozen');
t('frozen pizza', 'Frozen');
t('pizza dough', 'Deli & Prepared');
t('rotisserie chicken', 'Deli & Prepared');
t('chicken breast', 'Meat & Seafood');
t('tuna steak', 'Meat & Seafood');
t('canned tuna', 'Pantry');
t('coffee creamer', 'Dairy & Eggs');
t('cold brew coffee', 'Beverages');
t('cookie dough', 'Dairy & Eggs');
t('chocolate chip cookies', 'Snacks');
t('eggplant', 'Produce');
t('eggs', 'Dairy & Eggs');
t('crab cake', 'Meat & Seafood');
t('granola bar', 'Snacks');
t('granola', 'Pantry');
t('rice cakes', 'Snacks');
t('jasmine rice', 'Pantry');
t('donut holes', 'Bakery');
t('candy corn', 'Snacks');
t('corn tortillas', 'Bakery');

// core departments
t('bananas', 'Produce');
t('salmon', 'Meat & Seafood');
t('greek yogurt', 'Dairy & Eggs');
t('sourdough', 'Other'); // no keyword: lands in Other, honest miss
t('paper towels', 'Household');
t('sparkling water', 'Beverages');
t('potato chips', 'Snacks');
t('olive oil', 'Pantry');
t('hummus', 'Deli & Prepared');
t('croissants', 'Bakery');
t('xyzzy plugh', 'Other');

// plurals + case
t('Apples', 'Produce');
t('CHICKEN THIGHS', 'Meat & Seafood');

// overrides
t('dragonfruit', 'Snacks', { dragonfruit: 'Snacks' });
t('milk', 'Beverages', { milk: 'Beverages' }); // override beats keyword
t('milk', 'Dairy & Eggs', { milk: 'Nope' }); // invalid override dept ignored
t('milk', 'Dairy & Eggs', null);
t('milk', 'Dairy & Eggs', {});

// endpoint + UI wiring present
ok(src.includes("rest[0] === 'dept-overrides'"), 'dept-overrides endpoint registered');
ok(src.includes('id="detailDept"'), 'detail sheet has department picker');
ok(src.includes('depthead'), 'render emits department headers');
ok(src.includes('loadDeptOverrides()'), 'overrides loaded at init');

// regression: DEPTS must be assigned before any DEPTS.forEach runs in the
// served script (a use-before-definition throws and kills the whole app).
ok(script.indexOf('var DEPTS = [') < script.indexOf('DEPTS.forEach'),
  'var DEPTS assigned before first DEPTS.forEach in served script');
console.log('DONE');
