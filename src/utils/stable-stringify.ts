export function sortObjectKeysRecursive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeysRecursive(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortObjectKeysRecursive(source[key]);
    }
    return sorted as unknown as T;
  }
  return value;
}

export function safeStableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortObjectKeysRecursive(value), null, indent);
}
