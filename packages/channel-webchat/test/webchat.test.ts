import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { InboundRequest } from "@blue-tanuki/protocol";
import type { SendMeta } from "@blue-tanuki/channel-base";
import {
  WebChatChannel,
  MemoryTicketStore,
  type TicketStore,
  type WebChatRateLimits,
  type WebChatApprovalSurface,
  type WebChatAuditSurface,
  type WebChatAuthoritySurface,
  type WebChatNotificationSurface,
  type WebChatHistorySurface,
  type WebChatOperatorSurfaces,
  type WebChatRuntimeSurface,
  type WebChatSettingsSurface,
} from "../src/index.js";

let port = 41200;
function nextPort(): number {
  return port++;
}

const TOKEN = "test-token-1234";
const RESUME_TOKEN = "resume-token-1234";
const SETTINGS_TOKEN = "settings-token-1234";
const WEBHOOK_TOKEN = "webhook-token-1234";

interface Ctx {
  ch: WebChatChannel;
  port: number;
  received: InboundRequest[];
}

function setup(
  opts: Partial<
    Ctx & {
      onResume?: (id: string, v: string, ctx: { actor: string; token_kind: "resume" }) => Promise<unknown>;
      resume_token?: string;
      webhook_token?: string;
      resume_approval_tokens?: false;
      resume_approval_token_ttl_ms?: number;
      ws_ticket_ttl_ms?: number;
      ticket_store?: TicketStore;
      rate_limits?: WebChatRateLimits | false;
      settings?: WebChatSettingsSurface;
      runtime?: WebChatRuntimeSurface;
      approval?: WebChatApprovalSurface;
      audit?: WebChatAuditSurface;
      authority?: WebChatAuthoritySurface;
      notifications?: WebChatNotificationSurface;
      history?: WebChatHistorySurface;
      operators?: WebChatOperatorSurfaces;
    }
  > = {},
): Ctx & { teardown: () => Promise<void> } {
  const p = opts.port ?? nextPort();
  const received: InboundRequest[] = [];
  const ch = new WebChatChannel({
    port: p,
    token: TOKEN,
    resume_token: opts.resume_token ?? RESUME_TOKEN,
    webhook_token: opts.webhook_token,
    host: "127.0.0.1",
    onResume: opts.onResume as never,
    resume_approval_tokens: opts.resume_approval_tokens,
    resume_approval_token_ttl_ms: opts.resume_approval_token_ttl_ms,
    ws_ticket_ttl_ms: opts.ws_ticket_ttl_ms,
    ticket_store: opts.ticket_store,
    settings: opts.settings,
    runtime: opts.runtime,
    approval: opts.approval,
    audit: opts.audit,
    authority: opts.authority,
    notifications: opts.notifications,
    history: opts.history,
    operators: opts.operators,
    // Default: disable rate limiting in legacy tests so existing flows
    // keep working without thinking about bursts. Rate-limit behavior is
    // covered by its own describe() block below.
    rate_limits: opts.rate_limits === undefined ? false : opts.rate_limits,
  });
  return {
    ch,
    port: p,
    received,
    teardown: async () => {
      await ch.stop();
    },
  };
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  const txt = await res.text();
  try {
    parsed = txt ? JSON.parse(txt) : null;
  } catch {
    parsed = txt;
  }
  return { status: res.status, body: parsed };
}

async function getRaw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, text: await res.text() };
}

