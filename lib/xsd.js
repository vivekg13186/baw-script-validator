/**
 * XSD parser: extracts BAW business object type definitions from .xsd files.
 * Returns { TypeName: { properties: { propName: { xsType, nillable, minOccurs, maxOccurs, isList } } } }
 */
const fs = require('fs');
const path = require('path');

// Map xs primitive types to expected JS typeof (Rhino)
const XS_TO_JS = {
  'xs:string': 'string',
  'xs:boolean': 'boolean',
  'xs:integer': 'number',
  'xs:int': 'number',
  'xs:long': 'number',
  'xs:short': 'number',
  'xs:decimal': 'number',
  'xs:double': 'number',
  'xs:float': 'number',
  'xs:date': 'object', // TWDate
  'xs:dateTime': 'object',
  'xs:time': 'object',
  'xs:anyType': 'any',
};

function parseXsdFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const types = {};
  // Match each complexType block
  const ctRe = /<xs:complexType\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/xs:complexType>/g;
  let ct;
  while ((ct = ctRe.exec(xml)) !== null) {
    const typeName = ct[1];
    const body = ct[2];
    const properties = {};
    const elRe = /<xs:element\s+([^/>]*)\/?>/g;
    let el;
    while ((el = elRe.exec(body)) !== null) {
      const attrs = {};
      const attrRe = /(\w+)="([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(el[1])) !== null) attrs[a[1]] = a[2];
      if (!attrs.name) continue;
      properties[attrs.name] = {
        xsType: attrs.type || 'xs:anyType',
        jsType: XS_TO_JS[attrs.type] || 'object', // non-primitive => nested BO
        nillable: attrs.nillable === 'true',
        minOccurs: attrs.minOccurs !== undefined ? parseInt(attrs.minOccurs, 10) : 1,
        maxOccurs: attrs.maxOccurs === 'unbounded' ? Infinity
          : attrs.maxOccurs !== undefined ? parseInt(attrs.maxOccurs, 10) : 1,
      };
      properties[attrs.name].isList = properties[attrs.name].maxOccurs > 1;
    }
    types[typeName] = { properties, source: path.basename(filePath) };
  }
  return types;
}

/** Load every .xsd in a directory into one type registry. */
function loadTypes(dir) {
  const registry = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.xsd')) continue;
    const types = parseXsdFile(path.join(dir, f));
    for (const [name, def] of Object.entries(types)) {
      if (registry[name]) {
        throw new Error(`Duplicate type "${name}" defined in ${registry[name].source} and ${def.source}`);
      }
      registry[name] = def;
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

module.exports = { loadTypes, parseXsdFile, suggest, XS_TO_JS };
