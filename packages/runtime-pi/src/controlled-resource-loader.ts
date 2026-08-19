import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

import type { RuntimeResourceSnapshot, RuntimeTextResource } from "./contracts.js";

function copyResource(resource: RuntimeTextResource): RuntimeTextResource {
  if (resource.source.trim().length === 0) {
    throw new Error("Controlled resource source must not be empty");
  }

  return Object.freeze({ source: resource.source, content: resource.content });
}

/** Pi ResourceLoader backed only by the immutable resources in a run manifest. */
export class ControlledResourceLoader implements ResourceLoader {
  private readonly systemPrompt: RuntimeTextResource | undefined;
  private readonly appendSystemPrompts: readonly RuntimeTextResource[];
  private readonly contextFiles: readonly RuntimeTextResource[];
  private readonly extensionRuntime = createExtensionRuntime();

  constructor(resources: RuntimeResourceSnapshot) {
    this.systemPrompt = resources.systemPrompt ? copyResource(resources.systemPrompt) : undefined;
    this.appendSystemPrompts = Object.freeze((resources.appendSystemPrompts ?? []).map(copyResource));
    this.contextFiles = Object.freeze((resources.contextFiles ?? []).map(copyResource));
  }

  getExtensions() {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return {
      agentsFiles: this.contextFiles.map((resource) => ({ path: resource.source, content: resource.content })),
    };
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt?.content;
  }

  getSystemPromptSource(): { path: string } | undefined {
    return this.systemPrompt ? { path: this.systemPrompt.source } : undefined;
  }

  getAppendSystemPrompt(): string[] {
    return this.appendSystemPrompts.map((resource) => resource.content);
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return this.appendSystemPrompts.map((resource) => ({ path: resource.source }));
  }

  extendResources(_paths: unknown): void {
    throw new Error("Controlled resources are immutable for the lifetime of a runtime session");
  }

  async reload(): Promise<void> {
    // The run manifest is immutable, so there is no ambient source to reload.
  }
}
