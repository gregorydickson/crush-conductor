/**
 * Minimal JSON Schema subset validator for worker output schemas.
 * Supports: type (string or array), properties, required, items, enum.
 * Deliberately small: worker briefs should stay in this subset.
 */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateSchema(value, schema, at = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const integerOk = expected.includes("integer") && actual === "number" && Number.isInteger(value);
    if (!expected.includes(actual) && !integerOk) errors.push(`${at}: expected type ${expected.join("|")}, got ${actual}`);
  }
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${at}: value not in enum [${schema.enum.map(o => JSON.stringify(o)).join(", ")}]`);
  }
  if (typeOf(value) === "object" && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...validateSchema(value[key], child, `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${at}[${index}]`)));
  }
  return errors;
}

export function makeValidator(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Output schema must be a JSON object.");
  }
  let errors = null;
  return {
    get errors() { return errors; },
    validate(value) {
      errors = validateSchema(value, schema);
      return errors.length === 0;
    },
  };
}
