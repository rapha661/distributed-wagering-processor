/**
 * JSON com as chaves de todo objeto ordenadas e sem espaços.
 * Propriedades `undefined` são omitidas; a ordem dos arrays é preservada.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}
