import assert from "node:assert/strict";
import test from "node:test";
import { formatSchema } from "../../harness/productivity/tool-inspector/pi/schema.ts";
import { colorizeReport } from "../../harness/productivity/tool-inspector/pi/report.ts";

test("colors report structure and inline code using theme tokens without changing stored text", () => {
  const theme = {
    fg: (token, value) => `<${token}>${value}</${token}>`,
    bold: (value) => `<bold>${value}</bold>`,
  };
  const plain = "read\nExposure: direct\nSource: builtin\n\nRead using `path`.\n\nParameters:\nFields: object\n  path: string (required)\n  offset: integer (optional)\n\nOutput:\nNo output schema exposed";
  const colored = colorizeReport(plain, theme);
  assert(colored.includes("<bold><mdHeading>read</mdHeading></bold>"));
  assert(colored.includes("<mdHeading>Parameters:</mdHeading>"));
  assert(colored.includes("<accent>path</accent>: <mdCode>string</mdCode><success> (required)</success>"));
  assert(colored.includes("<dim> (optional)</dim>"));
  assert(colored.includes("Read using <mdCode>path</mdCode>."));
  assert(!plain.includes("<mdCode>"));
});

// Native Node 24 TypeScript stripping; no Pi installation needed for converter tests.
test("formats field presence, descriptions, falsy defaults and constraints", () => {
  const text = formatSchema({ type: "object", required: ["path"], additionalProperties: false, properties: {
    path: { type: "string", description: "File to read.", minLength: 1 },
    offset: { type: "integer", default: 0, minimum: 0, maximum: 100 },
    enabled: { type: "boolean", default: false },
  } });
  for (const expected of ["path: string (required)", "File to read.", "Minimum length: 1",
    "offset: integer (optional)", "Default: 0", "Minimum: 0", "Maximum: 100", "Default: false",
    "Additional fields are not allowed."]) assert(text.includes(expected), expected);
  assert(!text.includes('"properties"'));
});

test("formats nested arrays, objects, enums and union alternatives", () => {
  const text = formatSchema({ type: "object", properties: {
    results: { type: "array", minItems: 1, uniqueItems: true, items: {
      type: "object", required: ["kind"], properties: {
        kind: { enum: ["page", "pdf"] },
        value: { oneOf: [{ type: "string", description: "Text" }, { type: "null" }] },
      },
    } },
  } });
  for (const expected of ["results: list of object (optional)", "Each item: object",
    "kind: “page” | “pdf” (required)", "Must match exactly one of:", "Option 1: string",
    "Option 2: null", "Minimum items: 1", "Items must be unique"]) assert(text.includes(expected), expected);
});

test("handles references, definitions, tuples, boolean schemas and composition", () => {
  const text = formatSchema({ allOf: [
    { $ref: "#/$defs/Item" },
    { type: "array", prefixItems: [{ const: "start" }, false], items: true },
  ], $defs: { Item: { type: ["string", "null"] } } });
  for (const expected of ["reference #/$defs/Item", "Must match all of:", "Item 1: “start”",
    "Item 2: no value allowed", "Each item: any value", "Definition Item: string | null"]) assert(text.includes(expected), expected);
  assert.equal(formatSchema(false), "Fields: no value allowed");
  assert.equal(formatSchema(true), "Fields: any value");
});

test("renders record values, patterns and conditional constraints", () => {
  const text = formatSchema({ type: "object", additionalProperties: { type: "integer" },
    patternProperties: { "^x-": { type: "string", pattern: "^[a-z]+$" } },
    if: { properties: { version: { const: 2 } } }, then: { not: { type: "null" } },
  });
  for (const expected of ["Additional fields: integer", "Fields matching ^x-: string", "Pattern: “^[a-z]+$”",
    "When matching", "Then require", "Must not match: null"]) assert(text.includes(expected), expected);
});

test("limits recursive schemas without crashing", () => {
  const schema = { type: "array" };
  schema.items = schema;
  assert(formatSchema(schema).includes("Further nesting omitted."));
});
