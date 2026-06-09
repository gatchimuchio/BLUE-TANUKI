import type { SetupProviderKind } from "../../../apps/gateway/src/setup_config.js";

export interface InstallerLlmOptions {
  provider?: SetupProviderKind;
  model?: string;
  endpoint?: string;
  api_key?: string;
  api_key_env?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

export function llmSetupArgs(opts: InstallerLlmOptions): string[] {
  const args: string[] = [];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  if (opts.endpoint) args.push("--endpoint", opts.endpoint);
  if (opts.api_key) args.push("--api-key", opts.api_key);
  if (opts.api_key_env) args.push("--api-key-env", opts.api_key_env);
  if (opts.temperature !== undefined) args.push("--temperature", String(opts.temperature));
  if (opts.max_tokens !== undefined) args.push("--max-tokens", String(opts.max_tokens));
  if (opts.timeout_ms !== undefined) args.push("--timeout-ms", String(opts.timeout_ms));
  return args;
}

export function defaultModelForProvider(provider: SetupProviderKind | undefined): string | undefined {
  if (provider === "openai") return "gpt-4.1-mini";
  if (provider === "anthropic") return "claude-opus-4-7";
  if (provider === "openrouter") return "openrouter/auto";
  return undefined;
}
