export interface VersionedRef {
  id: string;
  version: string;
  digest: string;
}

export type ResourceKind = "emi_context" | "prompt" | "skill";
export type ResourceStatus = "active" | "draft" | "retired";
export type ResourceRole = "coordinator" | "executor" | "verifier";

export interface ResourceContentDescriptor {
  path: string;
  mediaType: "text/markdown" | "text/plain";
  digest: string;
}

export interface ResourceGovernance {
  owner: string;
  preparedAt: string;
  nextReviewAt: string;
  changePolicy: "manual_review";
  confirmationStatus: "engineering_baseline" | "human_confirmed" | "source_baseline_task_confirmation_required";
}

export interface RegulatorySource {
  sourceId: string;
  authority: string;
  documentTitle: string;
  documentId: string;
  versionDate: string;
  locator: string;
  canonicalUrl: string;
  retrievedAt: string;
  supportStatus: "source_supported" | "context_only";
}

export interface ContextStatement {
  statementId: string;
  classification: "source_supported" | "engineering_derived" | "task_confirmation_required";
  sourceRefs: readonly string[];
  taskConfirmationRequired: boolean;
}

export interface EmiContextManifestV1 {
  schemaVersion: "1";
  resourceId: string;
  version: string;
  kind: "emi_context";
  status: ResourceStatus;
  title: string;
  content: ResourceContentDescriptor;
  governance: ResourceGovernance;
  applicability: {
    jurisdictions: readonly string[];
    regulatedEntityTypes: readonly string[];
    businessActivities: readonly string[];
    exclusions: readonly string[];
    taskConfirmationRequired: boolean;
  };
  sources: readonly RegulatorySource[];
  statements: readonly ContextStatement[];
}

export interface SkillManifestV1 {
  schemaVersion: "1";
  resourceId: string;
  version: string;
  kind: "skill";
  status: ResourceStatus;
  title: string;
  content: ResourceContentDescriptor;
  governance: ResourceGovernance;
  skill: {
    allowedRoles: readonly ResourceRole[];
    requiredInputs: readonly string[];
    outputs: readonly string[];
    prohibitedActions: readonly string[];
  };
}

export interface PromptManifestV1 {
  schemaVersion: "1";
  resourceId: string;
  version: string;
  kind: "prompt";
  status: ResourceStatus;
  title: string;
  content: ResourceContentDescriptor;
  governance: ResourceGovernance;
  prompt: {
    allowedRoles: readonly ResourceRole[];
  };
}

export type ResourceManifestV1 = EmiContextManifestV1 | PromptManifestV1 | SkillManifestV1;

export interface RegistryEntry extends VersionedRef {
  manifestPath: string;
}

export interface ResourceRegistryIndexV1 {
  schemaVersion: "1";
  resources: readonly RegistryEntry[];
}

export interface LoadedResource {
  ref: VersionedRef;
  manifest: ResourceManifestV1;
  content: string;
  source: string;
}

export interface ResourceTextProjection {
  source: string;
  content: string;
}

export interface ControlledResourceProjection {
  appendSystemPrompts: readonly ResourceTextProjection[];
  contextFiles: readonly ResourceTextProjection[];
}
