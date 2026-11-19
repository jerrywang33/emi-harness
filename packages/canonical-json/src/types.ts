export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A content-addressed reference: the digest binds the exact referenced version. */
export interface VersionedRef {
  id: string;
  version: string;
  digest: string;
}
