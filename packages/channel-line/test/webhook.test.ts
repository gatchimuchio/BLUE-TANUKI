import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LineMessagingTransport, type LineInboundMessage } from "../src/index.js";

const CHANNEL_SECRET = "synthetic-line-channel-secret";
const DESTINATION = "Ubot-destination";
const EVENT_ID = "01FZ74A0TDDPYRVKNK77XKC3ZR";
const transports: LineMessagingTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()));
});

describe("LINE signed webhook transport", () => {
  it("refuses to expose the listener on a non-loopback interface", () => {
    expect(() => new LineMessagingTransport({
      channel_secret: CHANNEL_SECRET,
      channel_destination: DESTINATION,
      webhook_host: "0.0.0.0",
    })).toThrow("line_webhook_listener_host_must_be_loopback");
  });

  it("verifies the raw body before parsing and admits only supported text event identity", async () => {
    const transport = await startTransport();
    const received: LineInboundMessage[] = [];
    await transport.start(async (message) => { received.push(message); });
    const rawBody = JSON.stringify({ destination: DESTINATION, events: [textEvent({ message: { id: "1234567890", type: "text", text: "line one\nline two🙂" } })] });

    const response = await post(transport, rawBody, sign(rawBody));

    expect(response.status).toBe(200);
    expect(received).toEqual([{
      destination: DESTINATION,
      source_type: "group",
      source_id: "Cgroup-1",
      user_id: "U123",
      text: "line one\nline two🙂",
      message_id: "1234567890",
      webhook_event_id: EVENT_ID,
      event_timestamp_ms: 1_700_000_000_000,
      is_redelivery: false,
    }]);
  });

  it("rejects absent and incorrect signatures without parsing or invoking the consumer", async () => {
    const transport = await startTransport();
    const received: LineInboundMessage[] = [];
    await transport.start(async (message) => { received.push(message); });
    const rawBody = JSON.stringify({ destination: DESTINATION, events: [textEvent()] });

    const missing = await post(transport, rawBody);
    const invalid = await post(transport, rawBody, Buffer.alloc(32).toString("base64"));

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(received).toEqual([]);
  });

  it("rejects a signed event for another bot destination", async () => {
    const transport = await startTransport();
    const received: LineInboundMessage[] = [];
    await transport.start(async (message) => { received.push(message); });
    const rawBody = JSON.stringify({ destination: "Uother-bot", events: [textEvent()] });

    const response = await post(transport, rawBody, sign(rawBody));

    expect(response.status).toBe(403);
    expect(received).toEqual([]);
  });

  it("acknowledges LINE's signed empty-events verification request and ignores media events", async () => {
    const transport = await startTransport();
    const received: LineInboundMessage[] = [];
    await transport.start(async (message) => { received.push(message); });
    const emptyBody = JSON.stringify({ destination: DESTINATION, events: [] });
    const mediaBody = JSON.stringify({ destination: DESTINATION, events: [textEvent({ message: { id: "image-1", type: "image" } })] });

    expect((await post(transport, emptyBody, sign(emptyBody))).status).toBe(200);
    expect((await post(transport, mediaBody, sign(mediaBody))).status).toBe(200);
    expect(received).toEqual([]);
  });
});

async function startTransport(): Promise<LineMessagingTransport> {
  const transport = new LineMessagingTransport({
    channel_secret: CHANNEL_SECRET,
    channel_destination: DESTINATION,
    webhook_host: "127.0.0.1",
    webhook_port: 0,
    webhook_route: "/line/test-webhook",
    log: () => undefined,
  });
  transports.push(transport);
  return transport;
}

function textEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    message: { id: "1234567890", type: "text", text: "hello" },
    timestamp: 1_700_000_000_000,
    source: { type: "group", groupId: "Cgroup-1", userId: "U123" },
    webhookEventId: EVENT_ID,
    deliveryContext: { isRedelivery: false },
    replyToken: "ephemeral-reply-token-not-forwarded",
    ...overrides,
  };
}

function sign(rawBody: string): string {
  return createHmac("sha256", CHANNEL_SECRET).update(Buffer.from(rawBody, "utf8")).digest("base64");
}

async function post(transport: LineMessagingTransport, rawBody: string, signature?: string): Promise<Response> {
  const port = transport.getListeningPort();
  if (port === null) throw new Error("line_webhook_listener_not_started");
  return await fetch(`http://127.0.0.1:${port}/line/test-webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(signature ? { "x-line-signature": signature } : {}),
    },
    body: rawBody,
  });
}
