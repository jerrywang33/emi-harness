import { isSha256 } from "./canonical-json.js";
import { LOCAL_WORKSPACE_ISOLATION_REF, WORKSPACE_WRITE_POLICY_REF } from "./definitions.js";
import type {
  JsonObject,
  RoleRunAuthoritySnapshot,
  ToolPolicyEvaluation,
  ToolPolicyPort,
  VersionedRef,
} from "./types.js";

const MAX_UTF8_BYTES = 128 * 1024;

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function invalidPath(path: string): boolean {
  return (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export class WorkspaceWritePolicy implements ToolPolicyPort {
  readonly ref = WORKSPACE_WRITE_POLICY_REF;

  evaluate(authority: RoleRunAuthoritySnapshot, input: JsonObject): ToolPolicyEvaluation {
    const reasons: string[] = [];
    if (authority.role !== "executor") {
      reasons.push("executor_role_required");
    }
    if (!sameRef(authority.isolationProfile, LOCAL_WORKSPACE_ISOLATION_REF)) {
      reasons.push("isolation_profile_mismatch");
    }
    const keys = Object.keys(input).sort();
    if (keys.join("\u0000") !== ["content", "expectedDigest", "path"].join("\u0000")) {
      reasons.push("input_shape_invalid");
    }
    const path = input.path;
    const content = input.content;
    const expectedDigest = input.expectedDigest;
    if (typeof path !== "string" || invalidPath(path)) {
      reasons.push("path_invalid");
    } else if (!authority.allowedPaths.includes(path)) {
      reasons.push("path_not_allowed");
    }
    if (typeof content !== "string" || content.includes("\0")) {
      reasons.push("content_invalid");
    } else if (Buffer.byteLength(content, "utf8") > MAX_UTF8_BYTES) {
      reasons.push("content_too_large");
    }
    if (typeof expectedDigest !== "string" || (expectedDigest !== "absent" && !isSha256(expectedDigest))) {
      reasons.push("expected_digest_invalid");
    }
    if (reasons.length > 0 || typeof path !== "string" || typeof content !== "string" || typeof expectedDigest !== "string") {
      return { outcome: "deny", reasonCodes: reasons.length === 0 ? ["input_invalid"] : reasons };
    }
    return {
      outcome: "allow",
      reasonCodes: ["manifest_tool_and_path_allowed"],
      normalizedInput: { path, content, expectedDigest },
      allowedPath: path,
    };
  }
}
