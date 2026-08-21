export type ControlPlaneErrorCode =
  | "already_exists"
  | "approval_invalid"
  | "command_conflict"
  | "digest_mismatch"
  | "fencing_rejected"
  | "invalid_input"
  | "invalid_transition"
  | "limit_exceeded"
  | "not_found"
  | "permission_denied"
  | "version_conflict";

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export function fail(code: ControlPlaneErrorCode, message: string): never {
  throw new ControlPlaneError(code, message);
}
