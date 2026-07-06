# BAW Script Validator

Verifies IBM BAW server-side JavaScript transform functions (Rhino engine) against the business object definitions in your `.xsd` files. Two layers:

## Downloading XSDs from a BAW server

`download-xsds.js` pulls every business object XSD for a branch:

```bash
node download-xsds.js <baseUrl> <branchId> [outDir] [--user user:pass] [--only A,B] [--insecure]
node download-xsds.js https://baw.example.com:9443 2063.fe0f0969-81df-4d09-b816-afd39dcfe8e8 ./xsds --user admin:pass --insecure
```

It lists type names from `/rest/bpm/wle/v1/assets?branchId=...`, then fetches each from `/WebPD/jsp/ViewSchema.jsp?type=<name>&version=<branchId>` into `<outDir>/<name>.xsd`. Credentials can also come from `BAW_USER`/`BAW_PASSWORD` env vars. Responses that aren't XSDs (e.g. a login page) are skipped with a warning. Use `--insecure` for self-signed certificates.

## Code generation

`generate.js` writes the transform for you from the XSDs, including nested business objects and BAW lists:

```bash
node generate.js <SourceType> <TargetType> [xsdDir] [-o out.js]
node generate.js CustomerWS Customer examples -o examples/convertCustomerWsToCustomer.js
```

Nested complex types get their own helper converters (generated recursively and reused); `maxOccurs="unbounded"` properties become `tw.object.listOf.X` with an `insertIntoList` loop; unmatched properties are flagged with `// TODO` / `// NOTE` comments. Generated code is ES5/Rhino-safe and passes `validate.js`. See `examples/` for a nested Customer/CustomerWS demo with tests.

1. **Static analysis** (`validate.js`) — parses the script for Rhino compatibility (`var`/`let`/`const` allowed; arrow functions, template literals, classes, destructuring, and spread are flagged) and checks every `new tw.object.X()` and every property read/write against the XSD types. No execution needed; reports all errors at once with line numbers and fix hints.
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
