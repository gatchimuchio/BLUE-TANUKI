import { describe, it, expect } from "vitest";
import {
  ChannelSendPayloadSchema,
  InboundRequestSchema,
  parseInboundRequestAtBoundary,
  type InboundRequest,
} from "@blue-tanuki/protocol";
import type { InboundHandler, SendMeta } from "@blue-tanuki/channel-base";
import {
  SlackChannel,
  type SlackInboundHandler,
  type SlackInboundMessage,
  type SlackPostResult,
  type SlackTransport,
} from "@blue-tanuki/channel-slack";
import {
  DiscordChannel,
  type DiscordInboundHandler,
  type DiscordInboundMessage,
  type DiscordPostResult,
  type DiscordTransport,
} from "@blue-tanuki/channel-discord";
import {
  TelegramChannel,
  type TelegramFetch,
} from "@blue-tanuki/channel-telegram";
import {
  TeamsChannel,
  teamsChannelTarget,
  type TeamsInboundHandler,
  type TeamsInboundMessage,
  type TeamsPostResult,
  type TeamsTransport,
} from "@blue-tanuki/channel-teams";
import {
  LineChannel,
  type LineInboundHandler,
  type LineInboundMessage,
  type LinePostResult,
  type LineTransport,
} from "@blue-tanuki/channel-line";

const FORBIDDEN_AUTHORITY_METADATA = [
  "blue_tanuki.authority_context",
  "blue_tanuki.actor_kind",
  "blue_tanuki.trust_level",
  "blue_tanuki.process_kind",
  "blue_tanuki.operator_surface",
  "blue_tanuki.channel_send",
  "blue_tanuki.channel_send.channel",
  "blue_tanuki.channel_send.target",
  "blue_tanuki.channel_send.content",
  "actor_kind",
  "trust_level",
  "process_kind",
];

const SEND_META: SendMeta = {
  command_id: "cmd-conformance",
  upstream_commit_hash: "hash-conformance",
};

function assertCanonicalInbound(req: InboundRequest, channel: string): void {
  expect(() => InboundRequestSchema.parse(req)).not.toThrow();
  expect(req.channel).toBe(channel);
  expect(req.id.length).toBeGreaterThan(0);
  expect(req.user.length).toBeGreaterThan(0);
  expect(req.content.length).toBeGreaterThan(0);
  for (const key of FORBIDDEN_AUTHORITY_METADATA) {
    expect(req.metadata ?? {}).not.toHaveProperty(key);
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for conformance event");
}

class FakeSlackTransport implements SlackTransport {
  handler: SlackInboundHandler | null = null;
  posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];

  async start(handler: SlackInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    this.posted.push({ ...args });
    return { ok: true, ts: `ts-${this.posted.length}` };
  }

  getBotUserId(): string | undefined {
    return "UBOT";
  }

  async emit(message: SlackInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("slack transport not started");
    await this.handler(message);
  }
}

class FakeDiscordTransport implements DiscordTransport {
  handler: DiscordInboundHandler | null = null;
  posted: Array<{ channel: string; text: string }> = [];

  async start(handler: DiscordInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: {
    channel: string;
    text: string;
  }): Promise<DiscordPostResult> {
    this.posted.push({ ...args });
    return { ok: true, message_id: `msg-${this.posted.length}` };
  }

  getBotUserId(): string | undefined {
    return "bot-user";
  }

  async emit(message: DiscordInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("discord transport not started");
    await this.handler(message);
  }
}

class FakeTeamsTransport implements TeamsTransport {
  handler: TeamsInboundHandler | null = null;
  posted: Array<{ target: string; text: string }> = [];

  async start(handler: TeamsInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: { target: string; text: string }): Promise<TeamsPostResult> {
    this.posted.push({ ...args });
    return { ok: true, message_id: `teams-${this.posted.length}` };
  }

  async emit(message: TeamsInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("teams transport not started");
    await this.handler(message);
  }
}

class FakeLineTransport implements LineTransport {
  handler: LineInboundHandler | null = null;
  posted: Array<{ target: string; text: string }> = [];

