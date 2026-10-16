type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);

function literal(value: unknown): string {
  if (typeof value === "string") return `“${value}”`;
  if (Array.isArray(value)) return value.length ? value.map(literal).join(", ") : "empty list";
  if (object(value)) return Object.entries(value).map(([key, item]) => `${key}: ${literal(item)}`).join("; ") || "empty object";
  return String(value);
}

function variants(schema: Schema): { label: string; values: unknown[] } | undefined {
  for (const [key, label] of [["oneOf", "exactly one of"], ["anyOf", "one or more of"], ["allOf", "all of"]]) {
    if (Array.isArray(schema[key])) return { label, values: schema[key] as unknown[] };
  }
}

function typeName(value: unknown, depth = 0): string {
  if (depth >= 16) return "nested value";
  if (value === true) return "any value";
  if (value === false) return "no value allowed";
  if (!object(value)) return "unspecified type";
  if (typeof value.$ref === "string") return `reference ${value.$ref}`;
  if ("const" in value) return literal(value.const);
  if (Array.isArray(value.enum)) return value.enum.map(literal).join(" | ") || "no allowed values";
  const choices = variants(value);
  if (choices) return choices.values.map((choice) => typeName(choice, depth + 1)).join(choices.label === "all of" ? " & " : " | ");
  if (Array.isArray(value.type)) return value.type.join(" | ");
  if (value.type === "array" || "items" in value || "prefixItems" in value) {
    return Array.isArray(value.prefixItems) ? "tuple" : `list of ${typeName(value.items ?? true, depth + 1)}`;
  }
  if (typeof value.type === "string") return value.type;
  if (object(value.properties) || "additionalProperties" in value) return "object";
  return "any value";
}

function notes(schema: Schema): string[] {
  const result: string[] = [];
  if (typeof schema.description === "string") result.push(schema.description.replace(/\s+/g, " ").trim());
  if ("default" in schema) result.push(`Default: ${literal(schema.default)}`);
  for (const [key, label] of [
    ["minimum", "Minimum"], ["maximum", "Maximum"], ["exclusiveMinimum", "Greater than"],
    ["exclusiveMaximum", "Less than"], ["multipleOf", "Multiple of"], ["minLength", "Minimum length"],
    ["maxLength", "Maximum length"], ["pattern", "Pattern"], ["format", "Format"],
    ["minItems", "Minimum items"], ["maxItems", "Maximum items"],
    ["minProperties", "Minimum properties"], ["maxProperties", "Maximum properties"],
  ]) {
    if (key in schema) result.push(`${label}: ${literal(schema[key])}`);
  }
  if (schema.uniqueItems === true) result.push("Items must be unique");
  if (schema.readOnly === true) result.push("Read-only");
  if (schema.deprecated === true) result.push("Deprecated");
  if (Array.isArray(schema.examples)) result.push(`Examples: ${schema.examples.map(literal).join("; ")}`);
  return result;
}

/** Display JSON Schema as indented field documentation, without executing or resolving references. */
export function formatSchema(value: unknown): string {
  const lines: string[] = [];
  const ancestry = new Set<object>();
  function visit(schema: unknown, label: string, depth: number, presence?: string) {
    const indent = "  ".repeat(depth);
    const header = `${indent}${label}: ${typeName(schema)}${presence ? ` (${presence})` : ""}`;
    lines.push(header);
    if (!object(schema)) return;
    if (ancestry.has(schema) || depth >= 16) {
      lines.push(`${indent}  Further nesting omitted.`);
      return;
    }
    ancestry.add(schema);
    for (const note of notes(schema)) lines.push(`${indent}  ${note}`);
    const choices = variants(schema);
    if (choices) {
      lines.push(`${indent}  Must match ${choices.label}:`);
      choices.values.forEach((choice, index) => visit(choice, `Option ${index + 1}`, depth + 1));
    }
    if (object(schema.properties)) {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      for (const [name, field] of Object.entries(schema.properties)) {
        visit(field, name, depth + 1, required.has(name) ? "required" : "optional");
      }
    }
    if (schema.type === "object" && object(schema.properties) && !Object.keys(schema.properties).length) {
      lines.push(`${indent}  No named fields.`);
    }
    if (schema.additionalProperties === false) lines.push(`${indent}  Additional fields are not allowed.`);
    else if (object(schema.additionalProperties) || schema.additionalProperties === true) {
      visit(schema.additionalProperties, "Additional fields", depth + 1);
    }
    if (object(schema.patternProperties)) {
      for (const [pattern, field] of Object.entries(schema.patternProperties)) visit(field, `Fields matching ${pattern}`, depth + 1);
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((item, index) => visit(item, `Item ${index + 1}`, depth + 1));
    }
    if ("items" in schema) {
      if (Array.isArray(schema.items)) schema.items.forEach((item, index) => visit(item, `Item ${index + 1}`, depth + 1));
      else visit(schema.items, "Each item", depth + 1);
    }
    for (const [key, label] of [["not", "Must not match"], ["contains", "Must contain an item matching"],
      ["if", "When matching"], ["then", "Then require"], ["else", "Otherwise require"]]) {
      if (key in schema) visit(schema[key], label, depth + 1);
    }
    if (object(schema.$defs) || object(schema.definitions)) {
      for (const [name, definition] of Object.entries((schema.$defs ?? schema.definitions) as Schema)) {
        visit(definition, `Definition ${name}`, depth + 1);
      }
    }
    ancestry.delete(schema);
  }
  visit(value, "Fields", 0);
  return lines.join("\n");
}
