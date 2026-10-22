import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboundRouter } from "@blue-tanuki/channel-base";
import { LineChannel, LineMessagingTransport, type LineInboundGrant } from "@blue-tanuki/channel-line";
import { GatewayLineEventStore } from "../src/line_event_store.js";
import { planGatewayInboundBoundary } from "../src/serve.js";

const CHANNEL_SECRET = "synthetic-line-channel-secret";
const DESTINATION = "Ubot-destination";
const EVENT_ID = "01FZ74A0TDDPYRVKNK77XKC3ZR";
const MESSAGE_ID = "1234567890";

describe("LINE signed webhook to Gateway inbound consumer", () => {
  it("authenticates raw bytes, exact-grants the source, and suppresses redelivery and identity conflicts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-line-inbound-"));
    const filepath = path.join(dir, "line.sqlite");
    const store = new GatewayLineEventStore(filepath, DESTINATION);
    const grant: LineInboundGrant = {
      destination: DESTINATION,
      source_type: "group",
      source_id: "Cgroup-1",
      user_id: "U123",
    };
    const transport = new LineMessagingTransport({
      channel_secret: CHANNEL_SECRET,
      channel_destination: DESTINATION,
      webhook_host: "127.0.0.1",
      webhook_port: 0,
      webhook_route: "/line/test-webhook",
      log: () => undefined,
    });
    const channel = new LineChannel({
      transport,
      channel_destination: DESTINATION,
      inbound_grants: [grant],
      inbox: store,
      log: () => undefined,
    });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["line"],
      redactHandlerErrorsForChannels: ["line"],
    });
    router.register(channel);
    const accepted: Array<{ user: string; content: string }> = [];

    try {
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        accepted.push({ user: boundary.request.user, content: boundary.request.content });
      });
      const port = transport.getListeningPort();
      if (port === null) throw new Error("line_webhook_listener_not_started");
      const original = envelope({ text: "synthetic LINE request body" });
      const redelivery = envelope({ text: "synthetic LINE request body", isRedelivery: true });
      const conflict = envelope({ text: "changed body for the same event id" });
      const ungranted = envelope({ sourceId: "Cgroup-1", userId: "U999", webhookEventId: "01FZ74A0TDDPYRVKNK77XKC3ZS" });

      expect((await sendWebhook(port, original)).status).toBe(200);
      expect((await sendWebhook(port, redelivery)).status).toBe(200);
      expect((await sendWebhook(port, conflict)).status).toBe(200);
      expect((await sendWebhook(port, ungranted)).status).toBe(200);
      expect(accepted).toEqual([{
        user: expect.stringMatching(/^line:[a-f0-9]{64}$/u),
        content: "synthetic LINE request body",
      }]);

      const persisted = await fs.readFile(filepath);
      for (const raw of [CHANNEL_SECRET, DESTINATION, "Cgroup-1", "U123", EVENT_ID, MESSAGE_ID, "synthetic LINE request body"]) {
        expect(persisted.includes(Buffer.from(raw))).toBe(false);
      }
    } finally {
      await router.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists replay identity only as digests and never replays an interrupted handler", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-line-inbox-restart-"));
    const filepath = path.join(dir, "line.sqlite");
    const eventId = "01FZ74A0TDDPYRVKNK77XKC3ZR";
    const payloadDigest = "a".repeat(64);
    const first = new GatewayLineEventStore(filepath, DESTINATION);
    try {
      expect(first.claim(eventId, payloadDigest)).toEqual({ status: "accepted" });
      first.close();
      const reopened = new GatewayLineEventStore(filepath, DESTINATION);
      try {
        expect(reopened.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
        expect(reopened.claim(eventId, "b".repeat(64))).toEqual({ status: "identity_conflict" });
        const persisted = await fs.readFile(filepath);
        for (const raw of [DESTINATION, eventId, CHANNEL_SECRET]) expect(persisted.includes(Buffer.from(raw))).toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed above */ }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function envelope(options: {
  text?: string;
  sourceId?: string;
  userId?: string;
  webhookEventId?: string;
  isRedelivery?: boolean;
} = {}): string {
  return JSON.stringify({
    destination: DESTINATION,
    events: [{
      type: "message",
      message: { id: MESSAGE_ID, type: "text", text: options.text ?? "synthetic LINE request body" },
      timestamp: 1_700_000_000_000,
      source: { type: "group", groupId: options.sourceId ?? "Cgroup-1", userId: options.userId ?? "U123" },
      webhookEventId: options.webhookEventId ?? EVENT_ID,
      deliveryContext: { isRedelivery: options.isRedelivery ?? false },
      replyToken: "ephemeral-reply-token-not-persisted",
    }],
  });
}

async function sendWebhook(port: number, body: string): Promise<Response> {
  const signature = createHmac("sha256", CHANNEL_SECRET).update(Buffer.from(body, "utf8")).digest("base64");
  return await fetch(`http://127.0.0.1:${port}/line/test-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "x-line-signature": signature },
    body,
  });
}