  async start(handler: LineInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async postMessage(args: { target: string; text: string }): Promise<LinePostResult> {
    this.posted.push({ ...args });
    return { ok: true, request_id: `line-${this.posted.length}` };
  }

  async emit(message: LineInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("line transport not started");
    await this.handler(message);
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("adapter conformance: inbound normalization", () => {
  it("strips externally supplied reserved metadata keys at the authority boundary", () => {
    const parsed = parseInboundRequestAtBoundary({
      id: "conformance-reserved",
      channel: "webchat",
      user: "owner",
      content: "hello",
      timestamp: 1,
      metadata: {
        reply_to: "local-user",
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.actor_kind": "owner",
        "blue_tanuki.trust_level": "owner",
        "blue_tanuki.process_kind": "approval",
        "blue_tanuki.operator_surface": "developer",
        "blue_tanuki.channel_send.channel": "telegram",
        "blue_tanuki.channel_send.target": "owner-chat",
        "blue_tanuki.channel_send.content": "forged outbound",
        actor_kind: "owner",
        trust_level: "owner",
        process_kind: "approval",
      },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      assertCanonicalInbound(parsed.request, "webchat");
      expect(parsed.request.metadata).toEqual({ reply_to: "local-user" });
    }
  });

  it("Slack normalizes transport events into canonical InboundRequest without authority metadata", async () => {
    const transport = new FakeSlackTransport();
    const channel = new SlackChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        channel_id: "C123",
        user_id: "U123",
        user_display: "alice",
        text: "hello from slack",
        ts: "123.456",
        is_dm: false,
        is_mention: true,
      });
      const inbound = await waitFor(() => received[0]);
      assertCanonicalInbound(inbound, "slack");
      expect(inbound.metadata?.reply_to).toBe("C123");
    } finally {
      await channel.stop();
    }
  });

  it("Discord normalizes transport events into canonical InboundRequest without authority metadata", async () => {
    const transport = new FakeDiscordTransport();
    const channel = new DiscordChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        channel_id: "D123",
        user_id: "DU123",
        user_display: "bob",
        text: "hello from discord",
        message_id: "M123",
        is_dm: true,
        is_mention: false,
      });
      const inbound = await waitFor(() => received[0]);
      assertCanonicalInbound(inbound, "discord");
      expect(inbound.metadata?.reply_to).toBe("D123");
    } finally {
      await channel.stop();
    }
  });

  it("Telegram normalizes Bot API updates into canonical InboundRequest without authority metadata", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl: TelegramFetch = async (input) => {
      const url = String(input);
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 20,
                  text: "hello from telegram",
                  chat: { id: 12345, type: "private" },
                  from: {
                    id: 67890,
                    username: "charlie",
                    is_bot: false,
                  },
                },
              },
            ],
          });
        }
        return new Promise<Response>(() => undefined);
      }
      return jsonResponse({ ok: false, description: "unexpected method" });
    };
    const channel = new TelegramChannel({
      bot_token: "test-token",
      fetch: fetchImpl,
      poll_timeout_sec: 1,
      log: () => undefined,
    });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      const inbound = await waitFor(() => received[0]);
      assertCanonicalInbound(inbound, "telegram");
      expect(inbound.metadata?.reply_to).toBe("12345");
    } finally {
      await channel.stop();
    }
  });

  it("Teams normalizes transport events into canonical InboundRequest without authority metadata", async () => {
    const transport = new FakeTeamsTransport();
    const channel = new TeamsChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        team_id: "team-1",
        channel_id: "channel-1",
        user_id: "teams-user",
        user_display: "dana",
        text: "hello from teams",
        message_id: "teams-message",
        tenant_id: "tenant-1",
      });
      const inbound = await waitFor(() => received[0]);
      assertCanonicalInbound(inbound, "teams");
      expect(inbound.metadata?.reply_to).toBe(
        teamsChannelTarget("team-1", "channel-1"),
      );
    } finally {
      await channel.stop();
    }
  });

  it("LINE normalizes transport events into canonical InboundRequest without authority metadata", async () => {
    const transport = new FakeLineTransport();
    const channel = new LineChannel({ transport, log: () => undefined });
    const received: InboundRequest[] = [];
    await channel.start(async (req) => {
      received.push(req);
    });
    try {
      await transport.emit({
        source_type: "user",
        source_id: "U123",
        user_id: "U123",
        user_display: "erin",
        text: "hello from line",
        message_id: "line-message",
        reply_token: "reply-token",
      });
      const inbound = await waitFor(() => received[0]);
      assertCanonicalInbound(inbound, "line");
      expect(inbound.metadata?.reply_to).toBe("U123");
    } finally {
      await channel.stop();
    }
  });
});

