/**
 * Strict mock of BAW's `tw.object` namespace for unit testing transform scripts.
 *
 * Mimics Rhino/BAW behavior where business objects are typed: accessing or
 * assigning a property not defined in the XSD throws, and constructing an
 * undefined type throws. Errors carry the script line via the stack trace.
 */
function buildTw(types) {
  function makeInstance(typeName) {
    const def = types[typeName];
    const data = {};
    for (const p of Object.keys(def.properties)) data[p] = null; // BAW inits to null
    return new Proxy(data, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        if (prop === 'toJSON' || prop === 'inspect') return undefined;
        if (prop === '__type__') return typeName;
        if (prop === 'toString') return () => `[${typeName}]`;
        if (!(prop in target))
          throw new TypeError(`Property "${prop}" is not defined on type "${typeName}" (per ${def.source})`);
        return target[prop];
      },
      set(target, prop, value) {
        if (!(prop in target))
          throw new TypeError(`Cannot assign "${String(prop)}": property is not defined on type "${typeName}" (per ${def.source})`);
        const expected = def.properties[prop].jsType;
        if (value !== null && value !== undefined && expected !== 'any' && expected !== 'object'
            && typeof value !== expected)
          throw new TypeError(`Type mismatch on ${typeName}.${String(prop)}: expected ${def.properties[prop].xsType} (${expected}), got ${typeof value}`);
        target[prop] = value;
        return true;
      },
      has(target, prop) { return prop in target; },
      ownKeys(target) { return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  }

  const twObject = new Proxy({}, {
    get(_t, typeName) {
      if (typeof typeName === 'symbol') return undefined;
      if (typeName === 'listOf') {
        return new Proxy({}, {
          get(_t2, inner) {
            if (!types[inner]) throw new TypeError(`tw.object.listOf.${String(inner)} is not defined: no type "${String(inner)}" in the XSDs`);
            return function ListCtor() { const arr = []; arr.__type__ = `listOf ${inner}`; return arr; };
          },
        });
      }
      if (!types[typeName])
        throw new TypeError(`tw.object.${String(typeName)} is not defined: no type "${String(typeName)}" in the XSDs. Available: ${Object.keys(types).join(', ')}`);
      return function Ctor() { return makeInstance(typeName); };
    },
  });

  return { object: twObject, local: {}, system: {}, env: {}, epv: {} };
}

/** Build a typed instance pre-filled with plain-object values (for test inputs). */
function makeTyped(tw, typeName, values) {
  const inst = new tw.object[typeName]();
  for (const [k, v] of Object.entries(values || {})) inst[k] = v;
  return inst;
}

module.exports = { buildTw, makeTyped };
