#!/usr/bin/env node
/**
 * Rhino-style unit-test runner for BAW transform scripts.
 *
 * Loads the script into a sandbox with a strict mock `tw` (built from the
 * XSDs), then runs test cases from a JSON spec. Runtime errors are reported
 * with the offending script line, extracted from the stack trace.
 *
 * Usage: node run-tests.js <script.js> <tests.json> [xsdDir]
 *
 * Test spec format:
 * {
 *   "function": "convertAddressWsToAddress",
 *   "cases": [
 *     { "name": "...", "input": { "type": "AddressWS", "value": {...} },
 *       "expect": { "type": "Address", "value": {...} } }
 *   ]
 * }
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadTypes } = require('./lib/xsd');
const { buildTw, makeTyped } = require('./lib/mock-tw');

function extractLine(err, scriptName) {
  const m = (err.stack || '').split('\n').map(l => {
    const r = new RegExp(`${scriptName.replace('.', '\\.')}:(\\d+)`).exec(l);
    return r ? parseInt(r[1], 10) : null;
  }).find(l => l !== null);
  return m || null;
}

function run(scriptPath, specPath, xsdDir) {
  const scriptName = path.basename(scriptPath);
  const src = fs.readFileSync(scriptPath, 'utf8');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const types = loadTypes(xsdDir);
  const tw = buildTw(types);

  const sandbox = { tw };
  vm.createContext(sandbox);

  // Load the script (Rhino ES5-style: function declarations become sandbox globals)
  try {
    vm.runInContext(src, sandbox, { filename: scriptName });
  } catch (e) {
    const line = extractLine(e, scriptName);
    console.log(`LOAD ERROR ${scriptName}${line ? ':' + line : ''}  ${e.message}`);
    process.exit(1);
  }

  const fn = sandbox[spec.function];
  if (typeof fn !== 'function') {
    console.log(`ERROR: function "${spec.function}" not found in ${scriptName}`);
    process.exit(1);
  }

  let passed = 0, failed = 0;
  for (const tc of spec.cases) {
    const label = tc.name || JSON.stringify(tc.input.value);
    let result;
    try {
      const input = makeTyped(tw, tc.input.type, tc.input.value);
      result = fn(input);
    } catch (e) {
      const line = extractLine(e, scriptName);
      console.log(`FAIL  ${label}`);
      console.log(`      runtime error at ${scriptName}${line ? ':' + line : ''}  ${e.message}`);
      failed++;
      continue;
    }

    // Compare result to expected
    const problems = [];
    if (tc.expect.type && result && result.__type__ !== tc.expect.type)
      problems.push(`expected result type "${tc.expect.type}", got "${result && result.__type__}"`);
    for (const [k, v] of Object.entries(tc.expect.value || {})) {
      let actual;
      try { actual = result[k]; }
      catch (e) { problems.push(`reading result.${k}: ${e.message}`); continue; }
      if (actual !== v) problems.push(`result.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`);
    }
    if (problems.length === 0) { console.log(`PASS  ${label}`); passed++; }
    else {
      console.log(`FAIL  ${label}`);
      for (const p of problems) console.log(`      ${p}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  const [scriptPath, specPath, xsdDirArg] = process.argv.slice(2);
  if (!scriptPath || !specPath) {
    console.error('Usage: node run-tests.js <script.js> <tests.json> [xsdDir]');
    process.exit(2);
  }
  run(scriptPath, specPath, xsdDirArg || path.dirname(path.resolve(scriptPath)));
}
