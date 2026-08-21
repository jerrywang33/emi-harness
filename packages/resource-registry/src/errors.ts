export type ResourceRegistryErrorCode =
  | "digest_mismatch"
  | "duplicate_reference"
  | "inactive_resource"
  | "invalid_manifest"
  | "invalid_path"
  | "not_found"
  | "role_not_allowed";

export class ResourceRegistryError extends Error {
  constructor(
    readonly code: ResourceRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResourceRegistryError";
  }
}

export function fail(code: ResourceRegistryErrorCode, message: string): never {
  throw new ResourceRegistryError(code, message);
}
