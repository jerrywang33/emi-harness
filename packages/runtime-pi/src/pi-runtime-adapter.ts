import { isAbsolute } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import {
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import type { PiRuntimePort, RuntimeSession, StartRuntimeSessionRequest } from "./contracts.js";
import { createControlledPiRuntimeSession } from "./controlled-pi-session-factory.js";

export interface PiRuntimeAdapterConfig {
  agentDir: string;
  resolveApiKey(provider: string): Promise<string> | string;
}

class ControlledCredentialStore implements CredentialStore {
  constructor(private readonly resolveApiKey: PiRuntimeAdapterConfig["resolveApiKey"]) {}

  async read(providerId: string): Promise<Credential> {
    const key = await this.resolveApiKey(providerId);
    if (key.trim().length === 0) {
      throw new Error(`Controlled API key is not available for provider: ${providerId}`);
    }
    return { type: "api_key", key };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [];
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("Runtime credentials are read-only");
  }

  async delete(): Promise<void> {
    throw new Error("Runtime credentials are read-only");
  }
}

function requireValue(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

export class PiRuntimeAdapter implements PiRuntimePort {
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(private readonly config: PiRuntimeAdapterConfig) {
    requireValue("Pi agentDir", config.agentDir);
    if (!isAbsolute(config.agentDir)) {
      throw new Error("Pi agentDir must be an absolute path");
    }
  }

  async startSession(request: StartRuntimeSessionRequest): Promise<RuntimeSession> {
    const modelRuntime = await this.getModelRuntime();
    return createControlledPiRuntimeSession({
      agentDir: this.config.agentDir,
      modelRuntime,
      request,
    });
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      credentials: new ControlledCredentialStore(this.config.resolveApiKey),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return this.modelRuntimePromise;
  }
}
