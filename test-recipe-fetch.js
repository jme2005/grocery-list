// Tests for recipe URL import: isSafeRecipeUrl + extractRecipeFromHtml.
// Run: node test-recipe-fetch.js   (exit 0 = all assertions passed)
import fs from 'fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

function grab(name) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'));
  if (!m) throw new Error('function not found: ' + name);
  return m[0];
}
eval(grab('isSafeRecipeUrl') + '\n' + grab('findRecipeNode') + '\n' + grab('extractRecipeFromHtml'));
// eval runs in module strict mode, so pull the declarations out via new Function instead.
const getFns = new Function(grab('isSafeRecipeUrl') + '\n' + grab('findRecipeNode') + '\n' +
  grab('extractRecipeFromHtml') + '\nreturn { isSafeRecipeUrl: isSafeRecipeUrl, extractRecipeFromHtml: extractRecipeFromHtml };');
const fns = getFns();
const isSafeRecipeUrl = fns.isSafeRecipeUrl;
const extractRecipeFromHtml = fns.extractRecipeFromHtml;

let n = 0;
function ok(cond, label) {
  n++;
  if (!cond) { console.error('not ok ' + n + ' - ' + label); process.exitCode = 1; }
  else console.log('ok ' + n + ' - ' + label);
}

// ---- URL safety ----
ok(isSafeRecipeUrl('https://www.example.com/recipes/soup'), 'https recipe url allowed');
ok(isSafeRecipeUrl('http://food-blog.example/recipe'), 'http recipe url allowed');
ok(!isSafeRecipeUrl('ftp://example.com/x'), 'non-http scheme rejected');
ok(!isSafeRecipeUrl('javascript:alert(1)'), 'javascript scheme rejected');
ok(!isSafeRecipeUrl('http://localhost/recipe'), 'localhost rejected');
ok(!isSafeRecipeUrl('http://127.0.0.1/recipe'), 'loopback ip rejected');
ok(!isSafeRecipeUrl('http://10.0.0.5/x'), '10/8 rejected');
ok(!isSafeRecipeUrl('http://192.168.1.1/x'), '192.168/16 rejected');
ok(!isSafeRecipeUrl('http://172.16.4.2/x'), '172.16/12 rejected');
ok(!isSafeRecipeUrl('http://169.254.169.254/x'), 'link-local rejected');
ok(!isSafeRecipeUrl('not a url'), 'garbage rejected');
ok(!isSafeRecipeUrl(''), 'empty rejected');

// ---- JSON-LD extraction ----
const html1 = '<html><head><script type="application/ld+json">' +
  JSON.stringify({ '@context': 'https://schema.org', '@type': 'Recipe', name: 'Tomato Soup',
    recipeIngredient: ['2 cups tomatoes', ' 1 onion ', '', 42] }) +
  '</scr' + 'ipt></head><body></body></html>';
const r1 = extractRecipeFromHtml(html1);
ok(r1 && r1.name === 'Tomato Soup', 'extracts recipe name');
ok(r1 && r1.ingredients.length === 2 && r1.ingredients[0] === '2 cups tomatoes' && r1.ingredients[1] === '1 onion',
  'extracts + trims ingredients, drops blanks/non-strings');

// nested in @graph, @type as array
const html2 = '<script type="application/ld+json">' +
  JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: 'x' },
    { '@type': ['CreativeWork', 'Recipe'], name: 'Pasta', recipeIngredient: ['200g pasta'] }
  ] }) + '</scr' + 'ipt>';
const r2 = extractRecipeFromHtml(html2);
ok(r2 && r2.name === 'Pasta' && r2.ingredients[0] === '200g pasta', 'finds recipe inside @graph with @type array');

// multiple scripts: first without recipe, second with
const html3 = '<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</scr' + 'ipt>' +
  '<script type="application/ld+json">{"@type":"Recipe","name":"Salad","recipeIngredient":["lettuce"]}</scr' + 'ipt>';
const r3 = extractRecipeFromHtml(html3);
ok(r3 && r3.name === 'Salad', 'skips non-recipe scripts');

// malformed JSON-LD skipped, valid one still found
const html4 = '<script type="application/ld+json">{not json</scr' + 'ipt>' +
  '<script type="application/ld+json">{"@type":"Recipe","recipeIngredient":["eggs"]}</scr' + 'ipt>';
const r4 = extractRecipeFromHtml(html4);
ok(r4 && r4.ingredients[0] === 'eggs', 'survives malformed JSON-LD');

// no recipe at all
ok(extractRecipeFromHtml('<html><body>no scripts here</body></html>') === null, 'null when no recipe present');
ok(extractRecipeFromHtml('<script type="application/ld+json">{"@type":"Article"}</scr' + 'ipt>') === null,
  'null when scripts have no recipe');

// cap at 100 ingredients
const many = [];
for (let i = 0; i < 150; i++) many.push('ingredient ' + i);
const html5 = '<script type="application/ld+json">' +
  JSON.stringify({ '@type': 'Recipe', recipeIngredient: many }) + '</scr' + 'ipt>';
ok(extractRecipeFromHtml(html5).ingredients.length === 100, 'ingredients capped at 100');

// ---- endpoint + client wiring present in worker ----
ok(src.includes("rest[0] === 'recipe-fetch'"), 'recipe-fetch endpoint registered');
ok(src.includes('id="recipeUrl"') && src.includes('id="recipeFetch"') && src.includes('id="recipeMsg"'),
  'recipe sheet has url input, fetch button, message line');
ok(src.includes("api/items/recipe-fetch"), 'client posts to the endpoint');
console.log('DONE');
