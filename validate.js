#!/usr/bin/env node
/**
 * Static validator for IBM BAW server-side JavaScript (Rhino engine).
 *
 * Checks a transform script against business object definitions in .xsd files:
 *   1. Syntax must be Rhino/ES5-compatible.
 *   2. new tw.object.X() — X must be a type defined in an XSD.
 *   3. obj.prop reads/writes — prop must exist on the variable's resolved type.
 *      Variable types come from JSDoc @param/@returns tags and from
 *      `var x = new tw.object.X()` assignments.
 *
 * Usage: node validate.js <script.js> [xsdDir]   (xsdDir defaults to script's dir)
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { loadTypes, suggest } = require('./lib/xsd');

function validate(scriptPath, xsdDir) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const types = loadTypes(xsdDir);
  const errors = [];
  const file = path.basename(scriptPath);

  const err = (loc, msg, hint) =>
    errors.push({ file, line: loc.line, col: loc.column + 1, msg, hint });

  // --- 1. Parse as ES5 (Rhino in BAW is ES5-level) ---
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 5, locations: true });
  } catch (e) {
    err(e.loc, `Syntax error (not Rhino/ES5 compatible): ${e.message.replace(/\s*\(\d+:\d+\)$/, '')}`);
    return { errors, types };
  }

  // --- JSDoc: map param/return names to declared types ---
  const jsdocTypes = {}; // paramName -> TypeName
  let jsdocReturn = null;
  const docRe = /@param\s*\{(\w+)(\[\])?\}\s*(\w+)/g;
  let m;
  while ((m = docRe.exec(src)) !== null) jsdocTypes[m[3]] = m[1];
  const retM = /@returns?\s*\{(\w+)(\[\])?\}/.exec(src);
  if (retM) jsdocReturn = retM[1];

  // varName -> TypeName (single function scope is typical for BAW transforms)
  const varTypes = Object.assign({}, jsdocTypes);

  // Validate JSDoc-declared types themselves
  for (const [name, t] of Object.entries(jsdocTypes)) {
    if (!types[t]) {
      const s = suggest(t, Object.keys(types));
      errors.push({ file, line: 1, col: 1,
        msg: `@param {${t}} ${name}: type "${t}" is not defined in any XSD`,
        hint: s ? `Did you mean "${s}"?` : null });
    }
  }
  if (jsdocReturn && !types[jsdocReturn]) {
    const s = suggest(jsdocReturn, Object.keys(types));
    errors.push({ file, line: 1, col: 1,
      msg: `@returns {${jsdocReturn}}: type "${jsdocReturn}" is not defined in any XSD`,
      hint: s ? `Did you mean "${s}"?` : null });
  }

  const isTwObjectNew = (node) =>
    node.type === 'NewExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'MemberExpression' &&
    node.callee.object.object.type === 'Identifier' &&
    node.callee.object.object.name === 'tw' &&
    node.callee.object.property.name === 'object' &&
    node.callee.property.type === 'Identifier';

  // --- Pass 1: collect variable types from `var x = new tw.object.T()` ---
  // If T is unknown, fall back to the closest real type so property checks still run.
  const resolveType = (t) => types[t] ? t : (suggest(t, Object.keys(types)) || t);
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.init && isTwObjectNew(node.init))
        varTypes[node.id.name] = resolveType(node.init.callee.property.name);
    },
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier' && isTwObjectNew(node.right))
        varTypes[node.left.name] = resolveType(node.right.callee.property.name);
    },
  });

  // --- Pass 2: validate constructors and property access ---
  const listMethods = ['insertIntoList', 'removeIndex', 'listLength', 'length', 'toXML'];
  const commonMethods = ['toString', 'toXMLString', 'valueOf', 'hasOwnProperty', 'listLength'];

  walk.ancestor(ast, {
    NewExpression(node) {
      if (!isTwObjectNew(node)) return;
      const t = node.callee.property.name;
      // strip listOf prefix used for lists: new tw.object.listOf.Address()
      if (!types[t] && t !== 'listOf') {
        const s = suggest(t, Object.keys(types));
        err(node.loc.start,
          `new tw.object.${t}(): type "${t}" does not exist in the XSD definitions`,
          s ? `Did you mean "${s}"? Available types: ${Object.keys(types).join(', ')}` :
              `Available types: ${Object.keys(types).join(', ')}`);
      }
    },
    MemberExpression(node, _state, ancestors) {
      if (node.computed) return;                       // obj[expr] — skip
      if (node.object.type !== 'Identifier') return;   // only direct var.prop
      const varName = node.object.name;
      if (varName === 'tw') return;                    // tw.local / tw.object etc.
      const typeName = varTypes[varName];
      if (!typeName || !types[typeName]) return;       // untyped var — skip
      const prop = node.property.name;
      if (types[typeName].properties[prop]) return;    // valid
      if (commonMethods.includes(prop) || listMethods.includes(prop)) return;

      const parent = ancestors[ancestors.length - 2];
      const isWrite = parent && parent.type === 'AssignmentExpression' && parent.left === node;
      const s = suggest(prop, Object.keys(types[typeName].properties));
      err(node.property.loc.start,
        `${varName}.${prop}: property "${prop}" does not exist on type "${typeName}"` +
        (isWrite ? ' (invalid assignment target)' : ''),
        s ? `Did you mean "${varName}.${s}"? "${typeName}" has: ${Object.keys(types[typeName].properties).join(', ')}` :
            `"${typeName}" has: ${Object.keys(types[typeName].properties).join(', ')}`);
    },
    ReturnStatement(node) {
      // return variable whose type mismatches @returns
      if (!jsdocReturn || !node.argument || node.argument.type !== 'Identifier') return;
      const t = varTypes[node.argument.name];
      if (t && types[jsdocReturn] && t !== jsdocReturn && types[t]) {
        err(node.loc.start,
          `Function returns "${t}" but JSDoc declares @returns {${jsdocReturn}}`);
      }
    },
  });

  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { errors, types };
}

// ---- CLI ----
if (require.main === module) {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error('Usage: node validate.js <script.js> [xsdDir]');
    process.exit(2);
  }
  const xsdDir = process.argv[3] || path.dirname(path.resolve(scriptPath));
  const { errors, types } = validate(scriptPath, xsdDir);

  console.log(`Loaded types: ${Object.keys(types).map(t => `${t} (${Object.keys(types[t].properties).join(', ')})`).join(' | ')}\n`);
  if (errors.length === 0) {
    console.log(`PASS  ${path.basename(scriptPath)}: no static errors found.`);
  } else {
    for (const e of errors) {
      console.log(`ERROR ${e.file}:${e.line}:${e.col}  ${e.msg}`);
      if (e.hint) console.log(`      hint: ${e.hint}`);
    }
    console.log(`\n${errors.length} error(s) found.`);
    process.exit(1);
  }
}

module.exports = { validate };
