import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  TeamsChannel,
  teamsChannelReplyTarget,
  teamsChannelTarget,
  type TeamsInboundHandler,
  type TeamsInboundGrant,
  type TeamsInboundMessage,
  type TeamsEventInbox,
  type TeamsPostResult,
  type TeamsTransport,
} from "../src/index.js";
import type { TurnContext } from "@microsoft/agents-hosting";
import {
  TeamsAgentsTransport,
  createTeamsAuthConfiguration,
  teamsMessageFromActivity,
} from "../src/agents_transport.js";

const TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const BOT_ID = "11111111-2222-4333-8444-555555555555";
const credentials = {
  client_id: BOT_ID,
  client_secret: "synthetic-agent-secret",
  tenant_id: TENANT_ID,
};

const inboundMessage: TeamsInboundMessage = {
  tenant_id: TENANT_ID,
  conversation_id: "19:conversation@thread.v2",
  conversation_type: "channel",
  team_id: "19:team@thread.tacv2",
  channel_id: "19:channel@thread.tacv2",
  user_id: "29:stable-user-id",
  text: "hello teams",
  message_id: "message-1",
  reply_to_message_id: "message-1",
};

const inboundGrant: TeamsInboundGrant = {
  tenant_id: TENANT_ID,
  conversation_id: inboundMessage.conversation_id,
  conversation_type: "channel",
  team_id: inboundMessage.team_id!,
  channel_id: inboundMessage.channel_id!,
  user_id: inboundMessage.user_id,
};

class MemoryTeamsInbox implements TeamsEventInbox {
  readonly rows = new Map<string, { digest: string; state: "dispatching" | "handler_returned" | "outcome_unknown" }>();
  claim(eventId: string, payloadDigest: string) {
    expect(eventId).toMatch(/^[a-f0-9]{64}$/u);
    expect(payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
    const current = this.rows.get(eventId);
    if (current) return current.digest === payloadDigest
      ? { status: "duplicate" as const, delivery_state: current.state }
      : { status: "identity_conflict" as const };
    this.rows.set(eventId, { digest: payloadDigest, state: "dispatching" });
    return { status: "accepted" as const };
  }
  settle(eventId: string, payloadDigest: string, state: "handler_returned" | "outcome_unknown"): void {
    const current = this.rows.get(eventId);
    if (!current || current.digest !== payloadDigest || current.state !== "dispatching") {
      throw new Error("fixture_settlement_conflict");
    }
    current.state = state;
  }
}

class FakeTeamsTransport implements TeamsTransport {
  handler: TeamsInboundHandler | null = null;
  posted: Array<{ target: string; text: string }> = [];
  nextPostFails: string | null = null;

  async start(handler: TeamsInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: { target: string; text: string }): Promise<TeamsPostResult> {
    if (this.nextPostFails) {
      const error = this.nextPostFails;
      this.nextPostFails = null;
      return { ok: false, error };
    }
    this.posted.push({ ...args });
    return { ok: true, message_id: `teams-msg-${this.posted.length}` };
  }

