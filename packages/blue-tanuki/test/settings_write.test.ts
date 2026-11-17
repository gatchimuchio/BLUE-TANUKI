import { describe, expect, it } from "vitest";
import { SettingsWriteArgumentsSchema } from "@blue-tanuki/protocol";
import { createSettingsWriteTool } from "../src/tools/settings_write.js";

const secret = "composio-secret-fixture-never-display";
type SettingsWriteValues = Awaited<ReturnType<Parameters<typeof createSettingsWriteTool>[0]["inspect"]>>["values"];

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