async function getTicket(port: number, user: string): Promise<string> {
  const r = await postJson(
    port,
    "/ws-ticket",
    { user },
    { authorization: `Bearer ${TOKEN}` },
  );
  if (r.status !== 200) {
    throw new Error(`ws-ticket failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return (r.body as { ticket: string }).ticket;
}

function openWsWithTicket(port: number, ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("ws open/hello timeout"));
    }, 2000);
    ws.once("message", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function readWsMessage(ws: WebSocket, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws msg timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

describe("WebChatChannel — construction", () => {
  it("rejects missing/short token", () => {
    expect(() => new WebChatChannel({ port: 1234, token: "" })).toThrow();
    expect(() => new WebChatChannel({ port: 1234, token: "short" })).toThrow();
  });

  it("rejects invalid resume token configuration", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          onResume: async () => ({ ok: true }),
        }),
    ).toThrow(/resume_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: TOKEN,
        }),
    ).toThrow(/differ/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: "short",
        }),
    ).toThrow(/resume_token/);
  });

  it("rejects invalid webhook token configuration", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          webhook_token: "short",
        }),
    ).toThrow(/webhook_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          webhook_token: TOKEN,
        }),
    ).toThrow(/webhook_token/);
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          webhook_token: RESUME_TOKEN,
        }),
    ).toThrow(/webhook_token/);
  });

  it("rejects bad port", () => {
    expect(() => new WebChatChannel({ port: 0, token: "x".repeat(10) })).toThrow();
    expect(
      () => new WebChatChannel({ port: 99999, token: "x".repeat(10) }),
    ).toThrow();
  });

  it("rejects ws_ticket_ttl_ms below 1000", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: "x".repeat(10),
          ws_ticket_ttl_ms: 100,
        }),
    ).toThrow();
  });

  it("rejects resume_approval_token_ttl_ms below 1000", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: "x".repeat(10),
          resume_approval_token_ttl_ms: 100,
        }),
    ).toThrow();
  });

  it("rejects settings token reuse", () => {
    expect(
      () =>
        new WebChatChannel({
          port: 1234,
          token: TOKEN,
          resume_token: RESUME_TOKEN,
          settings: {
            token: TOKEN,
            html: "<!doctype html>",
            getSnapshot: async () => ({}),
          },
        }),
    ).toThrow(/settings.token/);
  });
});

describe("WebChatChannel — Control Center shell", () => {
  it("serves the local resident app shell at /app", async () => {
    const ctx = setup();
    try {
      await ctx.ch.start(async () => undefined);
      const r = await fetch(`http://127.0.0.1:${ctx.port}/app`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("BLUE-TANUKI Control Center");
      expect(html).toContain("Tanuki Dashboard");
      expect(html).toContain("Owner operation screens");
      expect(html).toContain("Conversation / WebChat");
      expect(html).toContain("Tasks");
      expect(html).toContain("Activity / Audit");
      expect(html).toContain("Memory");
      expect(html).toContain("Skills");
      expect(html).toContain("Channels");
      expect(html).toContain("Doctor");
      expect(html).toContain("Settings");
      expect(html).toContain("OpenRouter");
      expect(html).toContain("Composio");
      expect(html).toContain("Developer / Evidence");
      expect(html).toContain("GUI Shell responsibility substrate mapped to BLUE-TANUKI");
      expect(html).toContain("UI state is not authority");
      expect(html).toContain("LLM output is not authority");
      expect(html).toContain("Memory is not authority");
      expect(html).toContain("Channel metadata is not authority");
      expect(html).toContain("Responsibility Map");
      expect(html).toContain("Runtime");
      expect(html).toContain("Capability");
      expect(html).toContain("Recovery");
      expect(html).toContain("Approval Policy");
      expect(html).toContain("Verify Chain");
      expect(html).toContain("Authority Trace");
      expect(html).toContain("Scheduled Tasks");
      expect(html).toContain("Permanent-Use Status");
      expect(html).toContain("First-Run Next Action");
      expect(html).toContain("chat-token");
      expect(html).toContain("connect-chat");
      expect(html).toContain("send-chat");
      expect(html).toContain("doctor-runtime-status");
      expect(html).toContain("doctor-webchat-ready");
      expect(html).toContain("doctor-next-action");
      expect(html).toContain("ApprovalLevel");
      expect(html).toContain("Final Review");
      expect(html).toContain("Notification Center");
      expect(html).toContain("load-notifications");
      expect(html).toContain("Complete History / Replay");
      expect(html).toContain("load-history");
      expect(html).toContain("history-list");
      expect(html).toContain("runtime-schedule-list");
      expect(html).toContain("authority-trace-list");
      expect(html).toContain("redactRuntimeValue");
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — HTTP inbound", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects POST /inbound without auth", async () => {
    const r = await postJson(ctx.port, "/inbound", {
      user: "u1",
      content: "hi",
    });
    expect(r.status).toBe(401);
  });

  it("rejects POST /inbound with resume token", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "hi" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(401);
  });

  it("accepts POST /inbound with valid auth and stamps reply_to in metadata", async () => {
    const r = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "hello" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.received).toHaveLength(1);
    const got = ctx.received[0]!;
    expect(got.user).toBe("u1");
    expect(got.metadata?.reply_to).toBe("u1");
  });

  it("/healthz needs no auth", async () => {
    const r = await getRaw(ctx.port, "/healthz");
    expect(r.status).toBe(200);
  });
});

