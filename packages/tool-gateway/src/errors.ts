export type ToolGatewayErrorCode =
  | "authorization_denied"
  | "definition_mismatch"
  | "idempotency_conflict"
  | "invalid_input"
  | "invalid_transition"
  | "not_found"
  | "policy_denied";

export class ToolGatewayError extends Error {
  constructor(
    readonly code: ToolGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolGatewayError";
  }
}

export function fail(code: ToolGatewayErrorCode, message: string): never {
  throw new ToolGatewayError(code, message);
}
