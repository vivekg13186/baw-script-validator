#!/usr/bin/env node
/**
 * Transform-code generator for IBM BAW (Rhino/ES5).
 *
 * Given a source and target business object type (from the XSDs), generates
 * a convert function that maps matching properties. Handles:
 *   - nested business objects (generates + reuses helper converters recursively)
 *   - BAW lists (maxOccurs > 1): new tw.object.listOf.X() + insertIntoList
 *   - null-safety guards
 *   - TODO comments for target properties with no matching source property
 *
 * Output passes validate.js and is unit-testable with run-tests.js.
 *
 * Usage: node generate.js <SourceType> <TargetType> [xsdDir] [-o out.js]
 */
const fs = require('fs');
const path = require('path');
const { loadTypes } = require('./lib/xsd');

const localName = (xsType) => xsType.replace(/^\w+:/, '');
const isPrimitive = (xsType) => xsType.startsWith('xs:');
// BAW primitive list types: tw.object.listOf.String, .Integer, .Decimal, .Boolean, .Date
const BAW_LIST_PRIMS = {
  'xs:string': 'String', 'xs:boolean': 'Boolean', 'xs:integer': 'Integer',
  'xs:int': 'Integer', 'xs:long': 'Integer', 'xs:short': 'Integer',
  'xs:decimal': 'Decimal', 'xs:double': 'Decimal', 'xs:float': 'Decimal',
  'xs:date': 'Date', 'xs:dateTime': 'Date', 'xs:time': 'Time',
};
const fnName = (s, t) => 'convert' + s + 'To' + t;

function generate(sourceType, targetType, types) {
  const emitted = new Map(); // "S->T" -> function source
  const order = [];          // emission order (helpers first)

  function emitConverter(S, T) {
    const key = S + '->' + T;
    if (emitted.has(key)) return fnName(S, T);
    emitted.set(key, null); // reserve (guards against cycles)

    const src = types[S], tgt = types[T];
    if (!src) throw new Error(`Source type "${S}" not found in XSDs`);
    if (!tgt) throw new Error(`Target type "${T}" not found in XSDs`);

    const srcVar = S.charAt(0).toLowerCase() + S.slice(1);
    const lines = [];
    const usedSourceProps = new Set();

    lines.push('/**');
    lines.push(` * Converts a ${S} object to a ${T} object.`);
    lines.push(` * @param {${S}} ${srcVar} - The ${S} object to be converted.`);
    lines.push(` * @returns {${T}} - The converted ${T} object.`);
    lines.push(' */');
    lines.push(`function ${fnName(S, T)}(${srcVar}) {`);
    lines.push(`    if (${srcVar} == null) {`);
    lines.push('        return null;');
    lines.push('    }');
    lines.push(`    var result = new tw.object.${T}();`);

    for (const [prop, tDef] of Object.entries(tgt.properties)) {
      const sDef = src.properties[prop];
      if (!sDef) {
        lines.push(`    // TODO: "${T}.${prop}" has no matching property on "${S}" — map manually if needed`);
        continue;
      }
      usedSourceProps.add(prop);
      const sPrim = isPrimitive(sDef.xsType);
      const tPrim = isPrimitive(tDef.xsType);

      if (sDef.isList !== tDef.isList) {
        lines.push(`    // TODO: "${prop}" is ${sDef.isList ? 'a list' : 'single'} on ${S} but ${tDef.isList ? 'a list' : 'single'} on ${T} — map manually`);
        continue;
      }

      if (!sDef.isList) {
        if (sPrim && tPrim) {
          if (sDef.xsType !== tDef.xsType)
            lines.push(`    // NOTE: type differs (${S}.${prop}: ${sDef.xsType} -> ${T}.${prop}: ${tDef.xsType})`);
          lines.push(`    result.${prop} = ${srcVar}.${prop};`);
        } else if (!sPrim && !tPrim) {
          const helper = emitConverter(localName(sDef.xsType), localName(tDef.xsType));
          lines.push(`    result.${prop} = ${helper}(${srcVar}.${prop});`);
        } else {
          lines.push(`    // TODO: "${prop}" mixes primitive and complex types (${sDef.xsType} -> ${tDef.xsType}) — map manually`);
        }
        continue;
      }

      // list -> list
      const idx = 'i';
      lines.push(`    result.${prop} = new tw.object.listOf.${tPrim ? (BAW_LIST_PRIMS[tDef.xsType] || 'String') : localName(tDef.xsType)}();`);
      lines.push(`    if (${srcVar}.${prop} != null) {`);
      lines.push(`        for (var ${idx} = 0; ${idx} < ${srcVar}.${prop}.listLength; ${idx}++) {`);
      if (sPrim && tPrim) {
        lines.push(`            result.${prop}.insertIntoList(result.${prop}.listLength, ${srcVar}.${prop}[${idx}]);`);
      } else if (!sPrim && !tPrim) {
        const helper = emitConverter(localName(sDef.xsType), localName(tDef.xsType));
        lines.push(`            result.${prop}.insertIntoList(result.${prop}.listLength, ${helper}(${srcVar}.${prop}[${idx}]));`);
      } else {
        lines.push(`            // TODO: list "${prop}" mixes primitive and complex element types — map manually`);
      }
      lines.push('        }');
      lines.push('    }');
    }

    const unused = Object.keys(src.properties).filter(p => !usedSourceProps.has(p));
    if (unused.length)
      lines.push(`    // NOTE: source properties not mapped (no counterpart on ${T}): ${unused.join(', ')}`);

    lines.push('    return result;');
    lines.push('}');

    emitted.set(key, lines.join('\n'));
    order.push(key);
    return fnName(S, T);
  }

  emitConverter(sourceType, targetType);
  const header = `/* Generated by generate.js on ${new Date().toISOString().slice(0, 10)} — ${sourceType} -> ${targetType} (Rhino/ES5, IBM BAW) */\n`;
  // order has helpers appended after their callers reserve them; emit main last-in-first:
  return header + '\n' + order.map(k => emitted.get(k)).join('\n\n') + '\n';
}

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const oIdx = args.indexOf('-o');
  const outFile = oIdx !== -1 ? args.splice(oIdx, 2)[1] : null;
  const [sourceType, targetType, xsdDir] = args;
  if (!sourceType || !targetType) {
    console.error('Usage: node generate.js <SourceType> <TargetType> [xsdDir] [-o out.js]');
    process.exit(2);
  }
  const types = loadTypes(xsdDir || '.');
  const code = generate(sourceType, targetType, types);
  if (outFile) {
    fs.writeFileSync(outFile, code);
    console.log(`Wrote ${outFile}`);
  } else {
    console.log(code);
  }
}

module.exports = { generate };
