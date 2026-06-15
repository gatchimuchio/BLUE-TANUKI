import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  TeamsChannel,
  teamsChannelTarget,
  type TeamsInboundHandler,
  type TeamsInboundMessage,
  type TeamsPostResult,
  type TeamsTransport,
} from "../src/index.js";

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

  it("normalizes injected inbound messages without authority metadata", async () => {
    const transport = new FakeTeamsTransport();
    const channel = new TeamsChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        team_id: "team-1",
        channel_id: "19:channel@thread.tacv2",
        user_id: "user-1",
        user_display: "alice",
        text: "hello teams",
        message_id: "msg-1",
        tenant_id: "tenant-1",
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "teams",
        user: "alice",
        content: "hello teams",
      });
      expect(received[0]!.metadata?.reply_to).toBe(
        teamsChannelTarget("team-1", "19:channel@thread.tacv2"),
      );
      expect(received[0]!.metadata).not.toHaveProperty("blue_tanuki.authority_context");
    } finally {
      await channel.stop();
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
});
