# BAW Script Validator

Verifies IBM BAW server-side JavaScript transform functions (Rhino engine) against business object definitions downloaded from the BAW REST API. Two layers:

1. **Static analysis** (`validate.js`) — parses the script for Rhino compatibility (`var`/`let`/`const` allowed; arrow functions, template literals, classes, destructuring, and spread are flagged) and checks every `new tw.object.X()` and every property read/write against the type definitions. No execution needed; reports all errors at once with line numbers and fix hints.
2. **Runtime unit tests** (`run-tests.js`) — loads the script into a sandbox with a strict mock `tw.object` (built from the type definitions, mimicking BAW's typed business objects: unknown properties/types throw, primitive types are checked). Runs test cases from a JSON spec.

## Downloading type definitions

`download-types.js` pulls every business object definition for a process app:

```bash
node download-types.js <baseUrl> <processAppId> [outDir] [--user user:pass] [--only A,B] [--insecure]
node download-types.js <baseurl> 2066.54cef352-33fe-4e50-be89-162731bcf981 types --user admin:pass --insecure
```

It lists types from `/rest/bpm/wle/v1/assets?processAppId=...` (name + poId), then fetches each from `/rest/bpm/wle/v1/businessobject/{poId}?processAppId=...` into `<outDir>/<name>.json`. Credentials can also come from `BAW_USER`/`BAW_PASSWORD` env vars. Use `--insecure` for self-signed certificates.

Duplicate type definitions across files are merged when structurally identical; a duplicate with a different structure (a stale copy) raises an error with a property-level diff.

## Validating and testing

```bash
npm install                                     # once
node validate.js <script.js> [typesDir]        # static check
node run-tests.js <script.js> <tests.json> [typesDir]
```

When `typesDir` is omitted, tools try the script's own folder, then `./types`. For the sample: `npm run validate` and `npm test`.

Property `typeClass` values map as: String, Integer, Decimal, Boolean, Date, Time are primitives; anything else is treated as a nested business object. `isArray: true` becomes a BAW list.

## How variable types are resolved

- Function parameter types come from JSDoc: `@param {AddressWS} addressWs`.
- Local variable types come from `var x = new tw.object.TypeName()` (also `let`/`const`).
- `@returns {Type}` is checked against the type of the returned variable.
- Scoping is per function, so multi-function scripts (helpers + main transform) are checked independently.

## Code generation

`generate.js` writes the transform for you from the type definitions, including nested business objects and BAW lists:

```bash
node generate.js <SourceType> <TargetType> [typesDir] [-o out.js]
node generate.js CustomerWS Customer examples -o examples/convertCustomerWsToCustomer.js
```

Nested complex types get their own helper converters (generated recursively and reused); `isArray` properties become `tw.object.listOf.X` with an `insertIntoList` loop; unmatched properties are flagged with `// TODO` / `// NOTE` comments. Generated code is ES5/Rhino-safe and passes `validate.js`. See `examples/` for a nested Customer/CustomerWS demo with tests.

## Generating test specs

`generate-test.js` scaffolds a test spec — sample input values for every property (nested objects and lists included), expected values derived by name-matched mapping, plus an empty-input case:

```bash
node generate-test.js <functionName> <InputType> <OutputType> [typesDir] [-o out.json]
node generate-test.js convertAddressWsToAddress AddressWS Address   # -> test/convertAddressWsToAddress.test.json
```

Defaults: types from `./types`, output to `./test/<functionName>.test.json`. Review the expected values if your transform has custom logic beyond property name matching.

## Test spec format

```json
{
  "function": "convertAddressWsToAddress",
  "cases": [
    {
      "name": "full address",
      "input":  { "type": "AddressWS", "value": { "line1": "...", "line3": "..." } },
      "expect": { "type": "Address",   "value": { "line1": "..." } }
    }
  ]
}
```

Unset properties are `null` (BAW behavior). Nested objects and lists are deep-compared. Runtime errors report the failing script line via the stack trace.

## Example output

```
ERROR sample.js:6:18  new tw.object.Address1(): type "Address1" does not exist in the type definitions
      hint: Did you mean "Address"? Available types: Address, AddressWS
ERROR sample.js:9:12  result.line3: property "line3" does not exist on type "Address" (invalid assignment target)
      hint: Did you mean "result.line1"? "Address" has: line1, line2, postcode, type
```
