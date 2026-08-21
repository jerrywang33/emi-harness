export type AssuranceErrorCode =
  | "check_blocked"
  | "evidence_conflict"
  | "evidence_corrupt"
  | "invalid_check"
  | "invalid_input"
  | "not_found"
  | "verification_rejected";

export class AssuranceError extends Error {
  constructor(
    readonly code: AssuranceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssuranceError";
  }
}

export function fail(code: AssuranceErrorCode, message: string): never {
  throw new AssuranceError(code, message);
}
