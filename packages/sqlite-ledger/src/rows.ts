export interface SqlRow {
  [key: string]: null | number | bigint | string | Uint8Array;
}

export function asText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected text column: ${key}`);
  }
  return value;
}

export function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected numeric column: ${key}`);
  }
  return value;
}

export function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asText(row, key);
}

export function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asNumber(row, key);
}

/** Spreads `{ [key]: value }` only when value is defined, as required by exactOptionalPropertyTypes. */
export function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
