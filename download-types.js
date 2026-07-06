#!/usr/bin/env node
/**
 * Downloads all business object type definitions (JSON) from a BAW server
 * for a given process app, per the REST flow:
 *
 *   1. GET {baseUrl}/rest/bpm/wle/v1/assets?processAppId={id}
 *      -> data.VariableType[] gives { name, poId }
 *   2. For each type:
 *      GET {baseUrl}/rest/bpm/wle/v1/businessobject/{poId}?processAppId={id}
 *      -> saved as {outDir}/{name}.json
 *
 * The saved JSONs are understood by all tools here (validate.js, run-tests.js,
 * generate.js, generate-test.js) — no XSDs needed.
 *
 * Usage:
 *   node download-types.js <baseUrl> <processAppId> [outDir] [options]
 *
 * Options:
 *   --user user:pass     Basic auth (or env BAW_USER / BAW_PASSWORD)
 *   --only A,B,C         Only download these types
 *   --insecure           Accept self-signed TLS certificates
 *
 * Example:
 *   node download-types.js <<baseurl>> \
 *     2066.54cef352-33fe-4e50-be89-162731bcf981 types --user admin:pass --insecure
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { positional: [], user: null, only: null, insecure: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') args.user = argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i].split(',').map(s => s.trim());
    else if (argv[i] === '--insecure') args.insecure = true;
    else args.positional.push(argv[i]);
  }
  return args;
}

function authHeader(user) {
  const cred = user || (process.env.BAW_USER ? `${process.env.BAW_USER}:${process.env.BAW_PASSWORD || ''}` : null);
  return cred ? { Authorization: 'Basic ' + Buffer.from(cred).toString('base64') } : {};
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Response is not JSON (login page?) for ${url}: ${text.slice(0, 100).replace(/\n/g, ' ')}`); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [baseUrl, processAppId, outDirArg] = args.positional;
  if (!baseUrl || !processAppId) {
    console.error('Usage: node download-types.js <baseUrl> <processAppId> [outDir] [--user user:pass] [--only A,B] [--insecure]');
    process.exit(2);
  }
  if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const base = baseUrl.replace(/\/+$/, '');
  const outDir = outDirArg || './types';
  const headers = Object.assign({
    Accept: 'application/json',
    'Accept-Language': 'en',
    'Content-Type': 'application/x-www-form-urlencoded',
    Pragma: 'no-cache',
  }, authHeader(args.user));

  // --- 1. List variable types for the process app ---
  const assetsUrl = `${base}/rest/bpm/wle/v1/assets?processAppId=${encodeURIComponent(processAppId)}`;
  console.log(`Fetching asset list: ${assetsUrl}`);
  const assets = await getJson(assetsUrl, headers);
  let variableTypes = ((assets.data && assets.data.VariableType) || [])
    .filter(v => v.name && v.poId);
  if (variableTypes.length === 0) {
    console.error('No VariableType entries found in assets response.');
    process.exit(1);
  }
  if (args.only) variableTypes = variableTypes.filter(v => args.only.includes(v.name));
  console.log(`Found ${variableTypes.length} type(s): ${variableTypes.map(v => v.name).join(', ')}\n`);

  fs.mkdirSync(outDir, { recursive: true });

  // --- 2. Download each business object definition ---
  let ok = 0, failed = 0;
  for (const { name, poId } of variableTypes) {
    const url = `${base}/rest/bpm/wle/v1/businessobject/${encodeURIComponent(poId)}?processAppId=${encodeURIComponent(processAppId)}`;
    try {
      const bo = await getJson(url, headers);
      const data = bo.data || bo;
      if (!data.name || !Array.isArray(data.properties)) {
        console.log(`WARN  ${name}: response has no properties array (skipped)`);
        failed++;
        continue;
      }
      const file = path.join(outDir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(bo, null, 2) + '\n');
      console.log(`OK    ${name} (${poId}) -> ${file}  [${data.properties.length} properties]`);
      ok++;
    } catch (e) {
      console.log(`FAIL  ${name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${ok} downloaded, ${failed} failed. Output: ${path.resolve(outDir)}`);
  if (ok > 0) console.log(`Next: node validate.js <script.js> ${outDir}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
