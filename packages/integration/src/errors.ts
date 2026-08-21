export type IntegrationErrorCode =
  | "invalid_configuration"
  | "invalid_submission"
  | "role_failed"
  | "tool_contract_mismatch";

export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function fail(code: IntegrationErrorCode, message: string): never {
  throw new IntegrationError(code, message);
}