  async emit(message: TeamsInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("transport not started");
    await this.handler(message);
  }
}

describe("TeamsChannel", () => {
  it("starts silently and fails closed when no token or transport is configured", async () => {
    const channel = new TeamsChannel({ log: () => undefined });
    await channel.start(async () => undefined);
    try {
      expect(channel.isSilent()).toBe(true);
      const result = await channel.send(
        { channel: "teams", target: teamsChannelTarget("team", "channel"), content: "x" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "teams_not_configured",
      });
    } finally {
      await channel.stop();
    }
  });

  it("admits only an exact owner grant, deduplicates durably, and uses a stable actor instead of display text", async () => {
    const transport = new FakeTeamsTransport();
    const inbox = new MemoryTeamsInbox();
    const channel = new TeamsChannel({ transport, inbox, inbound_grants: [inboundGrant], log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit(inboundMessage);
      await transport.emit(inboundMessage);
      await transport.emit({ ...inboundMessage, text: "changed payload with same message identity" });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "teams",
        user: expect.stringMatching(/^teams:[a-f0-9]{64}$/u),
        content: "hello teams",
      });
      expect(received[0]!.metadata?.reply_to).toBe(
        teamsChannelReplyTarget(inboundMessage.team_id!, inboundMessage.channel_id!, inboundMessage.message_id),
      );
      expect(received[0]!.metadata?.teams_user_id).toBe(inboundMessage.user_id);
      expect(received[0]!.user).not.toBe("alice");
      expect(received[0]!.metadata).not.toHaveProperty("blue_tanuki.authority_context");
      expect([...inbox.rows.values()][0]?.state).toBe("handler_returned");
    } finally {
      await channel.stop();
    }
  });

  it("rejects injected events without a grant before touching the replay inbox", async () => {
    const transport = new FakeTeamsTransport();
    const inbox = new MemoryTeamsInbox();
    const channel = new TeamsChannel({ transport, inbox, inbound_grants: [], log: () => undefined });
    let calls = 0;
    await channel.start(async () => { calls += 1; });
    try {
      await transport.emit(inboundMessage);
      expect(calls).toBe(0);
      expect(inbox.rows.size).toBe(0);
    } finally {
      await channel.stop();
    }
  });

  it("maps only authenticated Teams message identity fields and rejects ambiguous context", () => {
    const activity = {
      type: "message",
      channelId: "msteams",
      id: "activity-1",
      text: "hello",
      from: { id: "29:stable-user-id", name: "mutable display", role: "user", tenantId: TENANT_ID },
      recipient: { id: BOT_ID, role: "bot" },
      conversation: { id: "19:conversation@thread.v2", conversationType: "channel", tenantId: TENANT_ID },
      channelData: {
        tenant: { id: TENANT_ID },
        team: { id: "19:team@thread.tacv2" },
        channel: { id: "19:channel@thread.tacv2" },
      },
    } as unknown as TurnContext["activity"];
    expect(teamsMessageFromActivity(activity)).toEqual({
      tenant_id: TENANT_ID,
      conversation_id: "19:conversation@thread.v2",
      conversation_type: "channel",
      user_id: "29:stable-user-id",
      team_id: "19:team@thread.tacv2",
      channel_id: "19:channel@thread.tacv2",
      text: "hello",
      message_id: "activity-1",
      reply_to_message_id: "activity-1",
    });
    expect(teamsMessageFromActivity({ ...activity, conversation: { ...activity.conversation!, tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } })).toBeNull();
    expect(teamsMessageFromActivity({ ...activity, from: { ...activity.from!, role: "bot" } })).toBeNull();
    expect(teamsMessageFromActivity({ ...activity, channelData: { tenant: { id: TENANT_ID } }, conversation: { ...activity.conversation!, conversationType: "channel" } })).toBeNull();
    expect(teamsMessageFromActivity({ ...activity, attachments: [{ contentType: "text/plain" } as never] })).toBeNull();
  });

  it("pins SDK JWT validation to the configured audience and rejects unauthenticated HTTP ingress", async () => {
    const auth = createTeamsAuthConfiguration(credentials);
    expect(auth.connectionsMap).toEqual([{
      serviceUrl: "*",
      audience: BOT_ID,
      connection: "blueTanukiTeamsService",
    }]);
    expect(auth.connections?.get("blueTanukiTeamsService")).toMatchObject({
      clientId: BOT_ID,
      tenantId: TENANT_ID,
      validateIssuer: true,
    });

    expect(() => new TeamsAgentsTransport({ credentials, host: "0.0.0.0" })).toThrow(
      "teams_agent_listener_host_must_be_loopback",
    );

    const transport = new TeamsAgentsTransport({ credentials, host: "127.0.0.1", port: 0, log: () => undefined });
    let accepted = 0;
    await transport.start(async () => { accepted += 1; });
    try {
      const port = transport.getListeningPort();
      expect(port).toBeGreaterThan(0);
      const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message", channelId: "msteams" }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(accepted).toBe(0);
    } finally {
      await transport.stop();
    }
  });

  it("sends through transport and classifies permanent failures", async () => {
    const transport = new FakeTeamsTransport();
    const channel = new TeamsChannel({ transport, log: () => undefined });
    await channel.start(async () => undefined);
    try {
      const target = teamsChannelTarget("team-1", "channel-1");
      const sent = await channel.send(
        { channel: "teams", target, content: "reply" },
        { command_id: "cmd-1", upstream_commit_hash: "hash" },
      );
      expect(sent).toMatchObject({ delivered: true, external_id: "teams-msg-1" });
      expect(transport.posted).toEqual([{ target, text: "reply" }]);

      transport.nextPostFails = "graph_403_forbidden";
      const failed = await channel.send(
        { channel: "teams", target, content: "reply" },
        { command_id: "cmd-2", upstream_commit_hash: "hash" },
      );
      expect(failed.delivered).toBe(false);
      expect(failed.error_kind).toBe("non_recoverable");
      expect(failed.next_action).toContain("Graph");
    } finally {
      await channel.stop();
    }
  });

  it("Graph transport uses fixed Microsoft Graph message endpoint", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null; has_signal: boolean }> = [];
    const channel = new TeamsChannel({
      access_token: "secret-graph-token",
      log: () => undefined,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          auth: new Headers(init?.headers).get("authorization"),
          has_signal: init?.signal instanceof AbortSignal,
        });
        return new Response(JSON.stringify({ id: "graph-msg-1" }), {
          status: 201,
          headers: { "content-type": "application/json", "request-id": "REQ-1" },
        });
      },
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        {
          channel: "teams",
          target: teamsChannelTarget("team-1", "19:channel@thread.tacv2"),
          content: "hello",
        },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({ delivered: true, external_id: "graph-msg-1" });
      expect(calls).toEqual([
        {
          url: "https://graph.microsoft.com/v1.0/teams/team-1/channels/19%3Achannel%40thread.tacv2/messages",
          body: { body: { contentType: "text", content: "hello" } },
          auth: "Bearer secret-graph-token",
          has_signal: true,
        },
      ]);
      expect(JSON.stringify(channel.getHistory())).not.toContain("secret-graph-token");
    } finally {
      await channel.stop();
    }
  });

  it("classifies Microsoft Graph HTTP timeout as recoverable", async () => {
    const channel = new TeamsChannel({
      access_token: "secret-graph-token",
      request_timeout_ms: 1,
      retry: false,
      log: () => undefined,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        {
          channel: "teams",
          target: teamsChannelTarget("team-1", "19:channel@thread.tacv2"),
          content: "hello",
        },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({
        delivered: false,
        error_kind: "recoverable",
        error_code: "teams_timeout",
      });
    } finally {
      await channel.stop();
    }
  });

  it("aborts the local Graph HTTP request when the execution is cancelled", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const channel = new TeamsChannel({
      access_token: "secret-graph-token",
      retry: false,
      log: () => undefined,
      fetch: async (_input, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    await channel.start(async () => undefined);
    try {
      const sending = channel.send({ channel: "teams", target: teamsChannelTarget("team-1", "channel-1"), content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" }, { signal: controller.signal });
      await requestStarted;
      controller.abort();
      const result = await sending;
      expect(requestSignal?.aborted).toBe(true);
      expect(result.delivered).toBe(false);
    } finally {
      await channel.stop();
    }
  });

  it("retries recoverable rate-limit responses", async () => {
    const transport = new FakeTeamsTransport();
    let calls = 0;
    transport.postMessage = async (): Promise<TeamsPostResult> => {
      calls += 1;
      if (calls < 3) return { ok: false, error: "rate_limited", retry_after_ms: 25 };
      return { ok: true, message_id: "done" };
    };
    const sleeps: number[] = [];
    const channel = new TeamsChannel({
      transport,
      log: () => undefined,
      retry: {
        max_retries: 3,
        base_delay_ms: 10,
        max_delay_ms: 1000,
        jitter_ratio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(
        { channel: "teams", target: teamsChannelTarget("team", "channel"), content: "x" },
        { command_id: "cmd", upstream_commit_hash: "hash" },
      );
      expect(result).toMatchObject({ delivered: true, external_id: "done" });
      expect(calls).toBe(3);
      expect(sleeps).toEqual([25, 25]);
    } finally {
      await channel.stop();
    }
  });

  it("does not retry after task cancellation", async () => {
    const transport = new FakeTeamsTransport();
    const controller = new AbortController();
    let calls = 0;
    transport.postMessage = async (): Promise<TeamsPostResult> => {
      calls++;
      controller.abort();
      return { ok: false, error: "rate_limited", retry_after_ms: 1 };
    };
    const channel = new TeamsChannel({ transport, log: () => {}, retry: {
      max_retries: 3, base_delay_ms: 0, max_delay_ms: 1, jitter_ratio: 0,
      sleep: async () => {}, random: () => 0.5,
    } });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send({ channel: "teams", target: teamsChannelTarget("team-1", "channel-1"), content: "hello" },
        { command_id: "cmd", upstream_commit_hash: "hash" }, { signal: controller.signal });
      expect(result.delivered).toBe(false);
      expect(calls).toBe(1);
    } finally {
      await channel.stop();
    }
  });
});
