/**
 * Type loader: reads BAW business object definitions from .json files
 * (REST /businessobject/{poId} responses, as saved by download-types.js).
 * Returns { TypeName: { properties: { propName: { xsType, jsType, isList, maxOccurs, ... } } } }
 */
const fs = require('fs');
const path = require('path');

// Map BAW REST typeClass values to canonical xs types (complex types fall through)
const TYPECLASS_TO_XS = {
  String: 'xs:string', Integer: 'xs:integer', Decimal: 'xs:decimal',
  Boolean: 'xs:boolean', Date: 'xs:date', Time: 'xs:time', ANY: 'xs:anyType',
};

// Map canonical xs types to expected JS typeof (Rhino)
const XS_TO_JS = {
  'xs:string': 'string',
  'xs:boolean': 'boolean',
  'xs:integer': 'number',
  'xs:decimal': 'number',
  'xs:date': 'object', // TWDate
  'xs:time': 'object',
  'xs:anyType': 'any',
};

/**
 * Parse a saved /businessobject/{poId} REST response (or its bare `data`).
 * Format: { data: { name, isComplex, properties: [{ name, typeClass, isArray }] } }
 */
function parseTypeJsonFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const bo = raw.data || raw;
  if (!bo || !bo.name || !Array.isArray(bo.properties)) return null; // not a BO file
  const properties = {};
  for (const p of bo.properties) {
    if (!p.name) continue;
    const xsType = TYPECLASS_TO_XS[p.typeClass] || ('tns:' + p.typeClass);
    properties[p.name] = {
      xsType,
      jsType: XS_TO_JS[xsType] || 'object', // non-primitive => nested BO
      isList: !!p.isArray,
      maxOccurs: p.isArray ? Infinity : 1,
    };
  }
  return { [bo.name]: { properties, source: path.basename(filePath) } };
}

/** Canonical fingerprint of a type's structure (sorted, source-independent). */
function fingerprint(def) {
  const props = Object.keys(def.properties).sort().map(p => {
    const d = def.properties[p];
    return [p, d.xsType, d.isList];
  });
  return JSON.stringify(props);
}

/** Human-readable diff between two conflicting definitions of the same type. */
function diffTypes(a, b) {
  const aProps = Object.keys(a.properties), bProps = Object.keys(b.properties);
  const lines = [];
  for (const p of aProps.filter(p => !bProps.includes(p))) lines.push(`  - "${p}" only in ${a.source}`);
  for (const p of bProps.filter(p => !aProps.includes(p))) lines.push(`  - "${p}" only in ${b.source}`);
  for (const p of aProps.filter(p => bProps.includes(p))) {
    const x = a.properties[p], y = b.properties[p];
    if (x.xsType !== y.xsType) lines.push(`  - "${p}": ${x.xsType} in ${a.source} vs ${y.xsType} in ${b.source}`);
    else if (x.isList !== y.isList) lines.push(`  - "${p}": list in ${x.isList ? a.source : b.source} but single in ${x.isList ? b.source : a.source}`);
  }
  return lines.join('\n');
}

const isTypeFile = (f) => {
  const l = f.toLowerCase();
  return l.endsWith('.json') && !l.endsWith('.test.json') && l !== 'package.json' && l !== 'package-lock.json';
};

/**
 * Load every business object .json in a directory into one type registry.
 * Identical duplicate definitions are merged; a duplicate with a DIFFERENT
 * structure is a real conflict and raises an error with a diff.
 */
function loadTypes(dir) {
  const registry = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!isTypeFile(f)) continue;
    let types = null;
    try { types = parseTypeJsonFile(path.join(dir, f)); } catch (e) { /* not a BO json — skip */ }
    if (!types) continue;
    for (const [name, def] of Object.entries(types)) {
      const existing = registry[name];
      if (!existing) {
        def.sources = [def.source];
        registry[name] = def;
      } else if (fingerprint(existing) === fingerprint(def)) {
        existing.sources.push(def.source); // identical duplicate — dedupe
      } else {
        throw new Error(
          `Conflicting definitions of type "${name}" in ${existing.source} and ${def.source}:\n` +
          diffTypes(existing, def) +
          `\nFix: make both definitions identical, or remove the stale copy.`);
      }
    }
  }
  return registry;
}

/** Suggest closest type/property name (simple edit distance). */
function suggest(name, candidates) {
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[m][n];
}

/** Default type dir for a script: its own folder if it has type files, else ./types. */
function defaultTypesDir(scriptPath) {
  const dir = path.dirname(path.resolve(scriptPath));
  const hasTypes = (d) => fs.existsSync(d) && fs.readdirSync(d).some(isTypeFile);
  if (hasTypes(dir)) return dir;
  if (hasTypes('types')) return 'types';
  return dir;
}

module.exports = { loadTypes, suggest, defaultTypesDir };
