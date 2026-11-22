import { describe, expect, it, vi } from "vitest";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import type { ExecuteCommand } from "@blue-tanuki/protocol";
import { createExecutorApprovalAuthority, Executor } from "../src/executor.js";
import { StubBackend } from "../src/llm/stub.js";
import {
  composioStatus,
  composioSchemaDigest,
  inspectComposioActionTargetVersion as inspectComposioActionTargetVersionWithoutFixture,
  inspectComposioActionContentReview as inspectComposioActionContentReviewWithoutFixture,
  invokeComposioAccounts,
  invokeComposioExecute as invokeComposioExecuteWithoutFixture,
  invokeComposioScopes,
  invokeComposioSearch as invokeComposioSearchWithoutFixture,
  registerBuiltinTools,
  ToolRegistry,
  type ComposioExecuteTarget,
  type ComposioAccountsTarget,
  type ComposioScopesTarget,
  type ComposioSearchTarget,
} from "../src/tools/index.js";
import type { ComposioActionEffectRegistry, ComposioOptions } from "../src/tools/composio.js";
import { composioAccountsTool, composioExecuteTool, composioScopesTool, composioSearchTool } from "../src/tools/composio.js";

const issueInputSchema = { type: "object", properties: { title: { type: "string" } } };
const issueOutputSchema = { type: "object" };
const issueInputSchemaSha256 = composioSchemaDigest(issueInputSchema);
const issueActionDefinitionSha256 = composioSchemaDigest({
  slug: "GITHUB_CREATE_AN_ISSUE",
  name: "GITHUB_CREATE_AN_ISSUE",
  toolkit: "github",
  description: "Fixture action",
  version: "20261001_00",
  no_auth: false,
  is_deprecated: false,
  scopes: ["repo"],
  input_parameters: issueInputSchema,
  output_parameters: issueOutputSchema,
});
const composioFixtureActionEffectRegistry: ComposioActionEffectRegistry = {
  version: "1.1.0",
  entries: [{
    entry_id: "github.issue.create.fixture-schema.v1",
    toolkit: "github",
    tool: "GITHUB_CREATE_AN_ISSUE",
    input_schema_sha256: issueInputSchemaSha256,
    output_schema_sha256: composioSchemaDigest(issueOutputSchema),
    action_definition_sha256: issueActionDefinitionSha256,
    effects: ["external_send", "write"],
  }],
};
const credentialRef = "synthetic-composio-reference";
const issueArgs = {
  toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
  input_schema_sha256: issueInputSchemaSha256, payload: { title: "fixture" },
};

function withComposioFixtureRegistry(options: ComposioOptions = {}): ComposioOptions {
  return { ...options, actionEffectRegistry: options.actionEffectRegistry ?? composioFixtureActionEffectRegistry };
}

function inspectComposioActionTargetVersion(args: Record<string, unknown>, options: ComposioOptions) {
  return inspectComposioActionTargetVersionWithoutFixture(args, withComposioFixtureRegistry(options));
}

function inspectComposioActionContentReview(args: Record<string, unknown>, options: ComposioOptions) {
  return inspectComposioActionContentReviewWithoutFixture(args, withComposioFixtureRegistry(options));
}

function invokeComposioExecute(args: Record<string, unknown>, options: ComposioOptions = {}) {
  return invokeComposioExecuteWithoutFixture(args, withComposioFixtureRegistry(options));
}

function invokeComposioSearch(args: Record<string, unknown>, options: ComposioOptions = {}) {
  return invokeComposioSearchWithoutFixture(args, withComposioFixtureRegistry(options));
}

function composioCommand(tool: typeof composioExecuteTool, args = issueArgs): Extract<ExecuteCommand, { type: "tool_call" }> {
  return {
    id: `fixture-${tool.name}`, type: "tool_call", payload: { tool_name: tool.name, arguments: args },
    constraints: { allowed_tools: [tool.name], allowed_capabilities: [...(tool.required_capabilities ?? [])] },
    upstream_decision: { commit_hash: "synthetic-hds-commit", frame_goal: "fixture", model_abstraction: "fixture",
      commit_decision: "ASSERT" },
  };
}

function actionSchemaResponse(toolkit: string, slug: string, inputParameters: Record<string, unknown> = issueInputSchema) {
  return {
    status: 200,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({ items: [{
      slug,
      name: slug,
      toolkit: { slug: toolkit },
      description: "Fixture action",
      version: "20261001_00",
      no_auth: false,
      is_deprecated: false,
      scopes: ["repo"],
      input_parameters: inputParameters,
      output_parameters: issueOutputSchema,
    }] }),
    truncated: false,
    request_id: "req_action_schema_fixture",
  };
}

const activeAccount = {
  id: "conn_owner_github_1",
  toolkit: { slug: "github" },
  user_id: "owner-local",
  status: "ACTIVE",
  is_disabled: false,
  experimental: { account_type: "PRIVATE" },
  state: { val: { oauth_token: "must-not-escape" } },
  data: { secret: "must-not-escape-either" },
};

const activePostHogAccount = {
  id: "conn_owner_posthog_1",
  toolkit: { slug: "posthog" },
  user_id: "owner-local",
  status: "ACTIVE",
  is_disabled: false,
  authScheme: "API_KEY",
  auth_config: { auth_scheme: "API_KEY" },
  experimental: { account_type: "PRIVATE" },
  state: {
    authScheme: "API_KEY",
    val: { region: "eu", generic_api_key: "must-not-escape-posthog-secret" },
  },
  data: { secret: "must-not-escape-posthog-data" },
};

