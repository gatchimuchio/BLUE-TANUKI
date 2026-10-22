import { describe, expect, it } from "vitest";
import {
  composioStatus,
  invokeComposioExecute,
  invokeComposioSearch,
  registerBuiltinTools,
  ToolRegistry,
  type ComposioExecuteTarget,
  type ComposioSearchTarget,
} from "../src/tools/index.js";

describe("Composio connector", () => {
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
    expect(JSON.stringify(result)).not.toContain("composio-secret-value");
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
    const result = await invokeComposioExecute(
      {
        toolkit: "github",
        tool: "GITHUB_CREATE_AN_ISSUE",
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
      },
    );

    expect(seen).toMatchObject({
      api_base_url: "https://backend.composio.dev",
      path: "/api/v3.1/tools/execute/GITHUB_CREATE_AN_ISSUE",
      method: "POST",
      user_id: "owner-local",
      body: {
        user_id: "owner-local",
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

  it("passes cancellation to the Composio request and never returns a success after abort", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let called = false;
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", payload: { title: "fixture" } },
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
      },
    )).rejects.toThrow(/mutation_status=not_confirmed/);
    expect(called).toBe(true);
    expect(seenSignal).toBe(controller.signal);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    let dispatchedAfterCancel = false;
    await expect(invokeComposioExecute(
      { toolkit: "github", tool: "GITHUB_CREATE_AN_ISSUE", payload: { title: "fixture" } },
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
    expect(registry.get("composio.execute")?.required_capabilities).toContain(
      "external:send",
    );
  });
});
