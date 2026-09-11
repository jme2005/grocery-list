// Regression test: verify the PAGE the worker actually serves.
//
// worker.js embeds the whole page in a JS template literal. Backslashes in
// that literal are processed when the worker runs, so the client script must
// be checked AFTER rendering, not just with `node --check worker.js` (which
// only sees the unrendered template). A dropped backslash (e.g. /\+/g served
// as /+/g) is a silent page-killer: the browser refuses the entire script
// block, so no banner, no handlers, static HTML only.
//
// Run: node test-render.js   (exit 0 = served page script is valid)
import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const stub = 'const STORES=[]; const STORE_LABEL={}; const SW_JS="";';
const tplMatch = src.match(/const PAGE = (`[\s\S]*?`);/);
if (!tplMatch) { console.error('FAIL: PAGE template not found'); process.exit(1); }
eval(stub + 'const PAGE = ' + tplMatch[1] + '; globalThis.__page = PAGE;');
const html = globalThis.__page;

const parts = html.split('<script>');
if (parts.length !== 2 || !parts[1].includes('</script>')) {
  console.error('FAIL: expected exactly one script block in served page');
  process.exit(1);
}
const script = parts[1].split('</script>')[0];
const tmp = path.join(os.tmpdir(), 'grocery-rendered-script.js');
fs.writeFileSync(tmp, script);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('FAIL: served page script has a syntax error:');
  console.error(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}
// The served script must not contain regexes broken by template-literal
// backslash processing (the Sep 11, 2026 outage: /\+/g served as /+/g).
if (/[^\\]\/\+[^\\]/.test(script) && script.includes('replace(/+/g')) {
  console.error('FAIL: served script contains /+/g (backslash was eaten by the template literal)');
  process.exit(1);
}
console.log('OK: served page script parses cleanly');
