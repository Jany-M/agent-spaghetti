// Tiny JSON-Schema subset validator (type, required, properties, additionalProperties:false, items, enum, const,
// pattern, minItems, anyOf). Enough for manifest.schema.json; no dependency.
type S = Record<string, any>;
const typeOk = (t: string, v: unknown) =>
  t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : typeof v === t;

export function validate(schema: S, value: unknown, path = ''): string[] {
  const at = path || '/';
  if (schema.anyOf) {
    const results = (schema.anyOf as S[]).map(s => validate(s, value, path));
    return results.some(r => r.length === 0) ? [] : [`${at}: does not match any allowed shape`];
  }
  if (schema.const !== undefined && value !== schema.const) return [`${at}: must be ${JSON.stringify(schema.const)}`];
  if (schema.type && !typeOk(schema.type, value)) return [`${at}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: must be one of ${schema.enum.join(', ')}`];
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) return [`${at}: must match ${schema.pattern}`];
  const errors: string[] = [];
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}/${i}`)));
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) errors.push(`${path}/${r}: required`);
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validate(sub, v, `${path}/${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}/${k}: unknown field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, `${path}/${k}`));
    }
  }
  return errors;
}
