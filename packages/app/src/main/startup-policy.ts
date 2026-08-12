import * as path from "node:path";

export interface AppStartupPolicyInput {
  isPackaged: boolean;
  processCwd: string;
  developmentDirect?: boolean;
  developmentWorkspace?: string;
  developmentDefaultModel?: string;
}

export interface AppStartupPolicy {
  cwd: string;
  cloudEnabled: boolean;
  loadProjectEnv: boolean;
  defaultModel?: string;
}

/** Keep repository development direct-only while leaving packaged Cloud behavior unchanged. */
export function resolveAppStartupPolicy(input: AppStartupPolicyInput): AppStartupPolicy {
  if (input.isPackaged || !input.developmentDirect) {
    return {
      cwd: path.resolve(input.processCwd),
      cloudEnabled: true,
      loadProjectEnv: true,
    };
  }
  const workspace = input.developmentWorkspace?.trim();
  const model = input.developmentDefaultModel?.trim();
  return {
    cwd:
      workspace && path.isAbsolute(workspace)
        ? path.resolve(workspace)
        : path.resolve(input.processCwd),
    cloudEnabled: false,
    loadProjectEnv: false,
    ...(model ? { defaultModel: model } : {}),
  };
}
