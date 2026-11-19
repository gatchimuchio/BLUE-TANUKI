import { describe, expect, it, vi } from "vitest";
import { SETTINGS_WRITE_ACTIVATION_DESTINATIONS, SettingsWriteArgumentsSchema } from "@blue-tanuki/protocol";
import { createSettingsWriteTool } from "../src/tools/settings_write.js";

const secret = "composio-secret-fixture-never-display";
type SettingsWriteTarget = Awaited<ReturnType<Parameters<typeof createSettingsWriteTool>[0]["inspect"]>>;
type SettingsWriteValues = SettingsWriteTarget["values"];

function port(overrides: Partial<SettingsWriteValues> = {}) {
  const values = {
    model: "fixture-model",
    temperature: 0.2,
    max_tokens: 512,
    timeout_ms: 30_000,
    composio: {
      api_key_configured: true,
      user_id: "fixture-user",
      allowed_toolkits: "github",
      allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
      revoked_actions: "",
      api_base_url: "https://backend.composio.dev",
      dry_run: true,
      live_execution: false,
    },
    ...overrides,
  };
  return {
    inspect: async () => ({ target_state_digest: "a".repeat(64), values }),
    apply: async () => ({ changed_keys: ["COMPOSIO_ALLOWED_ACTIONS"], restart_required: true as const }),
  };
}

describe("settings.write Composio contract", () => {
  it("accepts bounded non-secret settings and rejects credentials and unsafe API endpoints", () => {
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: { composio: {
      allowed_actions: "github:GITHUB_CREATE_AN_ISSUE", dry_run: true,
    } } }).success).toBe(true);
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: { composio: { api_key: secret } } }).success).toBe(false);
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: { composio: { api_base_url: "http://backend.composio.dev" } } }).success).toBe(false);
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: { composio: {
      api_base_url: "https://user:password@backend.composio.dev",
    } } }).success).toBe(false);
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: { composio: {
      clear_api_key: true, dry_run: false,
    } } }).success).toBe(false);
    expect(SettingsWriteArgumentsSchema.safeParse({ patch: {
      llm: { model: "fixture-model" }, composio: { live_execution: true },
    } }).success).toBe(false);
  });

  it("reviews exact Composio changes without exposing credential content", async () => {
    const tool = createSettingsWriteTool(port());
    const args = { patch: { composio: { allowed_actions: "github:GITHUB_CREATE_AN_ISSUE,github:GITHUB_CLOSE_AN_ISSUE" } } };
    const review = await tool.inspect_content_review!(args, {
      command_digest: "b".repeat(64), operation_plan_binding_digest: "c".repeat(64),
    });
    expect(review).toMatchObject({ kind: "settings_write", operation: "settings.write", no_store: true,
      used_for_authority: false, may_execute: false,
      changes: [{ key: "composio.allowed_actions", before: "github:GITHUB_CREATE_AN_ISSUE",
        after: "github:GITHUB_CREATE_AN_ISSUE,github:GITHUB_CLOSE_AN_ISSUE" }],
    });
    expect(JSON.stringify(review)).not.toContain(secret);
  });

  it("shows disconnect side effects without disclosing the stored key", async () => {
    const tool = createSettingsWriteTool(port({
      composio: {
        api_key_configured: true,
        user_id: "fixture-user",
        allowed_toolkits: "github",
        allowed_actions: "github:GITHUB_CREATE_AN_ISSUE",
        revoked_actions: "",
        api_base_url: "https://backend.composio.dev",
        dry_run: false,
        live_execution: true,
      },
    }));
    const review = await tool.inspect_content_review!({ patch: { composio: { clear_api_key: true } } }, {
      command_digest: "d".repeat(64), operation_plan_binding_digest: "e".repeat(64),
    });
    expect(review.changes).toEqual([
      { key: "composio.api_key", before: "設定済み", after: "未設定" },
      { key: "composio.dry_run", before: false, after: true },
      { key: "composio.live_execution", before: true, after: false },
    ]);
    expect(JSON.stringify(review)).not.toContain(secret);
  });
});

describe("settings.write provider activation", () => {
  const args = {
    expected_llm_provider: "stub",
    patch: { llm: {
      model: "fixture-model",
      max_tokens: 512,
      timeout_ms: 30_000,
      activation: {
        provider: "openai",
        currency: "USD",
        max_cost_per_attempt_micros: 20_000,
        max_cost_per_24h_micros: 40_000,
      },
    } },
  } as const;
  const options = { command_digest: "b".repeat(64), operation_plan_binding_digest: "c".repeat(64) };

  async function activationPort() {
    const baseline = port();
    const target: SettingsWriteTarget = { ...await baseline.inspect(), llm_provider: "stub",
      managed_llm_settings: true, provider_activation_ready: true };
    return { target, inspect: vi.fn(async () => target), apply: vi.fn(baseline.apply) };
  }

  it("shows the exact destination and all proposed limits only from a ready protected target", async () => {
    const gateway = await activationPort();
    const tool = createSettingsWriteTool(gateway);
    const review = await tool.inspect_content_review!(args, options);

    expect(gateway.inspect.mock.calls).toEqual([["stub", args.patch.llm], ["stub", args.patch.llm]]);
    expect(review).toMatchObject({
      expected_llm_provider: "stub",
      activation: { ...args.patch.llm.activation, destination: SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai,
        protected_reference_configured: true },
      changes: [
        { key: "llm.provider", before: "stub", after: "openai" },
        { key: "llm.model", before: "fixture-model", after: "fixture-model" },
        { key: "llm.max_tokens", before: 512, after: 512 },
        { key: "llm.timeout_ms", before: 30_000, after: 30_000 },
      ],
      no_store: true,
      used_for_authority: false,
      may_execute: false,
    });
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("requires a verified protected target before showing activation for approval", async () => {
    const gateway = await activationPort();
    gateway.inspect.mockResolvedValue({ ...gateway.target, provider_activation_ready: undefined });
    const tool = createSettingsWriteTool(gateway);

    await expect(tool.inspect_target_version!(args, options)).rejects.toThrow("settings_write_provider_activation_unavailable");
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("rejects changed protected target state during review", async () => {
    const gateway = await activationPort();
    gateway.inspect.mockResolvedValueOnce(gateway.target).mockResolvedValueOnce({
      ...gateway.target, target_state_digest: "f".repeat(64),
    });
    const tool = createSettingsWriteTool(gateway);

    await expect(tool.inspect_content_review!(args, options)).rejects.toThrow("settings_write_target_changed_during_review");
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("dispatches only the patch bound to the approved request and rejects prior cancellation", async () => {
    const gateway = await activationPort();
    const tool = createSettingsWriteTool(gateway);
    const target = await tool.inspect_target_version!(args, options);
    const context = { command_id: "fixture", upstream_commit_hash: "d".repeat(64),
      operation_plan_command_digest: options.command_digest, target_version_observation: target };

    const changedArgs = { ...args, patch: { llm: { ...args.patch.llm, activation: {
      ...args.patch.llm.activation, max_cost_per_24h_micros: 50_000,
    } } } };
    await expect(tool.invoke(changedArgs, context)).rejects.toThrow("settings_write_approved_target_mismatch");
    await expect(tool.invoke(args, { ...context, signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(gateway.apply).not.toHaveBeenCalled();
    await tool.invoke(args, context);
    expect(gateway.apply).toHaveBeenCalledTimes(1);
    expect(gateway.apply).toHaveBeenCalledWith(args.patch, gateway.target.target_state_digest, "stub");
  });
});
