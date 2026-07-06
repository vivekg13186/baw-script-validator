#!/usr/bin/env node
/**
 * Static validator for IBM BAW server-side JavaScript (Rhino engine).
 *
 * Checks a transform script against business object definitions (JSON, from download-types.js):
 *   1. Syntax must be Rhino/ES5-compatible.
 *   2. new tw.object.X() — X must be a defined business object type.
 *   3. obj.prop reads/writes — prop must exist on the variable's resolved type.
 *      Variable types come from JSDoc @param/@returns tags and from
 *      `var x = new tw.object.X()` assignments.
 *
 * Usage: node validate.js <script.js> [typesDir]  (defaults to script's dir, then ./types)
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { loadTypes, suggest, defaultTypesDir } = require('./lib/types');

function validate(scriptPath, typesDir) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const types = loadTypes(typesDir);
  const errors = [];
  const file = path.basename(scriptPath);

  const err = (loc, msg, hint) =>
    errors.push({ file, line: loc.line, col: loc.column + 1, msg, hint });

  // --- 1. Parse as ES6 (BAW's Rhino supports var/let/const), then flag
  //        constructs Rhino in BAW does NOT reliably support ---
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 6, locations: true,
      onComment: (block, text, start, end, startLoc) => {
        if (block) comments.push({ text, end, line: startLoc.line });
      },
    });
  } catch (e) {
    err(e.loc, `Syntax error (not Rhino compatible): ${e.message.replace(/\s*\(\d+:\d+\)$/, '')}`);
    return { errors, types };
  }

  const UNSUPPORTED = {
    ArrowFunctionExpression: 'arrow functions (=>)',
    TemplateLiteral: 'template literals (`...`)',
    ClassDeclaration: 'classes',
    ClassExpression: 'classes',
    ObjectPattern: 'destructuring',
    ArrayPattern: 'destructuring',
    SpreadElement: 'spread syntax (...)',
    RestElement: 'rest parameters (...)',
  };
  walk.full(ast, (node) => {
    if (UNSUPPORTED[node.type])
      err(node.loc.start, `${UNSUPPORTED[node.type]} are not supported by BAW's Rhino engine — use ES5 syntax`);
  });

  // --- Per-function scopes: JSDoc @param/@returns from the doc block just above each function ---
  const scopes = new Map(); // funcNode -> { varTypes: {}, jsdocReturn: string|null }
  const globalScope = { varTypes: {}, jsdocReturn: null };

  const parseJsdoc = (text, line) => {
    const params = {};
    const docRe = /@param\s*\{(\w+)(\[\])?\}\s*(\w+)/g;
    let m;
    while ((m = docRe.exec(text)) !== null) {
      params[m[3]] = m[1];
      if (!types[m[1]]) {
        const s = suggest(m[1], Object.keys(types));
        errors.push({ file, line, col: 1,
          msg: `@param {${m[1]}} ${m[3]}: type "${m[1]}" is not defined in the type definitions`,
          hint: s ? `Did you mean "${s}"?` : null });
      }
    }
    const retM = /@returns?\s*\{(\w+)(\[\])?\}/.exec(text);
    if (retM && !types[retM[1]]) {
      const s = suggest(retM[1], Object.keys(types));
      errors.push({ file, line, col: 1,
        msg: `@returns {${retM[1]}}: type "${retM[1]}" is not defined in the type definitions`,
        hint: s ? `Did you mean "${s}"?` : null });
    }
    return { params, ret: retM ? retM[1] : null };
  };

  walk.simple(ast, {
    FunctionDeclaration(node) { scopes.set(node, null); },
    FunctionExpression(node) { scopes.set(node, null); },
  });
  for (const funcNode of scopes.keys()) {
    // nearest block comment ending before the function starts
    const doc = comments.filter(c => c.end <= funcNode.start).sort((a, b) => b.end - a.end)[0];
    const parsed = doc ? parseJsdoc(doc.text, doc.line) : { params: {}, ret: null };
    scopes.set(funcNode, { varTypes: Object.assign({}, parsed.params), jsdocReturn: parsed.ret });
  }

  const scopeOf = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (scopes.has(ancestors[i])) return scopes.get(ancestors[i]);
    }
    return globalScope;
  };

  const isTwObjectNew = (node) =>
    node.type === 'NewExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'MemberExpression' &&
    node.callee.object.object.type === 'Identifier' &&
    node.callee.object.object.name === 'tw' &&
    node.callee.object.property.name === 'object' &&
    node.callee.property.type === 'Identifier';

  // --- Pass 1: collect variable types from `var x = new tw.object.T()` (per scope) ---
  // If T is unknown, fall back to the closest real type so property checks still run.
  const resolveType = (t) => types[t] ? t : (suggest(t, Object.keys(types)) || t);
  walk.ancestor(ast, {
    VariableDeclarator(node, _s, ancestors) {
      if (node.init && isTwObjectNew(node.init))
        scopeOf(ancestors).varTypes[node.id.name] = resolveType(node.init.callee.property.name);
    },
    AssignmentExpression(node, _s, ancestors) {
      if (node.left.type === 'Identifier' && isTwObjectNew(node.right))
        scopeOf(ancestors).varTypes[node.left.name] = resolveType(node.right.callee.property.name);
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
          `new tw.object.${t}(): type "${t}" does not exist in the type definitions`,
          s ? `Did you mean "${s}"? Available types: ${Object.keys(types).join(', ')}` :
              `Available types: ${Object.keys(types).join(', ')}`);
      }
    },
    MemberExpression(node, _state, ancestors) {
      if (node.computed) return;                       // obj[expr] — skip
      if (node.object.type !== 'Identifier') return;   // only direct var.prop
      const varName = node.object.name;
      if (varName === 'tw') return;                    // tw.local / tw.object etc.
      const typeName = scopeOf(ancestors).varTypes[varName];
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
    ReturnStatement(node, _state, ancestors) {
      // return variable whose type mismatches this function's @returns
      const scope = scopeOf(ancestors);
      if (!scope.jsdocReturn || !node.argument || node.argument.type !== 'Identifier') return;
      const t = scope.varTypes[node.argument.name];
      if (t && types[scope.jsdocReturn] && t !== scope.jsdocReturn && types[t]) {
        err(node.loc.start,
          `Function returns "${t}" but JSDoc declares @returns {${scope.jsdocReturn}}`);
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
    console.error('Usage: node validate.js <script.js> [typesDir]');
    process.exit(2);
  }
  const typesDir = process.argv[3] || defaultTypesDir(scriptPath);
  let result;
  try {
    result = validate(scriptPath, typesDir);
  } catch (e) {
    console.error(`TYPE ERROR: ${e.message}`);
    process.exit(1);
  }
  const { errors, types } = result;

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
