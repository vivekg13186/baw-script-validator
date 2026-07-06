# BAW Script Validator

Verifies IBM BAW server-side JavaScript transform functions (Rhino engine) against the business object definitions in your `.xsd` files. Two layers:

## Code generation

`generate.js` writes the transform for you from the XSDs, including nested business objects and BAW lists:

```bash
node generate.js <SourceType> <TargetType> [xsdDir] [-o out.js]
node generate.js CustomerWS Customer examples -o examples/convertCustomerWsToCustomer.js
```

Nested complex types get their own helper converters (generated recursively and reused); `maxOccurs="unbounded"` properties become `tw.object.listOf.X` with an `insertIntoList` loop; unmatched properties are flagged with `// TODO` / `// NOTE` comments. Generated code is ES5/Rhino-safe and passes `validate.js`. See `examples/` for a nested Customer/CustomerWS demo with tests.

1. **Static analysis** (`validate.js`) — parses the script as ES5 (Rhino-compatible) and checks every `new tw.object.X()` and every property read/write against the XSD types. No execution needed; reports all errors at once with line numbers and fix hints.
2. **Runtime unit tests** (`run-tests.js`) — loads the script into a sandbox with a strict mock `tw.object` (built from the XSDs, mimicking BAW's typed business objects: unknown properties/types throw, `xs:` primitive types are checked). Runs test cases from a JSON spec.

## Usage

```bash
npm install                                  # once
node validate.js <script.js> [xsdDir]        # static check (xsdDir defaults to script's folder)
node run-tests.js <script.js> <tests.json> [xsdDir]
```

Or for the sample: `npm run validate` and `npm test`.

## How types are resolved

- All `.xsd` files in the XSD dir are loaded; each `xs:complexType` becomes a known type.
- Function parameter types come from JSDoc: `@param {AddressWS} addressWs`.
- Local variable types come from `var x = new tw.object.TypeName()`.
- `@returns {Type}` is checked against the type of the returned variable.

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

Unset properties are `null` (BAW behavior). Runtime errors report the failing script line via the stack trace.

## Example output (sample.js)

```
ERROR sample.js:6:18  new tw.object.Address1(): type "Address1" does not exist in the XSD definitions
      hint: Did you mean "Address"? Available types: Address, AddressWS
ERROR sample.js:9:12  result.line3: property "line3" does not exist on type "Address" (invalid assignment target)
      hint: Did you mean "result.line1"? "Address" has: line1, line2, postcode, type
```