function accountResponse(account: Record<string, unknown> = activeAccount) {
  return {
    status: 200,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({ items: [account], next_cursor: null }),
    truncated: false,
    request_id: "req_accounts_fixture",
  };
}

describe("Composio connector", () => {
  it("resolves a fresh protected credential for exact target and no-store review calls", async () => {
    const env = { COMPOSIO_API_KEY_REF: credentialRef, COMPOSIO_ALLOWED_TOOLKITS: "github",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE", COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false", COMPOSIO_LIVE_EXECUTION: "true", UNRELATED_SECRET: "not-for-the-adapter" };
    let generation = 0;
    const resolve = vi.fn((_ref: string) => `resolved-fixture-key-${++generation}`);
    const accountKeys: string[] = [];
    const accountsRequest = async (target: ComposioAccountsTarget) => { accountKeys.push(target.api_key); return accountResponse(); };
    const searchRequest = async () => actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE");
    const target = vi.spyOn(composioExecuteTool, "inspect_target_version").mockImplementation((args, options) =>
      inspectComposioActionTargetVersion(args, { env: options?.env, commandDigest: options?.command_digest,
        operationPlanBindingDigest: options?.operation_plan_binding_digest,
        actionEffectRegistry: options?.composio_action_effect_registry ?? composioFixtureActionEffectRegistry,
        accountsRequest, searchRequest }));
    const review = vi.spyOn(composioExecuteTool, "inspect_content_review").mockImplementation((args, options) =>
      inspectComposioActionContentReview(args, { env: options?.env, commandDigest: options?.command_digest,
        operationPlanBindingDigest: options?.operation_plan_binding_digest,
        actionEffectRegistry: options?.composio_action_effect_registry ?? composioFixtureActionEffectRegistry,
        accountsRequest, searchRequest }));
    const tools = new ToolRegistry();
    tools.register(composioExecuteTool);
    const executor = new Executor({ approval_authority: createExecutorApprovalAuthority(), tools,
      llm: new StubBackend(), resolve_composio_api_key: resolve,
      composio_action_effect_registry: composioFixtureActionEffectRegistry });
    const command = composioCommand(composioExecuteTool);
    const planDigest = "b".repeat(64);
    try {
      const observation = await executor.inspectCommandTargetVersion(command, env, planDigest);
      const content = await executor.inspectCommandContentReview(command, env, planDigest);
      await executor.inspectCommandTargetVersion(command, { ...env, COMPOSIO_API_KEY: "raw-fixture-key" }, planDigest);
      expect(content).toMatchObject({ kind: "composio_execute", no_store: true, target_version_observation: observation });
      expect(accountKeys).toEqual(["resolved-fixture-key-1", "resolved-fixture-key-2", "raw-fixture-key"]);
      expect(resolve.mock.calls).toEqual([[credentialRef], [credentialRef]]);
      expect(target.mock.calls[0]?.[1]?.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(review.mock.calls[0]?.[1]?.env).not.toHaveProperty("COMPOSIO_API_KEY_REF");
      expect(JSON.stringify(content)).not.toMatch(/(fixture-key|not-for-the-adapter)/u);

      resolve.mockImplementationOnce(() => { throw new Error("private OS error detail"); });
      await expect(executor.inspectCommandTargetVersion(command, env, planDigest)).rejects.toThrow(/^composio_credential_unavailable$/u);
      expect(target).toHaveBeenCalledTimes(2);
      expect(accountKeys).toHaveLength(3);
    } finally {
      target.mockRestore();
      review.mockRestore();
    }
  });

  it("binds protected credentials at the exact built-in dispatch and keeps dry-run offline", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", undefined);
    vi.stubEnv("COMPOSIO_API_KEY_REF", credentialRef);
    vi.stubEnv("COMPOSIO_ALLOWED_TOOLKITS", "github");
    vi.stubEnv("COMPOSIO_ALLOWED_ACTIONS", "github:GITHUB_CREATE_AN_ISSUE");
    vi.stubEnv("COMPOSIO_REVOKED_ACTIONS", undefined);
    vi.stubEnv("COMPOSIO_DRY_RUN", "true");
    vi.stubEnv("COMPOSIO_LIVE_EXECUTION", "false");
    const secret = "resolved-dispatch-fixture";
    const resolve = vi.fn((_ref: string) => secret);
    const authority = createExecutorApprovalAuthority();
    const dispatch = (executor: Executor, tool: typeof composioExecuteTool) => {
      const command = composioCommand(tool);
      const context = approvalContextFromCommand(command);
      const final = finalReviewRequired(context);
      const approved = authority.approve(command, { source: final ? "human_final_review" : "approval_gate",
        decision: final ? "approve" : "allow", risk: context.risk, operation: context.operation, final_review_required: final,
        approved_by: "fixture", approved_at_ms: Date.now(), upstream_commit_hash: command.upstream_decision.commit_hash, reason: "fixture" });
      return executor.execute(approved);
    };
    const tools = new ToolRegistry();
    const executor = new Executor({ approval_authority: authority, tools, llm: new StubBackend(), resolve_composio_api_key: resolve });
    try {
      for (const tool of [composioSearchTool, composioAccountsTool, composioScopesTool]) {
        tools.register(tool);
        vi.spyOn(tool, "invoke").mockImplementation(async (_args, context) => {
          expect(context.composio_api_key).toBe(secret);
          return { checked: true };
        });
        expect(await dispatch(executor, tool)).toMatchObject({ status: "success", result: { checked: true } });
      }
      tools.register(composioExecuteTool);
      expect(await dispatch(executor, composioExecuteTool)).toMatchObject({ status: "success",
        result: { dry_run: true, executed: false, external_call_performed: false } });
      expect(resolve.mock.calls).toEqual(Array.from({ length: 4 }, () => [credentialRef]));
      expect(process.env.COMPOSIO_API_KEY).toBeUndefined();
      resolve.mockImplementationOnce(() => { throw new Error("private resolution detail"); });
      const rejected = await dispatch(executor, composioSearchTool);
      expect(rejected).toMatchObject({ status: "failed", error: "composio_credential_unavailable" });
      expect(composioSearchTool.invoke).toHaveBeenCalledTimes(1);

      const otherTools = new ToolRegistry();
      const imitation = { ...composioSearchTool, invoke: vi.fn(async (_args, context) => {
        expect(context).not.toHaveProperty("composio_api_key");
        return { scoped: true };
      }) } satisfies typeof composioSearchTool;
      otherTools.register(imitation);
      const otherExecutor = new Executor({ approval_authority: authority, tools: otherTools,
        llm: new StubBackend(), resolve_composio_api_key: resolve });
      expect(await dispatch(otherExecutor, imitation)).toMatchObject({ status: "success", result: { scoped: true } });
      expect(resolve).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it("hashes schema objects independently of JSON key order", () => {
    expect(composioSchemaDigest({ type: "object", properties: { title: { type: "string" } } }))
      .toBe(composioSchemaDigest({ properties: { title: { type: "string" } }, type: "object" }));
  });

  it("binds the exact live action, owner account, schema, payload and Operation Plan into a no-store review", async () => {
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "github",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };
    const args = {
      toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
      input_schema_sha256: issueInputSchemaSha256, payload: { title: "review fixture" },
    };
    const commandDigest = "a".repeat(64);
    const operationPlanBindingDigest = "b".repeat(64);
    let accountRequests = 0;
    let actionRequests = 0;
    const options = {
      env,
      commandDigest,
      operationPlanBindingDigest,
      accountsRequest: async () => { accountRequests += 1; return accountResponse(); },
      searchRequest: async () => { actionRequests += 1; return actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"); },
    };
    const observation = await inspectComposioActionTargetVersion(args, options);
    const review = await inspectComposioActionContentReview(args, options);
    expect(observation).toMatchObject({
      schema_version: "blue-tanuki.composio-action-target-version.v2",
      toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", toolkit_version: "20261001_00", command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
      target_state: "available", used_for_authority: false, may_execute: false,
    });
    expect(review).toMatchObject({
      kind: "composio_execute", operation: "composio.execute", toolkit: "github",
      connected_account_id: "conn_owner_github_1", account_type: "PRIVATE", account_status: "ACTIVE",
      arguments: { title: "review fixture" }, input_parameters: issueInputSchema,
      no_store: true, used_for_authority: false, may_execute: false,
      provider_metadata_used_for_authority: false,
    });
    expect(review.target_version_observation).toEqual(observation);
    expect(accountRequests).toBe(2);
    expect(actionRequests).toBe(2);
    expect(JSON.stringify(review)).not.toContain("composio-secret-value");
    expect(JSON.stringify(review)).not.toContain("must-not-escape");
    expect(JSON.stringify(review)).not.toContain("owner-local");
  });

  it("does not query Composio when a live target review is disabled by dry-run", async () => {
    let providerCalls = 0;
    await expect(inspectComposioActionTargetVersion({ toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE" }, {
      env: { COMPOSIO_DRY_RUN: "true", COMPOSIO_LIVE_EXECUTION: "true" },
      commandDigest: "a".repeat(64), operationPlanBindingDigest: "b".repeat(64),
      accountsRequest: async () => { providerCalls += 1; return accountResponse(); },
      searchRequest: async () => { providerCalls += 1; return actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"); },
    })).rejects.toThrow(/dry-run is disabled and live execution is enabled/);
    expect(providerCalls).toBe(0);
  });

  it("requires target evidence before a live adapter invocation can reach account or action endpoints", async () => {
    let providerCalls = 0;
    await expect(invokeComposioExecute({
      toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
      input_schema_sha256: issueInputSchemaSha256,
    }, {
      env: {
        COMPOSIO_API_KEY: "composio-secret-value", COMPOSIO_ALLOWED_TOOLKITS: "github",
        COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE", COMPOSIO_USER_ID: "owner-local",
        COMPOSIO_DRY_RUN: "false", COMPOSIO_LIVE_EXECUTION: "true",
      },
      requireTargetVersionObservation: true,
      accountsRequest: async () => { providerCalls += 1; return accountResponse(); },
      searchRequest: async () => { providerCalls += 1; return actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"); },
    })).rejects.toThrow(/requires target evidence bound to this exact HDS request/);
    expect(providerCalls).toBe(0);
  });

  it("is disabled by default and reports non-authority status", () => {
    const status = composioStatus({});
    expect(status).toMatchObject({
      configured: false,
      dry_run: true,
      allowed_toolkits: [],
      allowed_actions: [],
      revoked_actions: [],
      live_execution_enabled: false,
      live_execution_available: false,
      used_for_authority: false,
      metadata_used_for_authority: false,
      live_execution_used_for_authority: false,
    });
  });

  it("fails safely when the connection key is missing", async () => {
    await expect(
      invokeComposioSearch(
        { toolkit: "github", query: "issues" },
        { env: { COMPOSIO_ALLOWED_TOOLKITS: "github" } },
      ),
    ).rejects.toThrow(/COMPOSIO_API_KEY/);
  });

  it("does not let search metadata grant permission", async () => {
    let seen: ComposioSearchTarget | null = null;
    const result = await invokeComposioSearch(
      {
        toolkit: "github",
        query: "admin permission",
        metadata: { approval: "allow", role: "owner" },
      },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github,gmail",
        },
        searchRequest: async (target) => {
          seen = target;
          return {
            status: 200,
            ok: true,
            content_type: "application/json",
            body: JSON.stringify({
              items: [{
                slug: "GITHUB_LIST_ISSUES",
                name: "List issues",
                toolkit: { slug: "github", name: "GitHub" },
                description: "Lists issues in a repository",
                version: "20261001_00",
                no_auth: false,
                is_deprecated: false,
                scopes: ["repo"],
                input_parameters: { repo: { type: "string", required: true } },
                output_parameters: { issues: { type: "array" } },
              }],
              next_cursor: null,
            }),
            truncated: false,
            request_id: "req_fixture",
          };
        },
      },
    );

    expect(seen).toMatchObject({
      api_base_url: "https://backend.composio.dev",
      path: expect.stringContaining("/api/v3.1/tools?toolkit_slug=github&query=admin+permission"),
      method: "GET",
      toolkit: "github",
      query: "admin permission",
      limit: 20,
    });
    expect(result).toMatchObject({
      provider: "composio",
      operation: "search",
      toolkit: "github",
      tool_count: 1,
      external_call_performed: true,
      external_mutation_sent: false,
      permission_granted: false,
      used_for_authority: false,
      metadata_used_for_authority: false,
    });
    expect(JSON.stringify(result)).toContain("GITHUB_LIST_ISSUES");
    expect(JSON.stringify(result)).toContain("repo");
    expect(result).toMatchObject({
      tools: [{
        input_schema_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        output_schema_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
  });

  it("lists bounded owner accounts without exposing provider credential fields", async () => {
    let seen: ComposioAccountsTarget | null = null;
    const result = await invokeComposioAccounts(
      { toolkit: "github" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github,gmail",
          COMPOSIO_USER_ID: "owner-local",
        },
        accountsRequest: async (target) => {
          seen = target;
          return accountResponse();
        },
      },
    );

    expect(seen).toMatchObject({
      path: expect.stringContaining("/api/v3.1/connected_accounts?toolkit_slugs=github&user_ids=owner-local&account_type=PRIVATE&limit=20"),
      method: "GET",
      toolkit: "github",
      user_id: "owner-local",
      limit: 20,
    });
    expect(result).toMatchObject({
      operation: "accounts",
      toolkit: "github",
      account_count: 1,
      external_call_performed: true,
      external_mutation_sent: false,
      accounts: [{
        connected_account_id: "conn_owner_github_1",
        toolkit: "github",
        status: "ACTIVE",
        is_disabled: false,
        account_type: "PRIVATE",
      }],
      used_for_authority: false,
      metadata_used_for_authority: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(JSON.stringify(result)).not.toContain("owner-local");
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
  });

  it("projects only the documented PostHog region and auth scheme from connection metadata", async () => {
    const result = await invokeComposioAccounts(
      { toolkit: "posthog" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "posthog",
          COMPOSIO_USER_ID: "owner-local",
        },
        accountsRequest: async () => accountResponse(activePostHogAccount),
      },
    );

    expect(result).toMatchObject({
      accounts: [{
        connected_account_id: "conn_owner_posthog_1",
        auth_scheme: "API_KEY",
        provider_region: "eu",
      }],
      used_for_authority: false,
      metadata_used_for_authority: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-not-escape-posthog-secret");
    expect(serialized).not.toContain("must-not-escape-posthog-data");
    expect(serialized).not.toContain("owner-local");
    expect(serialized).not.toContain("composio-secret-value");
  });

  it("returns a bounded experimental least-privilege scope recommendation without treating it as a grant", async () => {
    let seen: ComposioScopesTarget | null = null;
    const result = await invokeComposioScopes(
      {
        toolkit: "github",
        tools: ["GITHUB_CREATE_AN_ISSUE"],
        toolkit_version: "20261001_00",
      },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
        },
        scopesRequest: async (target) => {
          seen = target;
          return {
            status: 200,
            ok: true,
            content_type: "application/json",
            body: JSON.stringify({
              auth_scheme: "OAUTH2",
              toolkit_version: "20261001_00",
              scopes: {
                least_privilege: ["repo", "user:email"],
                fewest: ["repo"],
                conditional: [{ scope: "user:email", for: ["GITHUB_CREATE_AN_ISSUE"], when: { parameter: "fixture" } }],
              },
            }),
            truncated: false,
            request_id: "req_scope_fixture",
          };
        },
      },
    );

    expect(seen).toMatchObject({
      api_base_url: "https://backend.composio.dev",
      path: "/api/v3.1/toolkits/github/scopes/recommended",
      method: "POST",
      toolkit: "github",
      tools: ["GITHUB_CREATE_AN_ISSUE"],
      toolkit_version: "20261001_00",
      auth_scheme: "OAUTH2",
      body: {
        tools: ["GITHUB_CREATE_AN_ISSUE"],
        toolkit_version: "20261001_00",
        auth_scheme: "OAUTH2",
      },
    });
    expect(result).toMatchObject({
      operation: "scopes",
      toolkit: "github",
      toolkit_version: "20261001_00",
      requested_toolkit_version: "20261001_00",
      auth_scheme_source: "default_OAUTH2",
      least_privilege: ["repo", "user:email"],
      fewest: ["repo"],
      conditional: [{
        scope: "user:email",
        for: ["GITHUB_CREATE_AN_ISSUE"],
        when: { parameter: "fixture" },
      }],
      contract_status: "experimental_beta",
      external_call_performed: true,
      external_mutation_sent: false,
      permission_granted: false,
      granted_scopes_observed: false,
      scope_recommendation_used_for_authority: false,
      used_for_authority: false,
      metadata_used_for_authority: false,
    });
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
  });

  it("does not request scope recommendations for an action outside the explicit action allowlist", async () => {
    let dispatched = false;
    await expect(invokeComposioScopes(
      { toolkit: "github", tools: ["GITHUB_CREATE_AN_ISSUE"] },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_LIST_ISSUES",
        },
        scopesRequest: async () => {
          dispatched = true;
          throw new Error("unexpected scope request");
        },
      },
    )).rejects.toThrow(/action not allowed/);
    expect(dispatched).toBe(false);
  });

  it("rejects connected account rows outside the configured owner and toolkit", async () => {
    await expect(invokeComposioAccounts(
      { toolkit: "github" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_USER_ID: "owner-local",
        },
        accountsRequest: async () => accountResponse({
          ...activeAccount,
          user_id: "different-user",
        }),
      },
    )).rejects.toThrow(/out-of-scope/);
  });

  it("rejects shared accounts even when the provider returns one for a private-only query", async () => {
    await expect(invokeComposioAccounts(
      { toolkit: "github" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_USER_ID: "owner-local",
        },
        accountsRequest: async () => accountResponse({
          ...activeAccount,
          experimental: { account_type: "SHARED" },
        }),
      },
    )).rejects.toThrow(/non-private/);
  });

  it("does not return a partial account inventory when the provider indicates another page", async () => {
    await expect(invokeComposioAccounts(
      { toolkit: "github", limit: 1 },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_USER_ID: "owner-local",
        },
        accountsRequest: async () => ({
          ...accountResponse(),
          body: JSON.stringify({ items: [activeAccount], next_cursor: "page-2" }),
        }),
      },
    )).rejects.toThrow(/incomplete/);
  });

  it("does not dispatch a catalog lookup without an explicit toolkit allowlist", async () => {
    let dispatched = false;
    await expect(invokeComposioSearch(
      { toolkit: "github", query: "issues" },
      {
        env: { COMPOSIO_API_KEY: "composio-secret-value" },
        searchRequest: async () => {
          dispatched = true;
          throw new Error("unexpected catalog request");
        },
      },
    )).rejects.toThrow(/COMPOSIO_ALLOWED_TOOLKITS/);
    expect(dispatched).toBe(false);
  });

  it("bounds the search query before dispatch", async () => {
    let dispatched = false;
    await expect(invokeComposioSearch(
      { toolkit: "github", query: "x".repeat(501) },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
        },
        searchRequest: async () => {
          dispatched = true;
          throw new Error("unexpected catalog request");
        },
      },
    )).rejects.toThrow(/500 characters or fewer/);
    expect(dispatched).toBe(false);
  });

  it("rejects catalog entries outside the requested toolkit", async () => {
    await expect(invokeComposioSearch(
      { toolkit: "github", query: "issues" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
        },
        searchRequest: async () => ({
          status: 200,
          ok: true,
          content_type: "application/json",
          body: JSON.stringify({ items: [{
            slug: "SLACK_POST_MESSAGE",
            name: "Post message",
            toolkit: { slug: "slack" },
          }] }),
          truncated: false,
          request_id: "req_fixture",
        }),
      },
    )).rejects.toThrow(/out-of-scope/);
  });

  it("fails closed on truncated catalog metadata instead of returning partial schemas", async () => {
    await expect(invokeComposioSearch(
      { toolkit: "github", query: "issues" },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
        },
        searchRequest: async () => ({
          status: 200,
          ok: true,
          content_type: "application/json",
          body: "{\"items\":[",
          truncated: true,
          request_id: "req_fixture",
        }),
      },
    )).rejects.toThrow(/exceeded the configured limit/);
  });

  it("enforces explicit toolkit allowlists", async () => {
    await expect(
      invokeComposioExecute(
        { toolkit: "slack", tool: "messages.send", payload: { text: "hi" } },
        {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
          },
        },
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("requires an exact toolkit/action pair in the live action allowlist", async () => {
    for (const configuredAction of ["github:*", "issues.create"]) {
      let accountLookupDispatched = false;
      let executionDispatched = false;
      await expect(invokeComposioExecute(
        {
          toolkit: "github",
          tool: "issues.create",
          connected_account_id: "conn_owner_github_1",
        },
        {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
            COMPOSIO_ALLOWED_ACTIONS: configuredAction,
            COMPOSIO_USER_ID: "owner-local",
            COMPOSIO_DRY_RUN: "false",
            COMPOSIO_LIVE_EXECUTION: "true",
          },
          accountsRequest: async () => {
            accountLookupDispatched = true;
            return accountResponse();
          },
          request: async () => {
            executionDispatched = true;
            return {
              status: 200,
              ok: true,
              content_type: "application/json",
              body: "{}",
              truncated: false,
              request_id: "req_fixture",
            };
          },
        },
      )).rejects.toThrow(/action not allowed/);
      expect(accountLookupDispatched).toBe(false);
      expect(executionDispatched).toBe(false);
    }
  });

  it("keeps external execution in dry-run by default", async () => {
    const result = await invokeComposioExecute(
      { toolkit: "github", tool: "issues.create", payload: { title: "hello" } },
      {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
            COMPOSIO_ALLOWED_ACTIONS: "github:issues.create",
          },
        },
      );

    expect(result).toMatchObject({
      provider: "composio",
      operation: "execute",
      toolkit: "github",
      tool: "issues.create",
      intent: "write",
      dry_run: true,
      executed: false,
      external_mutation_sent: false,
      external_call_performed: false,
      approval_required: true,
      used_for_authority: false,
    });
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
  });

  it("does not let caller-supplied intent downgrade the action classification", async () => {
    for (const [tool, intent] of [
      ["GITHUB_DELETE_REPO", "read"],
      ["issues.create", "read"],
    ] as const) {
      let accountLookupDispatched = false;
      let executionDispatched = false;
      await expect(invokeComposioExecute(
        {
          toolkit: "github",
          tool,
          intent,
          connected_account_id: "conn_owner_github_1",
        },
        {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
            COMPOSIO_ALLOWED_ACTIONS: `github:${tool}`,
            COMPOSIO_USER_ID: "owner-local",
            COMPOSIO_DRY_RUN: "false",
            COMPOSIO_LIVE_EXECUTION: "true",
          },
          accountsRequest: async () => {
            accountLookupDispatched = true;
            return accountResponse();
          },
          request: async () => {
            executionDispatched = true;
            return {
              status: 200,
              ok: true,
              content_type: "application/json",
              body: "{}",
              truncated: false,
              request_id: "req_fixture",
            };
          },
        },
      )).rejects.toThrow(/intent does not match the action classification/);
      expect(accountLookupDispatched).toBe(false);
      expect(executionDispatched).toBe(false);
    }
  });

  it("requires explicit live execution opt-in before external calls", async () => {
    await expect(
      invokeComposioExecute(
        { toolkit: "github", tool: "issues.create", payload: { title: "hello" } },
        {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
            COMPOSIO_ALLOWED_ACTIONS: "github:issues.create",
            COMPOSIO_DRY_RUN: "false",
          },
        },
      ),
    ).rejects.toThrow(/COMPOSIO_LIVE_EXECUTION/);
  });

  it("requires a concrete owner account and rejects the provider instant account", async () => {
    let dispatched = false;
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "github",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };
    const request = async () => {
      dispatched = true;
      return accountResponse();
    };
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE" },
      { env, accountsRequest: request },
    )).rejects.toThrow(/connected_account_id is required/);
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "instant_account" },
      { env, accountsRequest: request },
    )).rejects.toThrow(/explicit owner connection/);
    expect(dispatched).toBe(false);
  });

  it("blocks execution when the selected owner account is not active", async () => {
    let executeDispatched = false;
    await expect(invokeComposioExecute(
      {
        toolkit: "github",
        tool: "GITHUB_CREATE_AN_ISSUE",
        connected_account_id: "conn_owner_github_1",
        input_schema_sha256: issueInputSchemaSha256,
      },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
          COMPOSIO_USER_ID: "owner-local",
          COMPOSIO_DRY_RUN: "false",
          COMPOSIO_LIVE_EXECUTION: "true",
        },
        accountsRequest: async () => accountResponse({ ...activeAccount, status: "EXPIRED" }),
        request: async () => {
          executeDispatched = true;
          return accountResponse();
        },
      },
    )).rejects.toThrow(/not PRIVATE ACTIVE/);
    expect(executeDispatched).toBe(false);
  });

  it("requires the observed PostHog region and API-key auth scheme to match before live execution", async () => {
    let executeDispatched = false;
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "posthog",
      COMPOSIO_ALLOWED_ACTIONS: "posthog:POSTHOG_CREATE_INSIGHT",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };
    const request = async (target: ComposioExecuteTarget) => {
      executeDispatched = true;
      expect(target.body).not.toHaveProperty("expected_provider_region");
      return {
        status: 200,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ data: { id: "fixture-insight" } }),
        truncated: false,
        request_id: "req_posthog_fixture",
      };
    };

    const result = await invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
        expected_provider_region: "eu",
        input_schema_sha256: issueInputSchemaSha256,
        payload: { name: "fixture" },
      },
      {
        env,
        accountsRequest: async () => accountResponse(activePostHogAccount),
        searchRequest: async () => actionSchemaResponse("posthog", "POSTHOG_CREATE_INSIGHT"),
        request,
      },
    );
    expect(result).toMatchObject({
      provider_region: "eu",
      provider_auth_scheme: "API_KEY",
      connection_context_used_for_authority: false,
    });
    expect(executeDispatched).toBe(true);

    executeDispatched = false;
    await expect(invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
      },
      {
        env,
        accountsRequest: async () => accountResponse(activePostHogAccount),
        request,
      },
    )).rejects.toThrow(/expected_provider_region=us\|eu is required/);
    expect(executeDispatched).toBe(false);

    await expect(invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
        expected_provider_region: "us",
        input_schema_sha256: issueInputSchemaSha256,
      },
      {
        env,
        accountsRequest: async () => accountResponse(activePostHogAccount),
        request,
      },
    )).rejects.toThrow(/unknown\/mismatched PostHog auth scheme or region/);
    expect(executeDispatched).toBe(false);

    await expect(invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
        expected_provider_region: "eu",
        input_schema_sha256: issueInputSchemaSha256,
      },
      {
        env,
        accountsRequest: async () => accountResponse({
          ...activePostHogAccount,
          auth_config: { auth_scheme: "OAUTH2" },
        }),
        searchRequest: async () => actionSchemaResponse("posthog", "POSTHOG_CREATE_INSIGHT"),
        request,
      },
    )).rejects.toThrow(/unknown\/mismatched PostHog auth scheme or region/);
    expect(executeDispatched).toBe(false);

    await expect(invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
        expected_provider_region: "eu",
        input_schema_sha256: issueInputSchemaSha256,
      },
      {
        env,
        accountsRequest: async () => accountResponse({
          ...activePostHogAccount,
          state: { authScheme: "API_KEY", val: { region: "https://eu.posthog.com" } },
        }),
        searchRequest: async () => actionSchemaResponse("posthog", "POSTHOG_CREATE_INSIGHT"),
        request,
      },
    )).rejects.toThrow(/unknown\/mismatched PostHog auth scheme or region/);
    expect(executeDispatched).toBe(false);
  });

  it("rejects an unknown or non-PostHog expected region before a provider call", async () => {
    let accountLookupDispatched = false;
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "github,posthog",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE,posthog:POSTHOG_CREATE_INSIGHT",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };
    await expect(invokeComposioExecute(
      {
        toolkit: "posthog",
        tool: "POSTHOG_CREATE_INSIGHT",
        connected_account_id: "conn_owner_posthog_1",
        expected_provider_region: "https://eu.posthog.com",
      },
      {
        env,
        accountsRequest: async () => {
          accountLookupDispatched = true;
          return accountResponse(activePostHogAccount);
        },
      },
    )).rejects.toThrow(/expected_provider_region must be us or eu/);
    await expect(invokeComposioExecute(
      {
        toolkit: "github",
        tool: "GITHUB_CREATE_AN_ISSUE",
        connected_account_id: "conn_owner_github_1",
        expected_provider_region: "eu",
      },
      {
        env,
        accountsRequest: async () => {
          accountLookupDispatched = true;
          return accountResponse();
        },
      },
    )).rejects.toThrow(/only valid for the PostHog toolkit/);
    expect(accountLookupDispatched).toBe(false);
  });

  it("blocks revoked action scopes before live execution", async () => {
    await expect(
      invokeComposioExecute(
        { toolkit: "github", tool: "issues.create", payload: { title: "hello" } },
        {
          env: {
            COMPOSIO_API_KEY: "composio-secret-value",
            COMPOSIO_ALLOWED_TOOLKITS: "github",
            COMPOSIO_ALLOWED_ACTIONS: "github:issues.create",
            COMPOSIO_REVOKED_ACTIONS: "github:issues.create",
            COMPOSIO_USER_ID: "owner-local",
            COMPOSIO_DRY_RUN: "false",
            COMPOSIO_LIVE_EXECUTION: "true",
          },
        },
      ),
    ).rejects.toThrow(/revoked/);
  });

  it("executes live through the bounded Composio API adapter when all gates are explicit", async () => {
    let seen: ComposioExecuteTarget | null = null;
    let accountLookup: ComposioAccountsTarget | null = null;
    const result = await invokeComposioExecute(
      {
        toolkit: "github",
        tool: "GITHUB_CREATE_AN_ISSUE",
        connected_account_id: "conn_owner_github_1",
        input_schema_sha256: issueInputSchemaSha256,
        payload: { title: "hello" },
      },
      {
        env: {
          COMPOSIO_API_KEY: "composio-secret-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
          COMPOSIO_USER_ID: "owner-local",
          COMPOSIO_DRY_RUN: "false",
          COMPOSIO_LIVE_EXECUTION: "true",
        },
        request: async (target) => {
          seen = target;
          return {
            status: 200,
            ok: true,
            content_type: "application/json",
            body: JSON.stringify({ data: { id: 123, status: "ok" }, log_id: "log_fixture" }),
            truncated: false,
            request_id: "req_fixture",
          };
        },
        accountsRequest: async (target) => {
          accountLookup = target;
          return accountResponse();
        },
        searchRequest: async (target) => {
          expect(target).toMatchObject({ toolkit: "github", query: "GITHUB_CREATE_AN_ISSUE", method: "GET" });
          return actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE");
        },
      },
    );

    expect(accountLookup).toMatchObject({
      path: expect.stringContaining("connected_account_ids=conn_owner_github_1"),
      toolkit: "github",
      user_id: "owner-local",
      connected_account_id: "conn_owner_github_1",
      limit: 2,
    });
    expect(seen).toMatchObject({
      api_base_url: "https://backend.composio.dev",
      path: "/api/v3.1/tools/execute/GITHUB_CREATE_AN_ISSUE",
      method: "POST",
      user_id: "owner-local",
      body: {
        user_id: "owner-local",
        connected_account_id: "conn_owner_github_1",
        version: "20261001_00",
        arguments: { title: "hello" },
      },
    });
    expect(result).toMatchObject({
      provider: "composio",
      operation: "execute",
      toolkit: "github",
      tool: "GITHUB_CREATE_AN_ISSUE",
      dry_run: false,
      live_execution_enabled: true,
      executed: true,
      external_call_performed: true,
      external_mutation_sent: true,
      mutation_status: "confirmed",
      used_for_authority: false,
      metadata_used_for_authority: false,
      live_execution_used_for_authority: false,
    });
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
  });

  it("requires a selected schema digest and rejects schema drift before action dispatch", async () => {
    let accountLookupDispatched = false;
    let executeDispatched = false;
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "github",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };

    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1" },
      { env, accountsRequest: async () => {
        accountLookupDispatched = true;
        return accountResponse();
      } },
    )).rejects.toThrow(/input_schema_sha256 is required for live execution/);
    expect(accountLookupDispatched).toBe(false);

    await expect(invokeComposioExecute(
      {
        toolkit: "github",
        tool: "GITHUB_CREATE_AN_ISSUE",
        connected_account_id: "conn_owner_github_1",
        input_schema_sha256: issueInputSchemaSha256,
      },
      {
        env,
        accountsRequest: async () => {
          accountLookupDispatched = true;
          return accountResponse();
        },
        searchRequest: async () => actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE", {
          type: "object", properties: { title: { type: "string" }, repository: { type: "string" } },
        }),
        request: async () => {
          executeDispatched = true;
          return actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE");
        },
      },
    )).rejects.toThrow(/input schema changed since selection/);
    expect(accountLookupDispatched).toBe(true);
    expect(executeDispatched).toBe(false);
  });

  it("rejects a changed action definition after no-store review even when input schema is unchanged", async () => {
    const env = {
      COMPOSIO_API_KEY: "composio-secret-value",
      COMPOSIO_ALLOWED_TOOLKITS: "github",
      COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
      COMPOSIO_USER_ID: "owner-local",
      COMPOSIO_DRY_RUN: "false",
      COMPOSIO_LIVE_EXECUTION: "true",
    };
    const args = {
      toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
      input_schema_sha256: issueInputSchemaSha256, payload: { title: "reviewed" },
    };
    const commandDigest = "c".repeat(64);
    const targetVersionObservation = await inspectComposioActionTargetVersion(args, {
      env, commandDigest, operationPlanBindingDigest: "d".repeat(64),
      accountsRequest: async () => accountResponse(),
      searchRequest: async () => actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"),
    });
    let executionDispatched = false;
    await expect(invokeComposioExecute(args, {
      env,
      commandDigest,
      targetVersionObservation,
      requireTargetVersionObservation: true,
      accountsRequest: async () => accountResponse(),
      searchRequest: async () => ({
        ...actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"),
        body: JSON.stringify({ items: [{
          slug: "GITHUB_CREATE_AN_ISSUE", name: "GITHUB_CREATE_AN_ISSUE", toolkit: { slug: "github" },
          description: "Changed after review", version: "fixture-1", no_auth: false, is_deprecated: false,
          scopes: ["repo"], input_parameters: issueInputSchema, output_parameters: { type: "object" },
        }] }),
      }),
      request: async () => {
        executionDispatched = true;
        return { status: 200, ok: true, content_type: "application/json", body: "{}", truncated: false,
          request_id: "req_should_not_execute" };
      },
    })).rejects.toThrow(/action definition changed since owner review/);
    expect(executionDispatched).toBe(false);
  });

  it("passes cancellation to the Composio request and never returns a success after abort", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let called = false;
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
        input_schema_sha256: issueInputSchemaSha256, payload: { title: "fixture" } },
      {
        env: {
          COMPOSIO_API_KEY: "composio-test-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
          COMPOSIO_USER_ID: "owner-local",
          COMPOSIO_DRY_RUN: "false",
          COMPOSIO_LIVE_EXECUTION: "true",
        },
        signal: controller.signal,
        request: async (_target, signal) => {
          called = true;
          seenSignal = signal;
          controller.abort();
          throw new Error("request aborted; mutation_status=not_confirmed");
        },
        accountsRequest: async () => accountResponse(),
        searchRequest: async () => actionSchemaResponse("github", "GITHUB_CREATE_AN_ISSUE"),
      },
    )).rejects.toThrow(/mutation_status=not_confirmed/);
    expect(called).toBe(true);
    expect(seenSignal).toBe(controller.signal);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    let dispatchedAfterCancel = false;
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", connected_account_id: "conn_owner_github_1",
        input_schema_sha256: issueInputSchemaSha256, payload: { title: "fixture" } },
      {
        env: {
          COMPOSIO_API_KEY: "composio-test-value",
          COMPOSIO_ALLOWED_TOOLKITS: "github",
          COMPOSIO_ALLOWED_ACTIONS: "github:GITHUB_CREATE_AN_ISSUE",
          COMPOSIO_USER_ID: "owner-local",
          COMPOSIO_DRY_RUN: "false",
          COMPOSIO_LIVE_EXECUTION: "true",
        },
        signal: alreadyCancelled.signal,
        request: async () => {
          dispatchedAfterCancel = true;
          throw new Error("unexpected request");
        },
        accountsRequest: async () => accountResponse(),
      },
    )).rejects.toThrow(/cancelled before request dispatch/);
    expect(dispatchedAfterCancel).toBe(false);
  });

  it("registers Composio tools and their capability envelopes", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.get("composio.search")?.required_capabilities).toEqual([
      "tool:composio.search",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
    ]);
    expect(registry.get("composio.accounts")?.required_capabilities).toEqual([
      "tool:composio.accounts",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
    ]);
    expect(registry.get("composio.scopes")?.required_capabilities).toEqual([
      "tool:composio.scopes",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
    ]);
    expect(registry.get("composio.execute")?.required_capabilities).toContain(
      "external:send",
    );
  });
});
