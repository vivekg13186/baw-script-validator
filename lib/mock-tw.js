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

  /** BAW-style list: an array with listLength and insertIntoList, like TWList. */
  function makeList(elementType) {
    const arr = [];
    Object.defineProperty(arr, '__type__', { value: `listOf ${elementType}` });
    Object.defineProperty(arr, 'listLength', { get() { return arr.length; } });
    Object.defineProperty(arr, 'insertIntoList', {
      value(index, item) { arr.splice(index, 0, item); },
    });
    return arr;
  }

  const twObject = new Proxy({}, {
    get(_t, typeName) {
      if (typeof typeName === 'symbol') return undefined;
      if (typeName === 'listOf') {
        const LIST_PRIMS = ['String', 'Integer', 'Decimal', 'Boolean', 'Date', 'Time'];
        return new Proxy({}, {
          get(_t2, inner) {
            const name = String(inner);
            if (!types[name] && !LIST_PRIMS.includes(name))
              throw new TypeError(`tw.object.listOf.${name} is not defined: no type "${name}" in the XSDs`);
            return function ListCtor() { return makeList(name); };
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

/**
 * Build a typed instance from plain JSON (for test inputs), recursively:
 * nested objects become typed instances, arrays become BAW lists.
 */
function makeTyped(tw, types, typeName, values) {
  const inst = new tw.object[typeName]();
  const def = types[typeName];
  for (const [k, v] of Object.entries(values || {})) {
    const pDef = def && def.properties[k];
    if (pDef && !pDef.xsType.startsWith('xs:') && v !== null && typeof v === 'object') {
      const nestedType = pDef.xsType.replace(/^\w+:/, '');
      if (Array.isArray(v)) {
        const list = new tw.object.listOf[nestedType]();
        for (const item of v) list.insertIntoList(list.listLength, makeTyped(tw, types, nestedType, item));
        inst[k] = list;
      } else {
        inst[k] = makeTyped(tw, types, nestedType, v);
      }
    } else if (pDef && pDef.isList && Array.isArray(v)) {
      const primList = new tw.object.listOf.String(); // primitive list
      for (const item of v) primList.insertIntoList(primList.listLength, item);
      inst[k] = primList;
    } else {
      inst[k] = v;
    }
  }
  return inst;
}

module.exports = { buildTw, makeTyped };