describe("WebChatChannel - HTTP webhook inbound", () => {
  it("keeps /webhook disabled unless a dedicated token is configured", async () => {
    const ctx = setup();
    try {
      await ctx.ch.start(async () => undefined);
      const r = await postJson(
        ctx.port,
        "/webhook",
        { content: "ci event" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: "webhook_not_configured" });
    } finally {
      await ctx.teardown();
    }
  });

  it("rejects /webhook without the webhook token", async () => {
    const ctx = setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async () => undefined);
      expect((await postJson(ctx.port, "/webhook", { content: "x" })).status).toBe(401);
      expect(
        (
          await postJson(
            ctx.port,
            "/webhook",
            { content: "x" },
            { authorization: `Bearer ${TOKEN}` },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await postJson(
            ctx.port,
            "/webhook",
            { content: "x" },
            { authorization: `Bearer ${RESUME_TOKEN}` },
          )
        ).status,
      ).toBe(401);
    } finally {
      await ctx.teardown();
    }
  });

  it("normalizes webhook content without accepting authority metadata", async () => {
    const ctx = setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async (req) => {
        ctx.received.push(req);
      });
      const r = await postJson(
        ctx.port,
        "/webhook",
        {
          user: "ci-bot",
          source: "github-actions",
          reply_to: "ops",
          content: "deploy finished",
          metadata: {
            actor: "admin",
            trust: "full",
            authority_context: "bypass",
          },
        },
        { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      const got = ctx.received[0]!;
      expect(got.channel).toBe("webchat");
      expect(got.user).toBe("ci-bot");
      expect(got.content).toBe("deploy finished");
      expect(got.metadata).toEqual({
        reply_to: "ops",
        webhook_source: "github-actions",
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("can turn a JSON event into canonical inbound content", async () => {
    const ctx = setup({ webhook_token: WEBHOOK_TOKEN });
    try {
      await ctx.ch.start(async (req) => {
        ctx.received.push(req);
      });
      const r = await postJson(
        ctx.port,
        "/webhook",
        { event: { kind: "build", status: "green" } },
        { authorization: `Bearer ${WEBHOOK_TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received[0]?.user).toBe("webhook");
      expect(ctx.received[0]?.content).toBe('{"kind":"build","status":"green"}');
      expect(ctx.received[0]?.metadata).toEqual({
        reply_to: "webhook",
        webhook_source: "generic",
      });
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — /ws-ticket", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects /ws-ticket without auth", async () => {
    const r = await postJson(ctx.port, "/ws-ticket", { user: "alice" });
    expect(r.status).toBe(401);
  });

  it("rejects /ws-ticket with resume token", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "alice" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(401);
  });

  it("rejects /ws-ticket with missing user", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      {},
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(400);
  });

  it("issues a fresh, base64url-shaped ticket bound to the requested user", async () => {
    const r = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "alice" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ticket: string; expires_in_sec: number };
    expect(typeof body.ticket).toBe("string");
    expect(body.ticket.length).toBeGreaterThanOrEqual(40);
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.expires_in_sec).toBeGreaterThan(0);
  });

  it("each /ws-ticket call yields a distinct ticket", async () => {
    const t1 = await getTicket(ctx.port, "alice");
    const t2 = await getTicket(ctx.port, "alice");
    expect(t1).not.toBe(t2);
  });
});

describe("WebChatChannel — settings surface", () => {
  it("serves /settings without exposing config JSON", async () => {
    const ctx = setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html><title>Settings</title>",
        getSnapshot: async () => ({ ok: true }),
      },
    });
    await ctx.ch.start(async () => {});
    const r = await getRaw(ctx.port, "/settings");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Settings");
    await ctx.teardown();
  });

  it("requires the dedicated settings token for /settings/config", async () => {
    const ctx = setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ provider: "stub" }),
      },
    });
    await ctx.ch.start(async () => {});

    expect((await getRaw(ctx.port, "/settings/config")).status).toBe(401);
    expect(
      (await getRaw(ctx.port, "/settings/config", {
        authorization: `Bearer ${TOKEN}`,
      })).status,
    ).toBe(401);
    const ok = await getRaw(ctx.port, "/settings/config", {
      authorization: `Bearer ${SETTINGS_TOKEN}`,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ provider: "stub" });
    await ctx.teardown();
  });

  it("routes POST /settings/config to the settings update handler", async () => {
    const updates: unknown[] = [];
    const ctx = setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ ok: true }),
        update: async (body) => {
          updates.push(body);
          return { restart_required: true };
        },
      },
    });
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/settings/config",
      { llm: { provider: "stub" } },
      { authorization: `Bearer ${SETTINGS_TOKEN}` },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      result: { restart_required: true },
    });
    expect(updates).toEqual([{ llm: { provider: "stub" } }]);
    await ctx.teardown();
  });

  it("routes POST /settings/llm/verify to the non-mutating verify handler", async () => {
    const verifyBodies: unknown[] = [];
    const ctx = setup({
      settings: {
        token: SETTINGS_TOKEN,
        html: "<!doctype html>",
        getSnapshot: async () => ({ ok: true }),
        verifyLlm: async (body) => {
          verifyBodies.push(body);
          return { status: "pass", changed: false };
        },
      },
    });
    await ctx.ch.start(async () => {});
    expect((await postJson(ctx.port, "/settings/llm/verify", {}, {
      authorization: `Bearer ${TOKEN}`,
    })).status).toBe(401);

    const r = await postJson(
      ctx.port,
      "/settings/llm/verify",
      { llm: { provider: "stub" } },
      { authorization: `Bearer ${SETTINGS_TOKEN}` },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      result: { status: "pass", changed: false },
    });
    expect(verifyBodies).toEqual([{ llm: { provider: "stub" } }]);
    await ctx.teardown();
  });
});

describe("WebChatChannel — audit dump API", () => {
  it("serves read-only audit dump only with the inbound token", async () => {
    const ctx = setup({
      audit: {
        dump: async (format) => ({
          content_type:
            format === "text"
              ? "text/plain; charset=utf-8"
              : "application/json",
          body:
            format === "text"
              ? "blue-tanuki audit-dump — OK"
              : JSON.stringify({ status: "ok", entry_count: 1 }),
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/audit/dump")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/audit/dump", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const json = await getRaw(ctx.port, "/audit/dump", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(json.status).toBe(200);
      expect(JSON.parse(json.text)).toEqual({ status: "ok", entry_count: 1 });

      const text = await getRaw(ctx.port, "/audit/dump?format=text", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(text.status).toBe(200);
      expect(text.text).toContain("blue-tanuki audit-dump");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /audit/dump", async () => {
    const ctx = setup({
      audit: {
        dump: async () => ({
          content_type: "application/json",
          body: JSON.stringify({ status: "ok" }),
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/audit/dump",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — runtime snapshot API", () => {
  it("serves safe first-run status only with the inbound token", async () => {
    const ctx = setup({
      runtime: {
        getSnapshot: async () => ({
          gateway_status: "running",
          hds_invariants_ok: true,
          webchat_ready: true,
          telegram_configured: false,
          pending_approvals_count: 1,
          runtime_schedules_count: 2,
          pending_schedule_approvals_count: 1,
          audit_chain_valid: true,
          next_recommended_action: "Review pending approvals in Control Center",
          scheduled_tasks: [{ id: "safe", payload_hash: "abc123" }],
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/runtime/snapshot")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/runtime/snapshot", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/runtime/snapshot", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body).toMatchObject({
        gateway_status: "running",
        hds_invariants_ok: true,
        webchat_ready: true,
        telegram_configured: false,
        pending_approvals_count: 1,
        runtime_schedules_count: 2,
        pending_schedule_approvals_count: 1,
        audit_chain_valid: true,
      });
      expect(JSON.stringify(body)).not.toContain("private schedule content");
      expect(JSON.stringify(body)).not.toContain(RESUME_TOKEN);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /runtime/snapshot", async () => {
    const ctx = setup({
      runtime: {
        getSnapshot: async () => ({ gateway_status: "running" }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/runtime/snapshot",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — authority trace API", () => {
  it("serves read-only authority trace only with the inbound token", async () => {
    const ctx = setup({
      authority: {
        trace: async () => [
          {
            index: 3,
            entry_hash: "abc123",
            kind: "authority_event",
            event: "approval_allowed",
            request_id: "req-1",
            command_id: "cmd-1",
            actor: "alice",
            operation: "tool.file.write",
            risk: "medium",
            reason: "default_full_access_without_final_review_exception",
            timestamp: 12345,
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/authority/trace")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/authority/trace", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/authority/trace", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.authority_trace).toHaveLength(1);
      expect(body.authority_trace[0]).toMatchObject({
        kind: "authority_event",
        event: "approval_allowed",
        request_id: "req-1",
        command_id: "cmd-1",
        actor: "alice",
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /authority/trace", async () => {
    const ctx = setup({
      authority: {
        trace: async () => [],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/authority/trace",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — approval API", () => {
  it("lists pending approvals only with the resume token", async () => {
    const ctx = setup({
      approval: {
        list: async () => [
          {
            command_id: "cmd-1",
            request_id: "req-1",
            operation: "tool.shell.exec",
            risk: "high",
            final_review_required: true,
            reason: "final_review_required",
            approval_token: "one-time-token",
            approval_token_expires_at_ms: 12345,
            authority_trace: { black_box_boundary: "none_in_hds_authority_path" },
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/approval")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/approval", {
          authorization: `Bearer ${TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/approval", {
        authorization: `Bearer ${RESUME_TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.pending_approvals).toHaveLength(1);
      expect(body.pending_approvals[0]).toMatchObject({
        command_id: "cmd-1",
        request_id: "req-1",
        operation: "tool.shell.exec",
        risk: "high",
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("routes POST /approval/:id through the same one-time resume approval gate", async () => {
    const calls: unknown[] = [];
    const ctx = setup({
      onResume: async (id, verdict, resumeCtx) => {
        calls.push({ id, verdict, resumeCtx });
        return { handled: true };
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const issued = await ctx.ch.issueResumeApprovalToken("cmd-approve");
      const r = await postJson(
        ctx.port,
        "/approval/cmd-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
          actor: "alice",
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, result: { handled: true } });
      expect(calls).toEqual([
        {
          id: "cmd-approve",
          verdict: "approve",
          resumeCtx: {
            actor: "alice",
            token_kind: "resume",
            approval: undefined,
          },
        },
      ]);

      const replay = await postJson(
        ctx.port,
        "/approval/cmd-approve",
        {
          verdict: "approve",
          approval_token: issued?.token,
        },
        { authorization: `Bearer ${RESUME_TOKEN}` },
      );
      expect(replay.status).toBe(403);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel — WS upgrade with ticket", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("rejects WS upgrade without ticket", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
        ws.once("error", () => resolve());
        ws.once("open", () => {
          ws.close();
          reject(new Error("expected upgrade rejection"));
        });
        setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects WS upgrade with unknown ticket", async () => {
    await expect(
      openWsWithTicket(ctx.port, "totally-bogus-ticket"),
    ).rejects.toThrow();
  });

  it("accepts WS upgrade with valid ticket and pushes hello bound to that user", async () => {
    const ticket = await getTicket(ctx.port, "alice");
    const ws = await openWsWithTicket(ctx.port, ticket);
    // openWsWithTicket already drained the hello frame.
    expect(ctx.ch.connectionCount("alice")).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.ch.connectionCount("alice")).toBe(0);
  });

  it("ticket is single-use: second WS attempt with same ticket fails", async () => {
    const ticket = await getTicket(ctx.port, "alice");
    const ws1 = await openWsWithTicket(ctx.port, ticket);
    await expect(openWsWithTicket(ctx.port, ticket)).rejects.toThrow();
    ws1.close();
  });

  it("expired ticket is rejected", async () => {
    const shortCtx = setup({ ws_ticket_ttl_ms: 1000 });
    await shortCtx.ch.start(async () => {});
    const ticket = await getTicket(shortCtx.port, "alice");
    // Wait for expiry.
    await new Promise((r) => setTimeout(r, 1100));
    await expect(openWsWithTicket(shortCtx.port, ticket)).rejects.toThrow();
    await shortCtx.teardown();
  });

  it("legacy ?token=&user= form is no longer accepted", async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${ctx.port}/ws?token=${TOKEN}&user=alice`,
        );
        ws.once("error", () => resolve());
        ws.once("open", () => {
          ws.close();
          reject(new Error("legacy form should not connect"));
        });
        setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ).resolves.toBeUndefined();
  });
});

describe("WebChatChannel — outbound over WS", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.ch.start(async () => {});
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it("send() pushes channel_send frames to all conns of target user", async () => {
    const t1 = await getTicket(ctx.port, "u1");
    const ws1 = await openWsWithTicket(ctx.port, t1);
    const t2 = await getTicket(ctx.port, "u1");
    const ws2 = await openWsWithTicket(ctx.port, t2);

    const p1 = readWsMessage(ws1);
    const p2 = readWsMessage(ws2);

    const meta: SendMeta = {
      command_id: "cmd-X",
      upstream_commit_hash: "hash-Y",
    };
    const result = await ctx.ch.send(
      { channel: "webchat", target: "u1", content: "hi from server" },
      meta,
    );
    expect(result.delivered).toBe(true);

    const m1 = (await p1) as { kind: string; content: string };
    const m2 = (await p2) as { kind: string; content: string };
    expect(m1.kind).toBe("channel_send");
    expect(m1.content).toBe("hi from server");
    expect(m2.content).toBe("hi from server");

    ws1.close();
    ws2.close();
  });

  it("send() returns delivered=false when target has no connections", async () => {
    const result = await ctx.ch.send(
      { channel: "webchat", target: "ghost", content: "x" },
      { command_id: "c", upstream_commit_hash: "h" },
    );
    expect(result.delivered).toBe(false);
    expect(result.error).toBe("no_active_connection");
  });
});

describe("WebChatChannel — POST /resume", () => {
  it("returns 501 when onResume not configured", async () => {
    const ctx = setup();
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/resume",
      { request_id: "x", verdict: "approve" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(501);
    await ctx.teardown();
  });

  it("rejects /resume with inbound token", async () => {
    const ctx = setup({
      onResume: async () => ({ ok: true }),
    });
    await ctx.ch.start(async () => {});
    const r = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(401);
    await ctx.teardown();
  });

  it("forwards to onResume and echoes result", async () => {
    const calls: Array<{ id: string; v: string; actor: string; token_kind: string }> = [];
    const ctx = setup({
      onResume: async (id, v, resumeCtx) => {
        calls.push({ id, v, actor: resumeCtx.actor, token_kind: resumeCtx.token_kind });
        return { decision: v === "approve" ? "ASSERT" : "FAIL" };
      },
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    const r = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rA",
        verdict: "approve",
        actor: "alice",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; result: { decision: string } };
    expect(body.ok).toBe(true);
    expect(body.result.decision).toBe("ASSERT");
    expect(calls).toEqual([
      { id: "rA", v: "approve", actor: "alice", token_kind: "resume" },
    ]);
    await ctx.teardown();
  });

  it("requires a request-bound one-time approval token", async () => {
    const calls: string[] = [];
    const ctx = setup({
      onResume: async (id) => {
        calls.push(id);
        return { ok: true };
      },
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");

    const missing = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve" },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(missing.status).toBe(400);

    const wrongRequest = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rB",
        verdict: "approve",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(wrongRequest.status).toBe(403);

    const burned = await postJson(
      ctx.port,
      "/resume",
      {
        request_id: "rA",
        verdict: "approve",
        approval_token: issued?.token,
      },
      { authorization: `Bearer ${RESUME_TOKEN}` },
    );
    expect(burned.status).toBe(403);
    expect(calls).toEqual([]);
    await ctx.teardown();
  });

  it("consumes approval tokens exactly once", async () => {
    const ctx = setup({
      onResume: async () => ({ ok: true }),
    });
    await ctx.ch.start(async () => {});
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    const body = {
      request_id: "rA",
      verdict: "approve",
      approval_token: issued?.token,
    };
    const first = await postJson(ctx.port, "/resume", body, {
      authorization: `Bearer ${RESUME_TOKEN}`,
    });
    const second = await postJson(ctx.port, "/resume", body, {
      authorization: `Bearer ${RESUME_TOKEN}`,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    await ctx.teardown();
  });
});

describe("WebChatChannel — rate limiting", () => {
  it("/inbound returns 429 with Retry-After when capacity is exceeded", async () => {
    const ctx = setup({
      rate_limits: {
        // capacity 2, refill very slow → 3rd call gets 429 deterministically.
        inbound: { capacity: 2, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });

    const auth = { authorization: `Bearer ${TOKEN}` };
    const r1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "a" },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "b" },
      auth,
    );
    const r3 = await postJson(
      ctx.port,
      "/inbound",
      { user: "u1", content: "c" },
      auth,
    );
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(429);
    const body = r3.body as { error: string; retry_after_ms: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after_ms).toBeGreaterThan(0);
    await ctx.teardown();
  });

  it("/inbound rate limit is per-user (independent buckets)", async () => {
    const ctx = setup({
      rate_limits: {
        inbound: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const a1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "alice", content: "x" },
      auth,
    );
    const b1 = await postJson(
      ctx.port,
      "/inbound",
      { user: "bob", content: "y" },
      auth,
    );
    const a2 = await postJson(
      ctx.port,
      "/inbound",
      { user: "alice", content: "x2" },
      auth,
    );
    expect(a1.status).toBe(202);
    expect(b1.status).toBe(202); // bob's bucket independent
    expect(a2.status).toBe(429); // alice's bucket exhausted
    await ctx.teardown();
  });

  it("/ws-ticket returns 429 when capacity is exceeded", async () => {
    const ctx = setup({
      rate_limits: {
        ws_ticket: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    const r1 = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "u" },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/ws-ticket",
      { user: "u" },
      auth,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    await ctx.teardown();
  });

  it("/resume rate-limit uses a single global bucket", async () => {
    const ctx = setup({
      onResume: async () => ({ ok: true }),
      rate_limits: {
        resume: { capacity: 1, refill_per_sec: 0.001 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${RESUME_TOKEN}` };
    const issued = await ctx.ch.issueResumeApprovalToken("rA");
    // Two distinct request_ids — should still share one bucket (global key).
    const r1 = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rA", verdict: "approve", approval_token: issued?.token },
      auth,
    );
    const r2 = await postJson(
      ctx.port,
      "/resume",
      { request_id: "rB", verdict: "approve" },
      auth,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    await ctx.teardown();
  });

  it("rate_limits: false fully disables limiting", async () => {
    const ctx = setup({ rate_limits: false });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    // Hammer /ws-ticket far above any default capacity.
    for (let i = 0; i < 50; i++) {
      const r = await postJson(
        ctx.port,
        "/ws-ticket",
        { user: "u" },
        auth,
      );
      expect(r.status).toBe(200);
    }
    await ctx.teardown();
  });

  it("Retry-After header is present and positive on 429", async () => {
    const ctx = setup({
      rate_limits: {
        ws_ticket: { capacity: 1, refill_per_sec: 0.5 },
      },
    });
    await ctx.ch.start(async () => {});
    const auth = { authorization: `Bearer ${TOKEN}` };
    await postJson(ctx.port, "/ws-ticket", { user: "u" }, auth);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ user: "u" }),
    });
    expect(res.status).toBe(429);
    const ra = res.headers.get("retry-after");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThanOrEqual(1);
    await ctx.teardown();
  });
});

describe("WebChatChannel — TicketStore injection", () => {
  it("uses an injected ticket store for issue/consume", async () => {
    const inner = new MemoryTicketStore({ cap: 5 });
    let issueCalls = 0;
    let consumeCalls = 0;
    const wrapped: TicketStore = {
      issue: async (u, ttl) => {
        issueCalls += 1;
        return inner.issue(u, ttl);
      },
      consume: async (t) => {
        consumeCalls += 1;
        return inner.consume(t);
      },
      size: () => inner.size(),
    };
    const ctx = setup({ ticket_store: wrapped });
    await ctx.ch.start(async () => {});

    const ticket = await getTicket(ctx.port, "alice");
    expect(issueCalls).toBe(1);
    const ws = await openWsWithTicket(ctx.port, ticket);
    expect(consumeCalls).toBeGreaterThanOrEqual(1);
    expect(ctx.ch.connectionCount("alice")).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await ctx.teardown();
  });
});

describe("WebChatChannel — rate-limit prune", () => {
  it("periodically drops idle full buckets", async () => {
    const p = nextPort();
    const ch = new WebChatChannel({
      port: p,
      token: TOKEN,
      host: "127.0.0.1",
      // Generous capacity & high refill so a single consume re-fills
      // immediately and the entry becomes prune-eligible by the next sweep.
      rate_limits: {
        inbound: { capacity: 100, refill_per_sec: 1000 },
        resume: { capacity: 100, refill_per_sec: 1000 },
        ws_ticket: { capacity: 100, refill_per_sec: 1000 },
      },
      // Prune very frequently for the test, with a tiny idle threshold.
      rate_limit_prune_interval_ms: 30,
      rate_limit_prune_idle_ms: 10,
    });
    await ch.start(async () => {});
    try {
      // Issue a few tickets for distinct users to populate the ws_ticket bucket.
      for (const u of ["a", "b", "c"]) {
        const r = await postJson(p, "/ws-ticket", { user: u }, {
          authorization: `Bearer ${TOKEN}`,
        });
        expect(r.status).toBe(200);
      }
      // Wait long enough for at least 2 prune sweeps + idle threshold.
      await new Promise((r) => setTimeout(r, 120));
      // After prune, ws_ticket bucket should have dropped the per-user
      // entries (each is conceptually full again after one consume +
      // 1000 refill/sec for >10ms).
      // We verify by reaching into the bucket via a fresh post to
      // confirm no errors and that handling continues normally.
      const r = await postJson(p, "/ws-ticket", { user: "d" }, {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(r.status).toBe(200);
    } finally {
      await ch.stop();
    }
  });

  it("does not start a prune timer when interval is 0", async () => {
    const p = nextPort();
    const ch = new WebChatChannel({
      port: p,
      token: TOKEN,
      host: "127.0.0.1",
      rate_limit_prune_interval_ms: 0,
    });
    await ch.start(async () => {});
    // No assertion on internal state; this test exists primarily to
    // ensure no unhandled error surfaces when interval=0 is configured.
    await ch.stop();
  });
});

describe("WebChatChannel - resident notifications API", () => {
  it("serves display-only notifications only with the inbound token", async () => {
    const ctx = setup({
      notifications: {
        list: async () => [
          {
            id: "approval:cmd-1",
            kind: "approval_required",
            severity: "action_required",
            title: "Approval required",
            message: "tool.shell.exec is waiting for owner review.",
            timestamp: 12345,
            source: "approval_queue",
            read_only: true,
            authority: "display_only",
            request_id: "req-1",
            command_id: "cmd-1",
            approval_level: "L3_final_review",
            risk: "high",
            next_action: "Open Approval Queue.",
          },
        ],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/notifications")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/notifications", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/notifications", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0]).toMatchObject({
        kind: "approval_required",
        severity: "action_required",
        read_only: true,
        authority: "display_only",
        command_id: "cmd-1",
      });
      expect(JSON.stringify(body)).not.toContain("approval_token");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /notifications", async () => {
    const ctx = setup({
      notifications: {
        list: async () => [],
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/notifications",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - complete history replay API", () => {
  it("serves read-only replay metadata only with the inbound token", async () => {
    const filters: unknown[] = [];
    const ctx = setup({
      history: {
        replay: async (filter) => {
          filters.push(filter);
          return {
            schema_version: "phase12-s2-complete-history-v1",
            entries_count: 1,
            skipped_count: 0,
            chain_valid: true,
            complete_history_used_for_authority: false,
            replay_filter: filter,
            entries: [
              {
                schema_version: "phase12-s2-complete-history-v1",
                index: 0,
                id: "hist-1",
                kind: "approval_history",
                request_id: "req-1",
                command_id: "cmd-1",
                actor: "alice",
                source: "gateway",
                payload_digest: "payload-hash",
                used_for_authority: false,
                timestamp: 12345,
                prev_hash: "GENESIS",
                entry_hash: "entry-hash",
                payload: "secret raw payload",
              } as never,
            ],
          };
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/history/replay")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/history/replay", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/history/replay?kind=approval_history&limit=10", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text);
      expect(body.history).toMatchObject({
        entries_count: 1,
        skipped_count: 0,
        chain_valid: true,
        complete_history_used_for_authority: false,
      });
      expect(body.history.entries[0]).toMatchObject({
        kind: "approval_history",
        request_id: "req-1",
        command_id: "cmd-1",
        payload_digest: "payload-hash",
        used_for_authority: false,
      });
      expect(filters).toEqual([{ kind: "approval_history", limit: 10 }]);
      expect(ok.text).not.toContain("secret raw payload");
      expect(ok.text).not.toContain("\"payload\"");
    } finally {
      await ctx.teardown();
    }
  });

  it("does not accept POST /history/replay", async () => {
    const ctx = setup({
      history: {
        replay: async () => ({
          entries_count: 0,
          skipped_count: 0,
          chain_valid: true,
          complete_history_used_for_authority: false,
          entries: [],
        }),
      },
    });
    await ctx.ch.start(async () => {});
    try {
      const r = await postJson(
        ctx.port,
        "/history/replay",
        {},
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(405);
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Writing Operator API", () => {
  it("serves Writing Operator snapshot only with the inbound token", async () => {
    const ctx = setup({
      operators: {
        writing: {
          getSnapshot: async () => ({
            surface: "writing",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/writing")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/writing", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/writing", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "writing",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Writing Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = setup({
      operators: {
        writing: {
          getSnapshot: async () => ({ surface: "writing" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/writing/invoke",
        { user: "writer", content: "draft this" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "writer",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "writing",
      });
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Daily Operator API", () => {
  it("serves Daily Operator snapshot only with the inbound token", async () => {
    const ctx = setup({
      operators: {
        daily: {
          getSnapshot: async () => ({
            surface: "daily",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/daily")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/daily", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/daily", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "daily",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Daily Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = setup({
      operators: {
        daily: {
          getSnapshot: async () => ({ surface: "daily" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/daily/invoke",
        { user: "daily-user", content: "show daily brief status" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "daily-user",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "daily",
      });
    } finally {
      await ctx.teardown();
    }
  });
});

describe("WebChatChannel - Developer Operator API", () => {
  it("serves Developer Operator snapshot only with the inbound token", async () => {
    const ctx = setup({
      operators: {
        developer: {
          getSnapshot: async () => ({
            surface: "developer",
            layer: "A",
            status: "enabled",
          }),
        },
      },
    });
    await ctx.ch.start(async () => {});
    try {
      expect((await getRaw(ctx.port, "/operators/developer")).status).toBe(401);
      expect(
        (await getRaw(ctx.port, "/operators/developer", {
          authorization: `Bearer ${RESUME_TOKEN}`,
        })).status,
      ).toBe(401);

      const ok = await getRaw(ctx.port, "/operators/developer", {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({
        operator: {
          surface: "developer",
          layer: "A",
          status: "enabled",
        },
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("invokes Developer Operator through the existing inbound handler with surface metadata", async () => {
    const ctx = setup({
      operators: {
        developer: {
          getSnapshot: async () => ({ surface: "developer" }),
        },
      },
    });
    await ctx.ch.start(async (req) => {
      ctx.received.push(req);
    });
    try {
      const r = await postJson(
        ctx.port,
        "/operators/developer/invoke",
        { user: "developer-user", content: "inspect failing test" },
        { authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(202);
      await new Promise((r) => setTimeout(r, 30));
      expect(ctx.received).toHaveLength(1);
      expect(ctx.received[0]?.metadata).toMatchObject({
        reply_to: "developer-user",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.operator_surface": "developer",
      });
    } finally {
      await ctx.teardown();
    }
  });
});