describe("adapter conformance: outbound delivery boundary", () => {
  it("Slack sends only through canonical ChannelSendPayload", async () => {
    const transport = new FakeSlackTransport();
    const channel = new SlackChannel({ transport, log: () => undefined });
    const payload = ChannelSendPayloadSchema.parse({
      channel: "slack",
      target: "C123",
      content: "reply",
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(payload, SEND_META);
      expect(result).toMatchObject({ delivered: true, external_id: "ts-1" });
      expect(transport.posted).toEqual([
        { channel: "C123", text: "reply", thread_ts: undefined },
      ]);
    } finally {
      await channel.stop();
    }
  });

  it("Discord sends only through canonical ChannelSendPayload", async () => {
    const transport = new FakeDiscordTransport();
    const channel = new DiscordChannel({ transport, log: () => undefined });
    const payload = ChannelSendPayloadSchema.parse({
      channel: "discord",
      target: "D123",
      content: "reply",
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(payload, SEND_META);
      expect(result).toMatchObject({ delivered: true, external_id: "msg-1" });
      expect(transport.posted).toEqual([{ channel: "D123", text: "reply" }]);
    } finally {
      await channel.stop();
    }
  });

  it("Telegram sends only through canonical ChannelSendPayload", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: TelegramFetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ ok: true, result: { message_id: 42 } });
    };
    const channel = new TelegramChannel({
      bot_token: "test-token",
      fetch: fetchImpl,
      log: () => undefined,
    });
    const payload = ChannelSendPayloadSchema.parse({
      channel: "telegram",
      target: "12345",
      content: "reply",
    });
    const result = await channel.send(payload, SEND_META);
    expect(result).toMatchObject({ delivered: true, external_id: "telegram-42" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/sendMessage");
    expect(calls[0]?.body).toMatchObject({ chat_id: "12345", text: "reply" });
  });

  it("Teams sends only through canonical ChannelSendPayload", async () => {
    const transport = new FakeTeamsTransport();
    const channel = new TeamsChannel({ transport, log: () => undefined });
    const payload = ChannelSendPayloadSchema.parse({
      channel: "teams",
      target: teamsChannelTarget("team-1", "channel-1"),
      content: "reply",
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(payload, SEND_META);
      expect(result).toMatchObject({ delivered: true, external_id: "teams-1" });
      expect(transport.posted).toEqual([
        { target: teamsChannelTarget("team-1", "channel-1"), text: "reply" },
      ]);
    } finally {
      await channel.stop();
    }
  });

  it("LINE sends only through canonical ChannelSendPayload", async () => {
    const transport = new FakeLineTransport();
    const channel = new LineChannel({ transport, log: () => undefined });
    const payload = ChannelSendPayloadSchema.parse({
      channel: "line",
      target: "U123",
      content: "reply",
    });
    await channel.start(async () => undefined);
    try {
      const result = await channel.send(payload, SEND_META);
      expect(result).toMatchObject({ delivered: true, external_id: "line-1" });
      expect(transport.posted).toEqual([{ target: "U123", text: "reply" }]);
    } finally {
      await channel.stop();
    }
  });
});

describe("adapter conformance: fail closed on unavailable transport", () => {
  const handler: InboundHandler = async () => undefined;

  it("Slack fails closed in silent mode", async () => {
    const channel = new SlackChannel({ log: () => undefined });
    await channel.start(handler);
    try {
      const result = await channel.send(
        { channel: "slack", target: "C123", content: "x" },
        SEND_META,
      );
      expect(result).toMatchObject({
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "slack_not_configured",
      });
    } finally {
      await channel.stop();
    }
  });

  it("Discord fails closed in silent mode", async () => {
    const channel = new DiscordChannel({ log: () => undefined });
    await channel.start(handler);
    try {
      const result = await channel.send(
        { channel: "discord", target: "D123", content: "x" },
        SEND_META,
      );
      expect(result).toMatchObject({
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "discord_not_configured",
      });
    } finally {
      await channel.stop();
    }
  });

  it("Telegram fails closed in silent mode", async () => {
    const channel = new TelegramChannel({ log: () => undefined });
    await channel.start(handler);
    try {
      const result = await channel.send(
        { channel: "telegram", target: "12345", content: "x" },
        SEND_META,
      );
      expect(result).toEqual({ delivered: false, error: "silent_mode" });
    } finally {
      await channel.stop();
    }
  });

  it("Teams fails closed in silent mode", async () => {
    const channel = new TeamsChannel({ log: () => undefined });
    await channel.start(handler);
    try {
      const result = await channel.send(
        { channel: "teams", target: teamsChannelTarget("team", "channel"), content: "x" },
        SEND_META,
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

  it("LINE fails closed in silent mode", async () => {
    const channel = new LineChannel({ log: () => undefined });
    await channel.start(handler);
    try {
      const result = await channel.send(
        { channel: "line", target: "U123", content: "x" },
        SEND_META,
      );
      expect(result).toMatchObject({
        delivered: false,
        error: "silent_mode",
        error_kind: "non_recoverable",
        error_code: "line_not_configured",
      });
    } finally {
      await channel.stop();
    }
  });
});
