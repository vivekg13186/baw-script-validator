#!/usr/bin/env node
/**
 * Downloads all business object XSDs from an IBM BAW server for a given branch.
 *
 * Flow:
 *   1. GET {baseUrl}/rest/bpm/wle/v1/assets?branchId={branchId}
 *      -> data.VariableType[] gives the type names
 *   2. For each type:
 *      GET {baseUrl}/WebPD/jsp/ViewSchema.jsp?type={name}&version={branchId}
 *      -> saved as {outDir}/{name}.xsd
 *
 * Usage:
 *   node download-xsds.js <baseUrl> <branchId> [outDir] [options]
 *
 * Options:
 *   --user user:pass     Basic auth (or set env BAW_USER / BAW_PASSWORD)
 *   --only A,B,C         Only download these types
 *   --insecure           Accept self-signed TLS certificates
 *
 * Example:
 *   node download-xsds.js https://baw.example.com:9443 2063.fe0f0969-81df-4d09-b816-afd39dcfe8e8 ./xsds --user admin:admin --insecure
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

async function fetchOk(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [baseUrl, branchId, outDirArg] = args.positional;
  if (!baseUrl || !branchId) {
    console.error('Usage: node download-xsds.js <baseUrl> <branchId> [outDir] [--user user:pass] [--only A,B] [--insecure]');
    process.exit(2);
  }
  if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const base = baseUrl.replace(/\/+$/, '');
  const outDir = outDirArg || './xsds';
  const headers = Object.assign({ Accept: 'application/json' }, authHeader(args.user));

  // --- 1. List variable types on the branch ---
  const assetsUrl = `${base}/rest/bpm/wle/v1/assets?branchId=${encodeURIComponent(branchId)}`;
  console.log(`Fetching type list: ${assetsUrl}`);
  const body = await (await fetchOk(assetsUrl, headers)).json();
  const variableTypes = (body.data && body.data.VariableType) || [];
  let names = variableTypes.map(v => v.name).filter(Boolean);
  if (names.length === 0) {
    console.error('No VariableType entries found in assets response.');
    process.exit(1);
  }
  if (args.only) names = names.filter(n => args.only.includes(n));
  console.log(`Found ${names.length} type(s): ${names.join(', ')}\n`);

  fs.mkdirSync(outDir, { recursive: true });

  // --- 2. Download each XSD ---
  let ok = 0, failed = 0;
  for (const name of names) {
    const url = `${base}/WebPD/jsp/ViewSchema.jsp?type=${encodeURIComponent(name)}&version=${encodeURIComponent(branchId)}`;
    try {
      const res = await fetchOk(url, authHeader(args.user));
      const xsd = (await res.text()).trim();
      if (!/<xs(d)?:schema|<schema/i.test(xsd)) {
        console.log(`WARN  ${name}: response does not look like an XSD (skipped). First 120 chars:\n      ${xsd.slice(0, 120).replace(/\n/g, ' ')}`);
        failed++;
        continue;
      }
      const file = path.join(outDir, `${name}.xsd`);
      fs.writeFileSync(file, xsd + '\n');
      console.log(`OK    ${name} -> ${file}`);
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
