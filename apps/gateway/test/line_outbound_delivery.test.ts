import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboundRouter, OutboundDispatcher } from "@blue-tanuki/channel-base";
import {
  LineChannel,
  LineMessagingTransport,
  type LineInboundHandler,
  type LineInboundMessage,
  type LinePostResult,
  type LineTransport,
} from "@blue-tanuki/channel-line";
import { GatewayLineEventStore } from "../src/line_event_store.js";
import { planGatewayInboundBoundary, replyPayload } from "../src/serve.js";

const CHANNEL_SECRET = "synthetic-line-channel-secret";
const DESTINATION = "Ubot-destination";
const ACCESS_TOKEN = "synthetic-line-access-token";
const USER_ID = "U123";
const EVENT_ID = "01FZ74A0TDDPYRVKNK77XKC3ZR";

describe("LINE durable outbound consumer", () => {
  it("connects a granted webhook through Gateway reply routing and persists Retry-After before the same-key retry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-line-outbox-e2e-"));
    const filepath = path.join(dir, "line.sqlite");
    const store = new GatewayLineEventStore(filepath, DESTINATION, ACCESS_TOKEN);
    const calls: Array<{ target: string; text: string; retryKey: string | null }> = [];
    let observedPersistedWait = false;
    const transport = new LineMessagingTransport({
      channel_access_token: ACCESS_TOKEN,
      channel_secret: CHANNEL_SECRET,
      channel_destination: DESTINATION,
      webhook_host: "127.0.0.1",
      webhook_port: 0,
      webhook_route: "/line/outbox-webhook",
      fetch: async (_input, init) => {
        const requestBody = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
        calls.push({
          target: requestBody.to,
          text: requestBody.messages[0]!.text,
          retryKey: new Headers(init?.headers).get("x-line-retry-key"),
        });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ message: "synthetic rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1", "x-line-request-id": "req-429" },
          });
        }
        if (calls.length === 2) {
          return new Response(JSON.stringify({ message: "synthetic server error" }), {
            status: 500,
            headers: { "content-type": "application/json", "x-line-request-id": "req-500" },
          });
        }
        return new Response(JSON.stringify({ message: "The retry key is already accepted" }), {
          status: 409,
          headers: { "x-line-request-id": "retry-attempt-id", "x-line-accepted-request-id": "req-delivered" },
        });
      },
    });
    const channel = new LineChannel({
      transport,
      inbox: store,
      delivery_store: store,
      channel_destination: DESTINATION,
      inbound_grants: [{ destination: DESTINATION, source_type: "user", source_id: USER_ID, user_id: USER_ID }],
      retry: {
        max_retries: 3,
        sleep: async (ms) => {
          const queued = store.pending();
          expect(queued).toHaveLength(1);
          expect(queued[0]).toMatchObject({ delivery_state: "retry_wait" });
          const raw = await fs.readFile(filepath);
          expect(raw.includes(Buffer.from("synthetic LINE reply body"))).toBe(true);
          expect(raw.includes(Buffer.from(ACCESS_TOKEN))).toBe(false);
          observedPersistedWait = true;
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
      log: () => undefined,
    });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["line"],
      redactHandlerErrorsForChannels: ["line"],
    });
    const dispatcher = new OutboundDispatcher();
    router.register(channel);
    dispatcher.register(channel);
    let admitted = 0;

    try {
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        const sent = await dispatcher.dispatch(
          replyPayload(boundary.request, "synthetic LINE reply body"),
          { command_id: "line-outbox-fixture", upstream_commit_hash: "synthetic-hash" },
        );
        expect(sent).toMatchObject({ delivered: true, delivery_status: "delivered", external_id: "req-delivered" });
        admitted++;
      });
      const activeTransport = transport as LineMessagingTransport;
      const port = activeTransport.getListeningPort();
      if (port === null) throw new Error("line_webhook_listener_not_started");
      const original = signedEnvelope("synthetic LINE request body");
      expect((await sendWebhook(port, original)).status).toBe(200);
      expect((await sendWebhook(port, original)).status).toBe(200);

      expect(admitted).toBe(1);
      expect(observedPersistedWait).toBe(true);
      expect(calls).toHaveLength(3);
      expect(calls.map((call) => call.target)).toEqual([USER_ID, USER_ID, USER_ID]);
      expect(calls.map((call) => call.text)).toEqual([
        "synthetic LINE reply body", "synthetic LINE reply body", "synthetic LINE reply body",
      ]);
      expect(calls[0]!.retryKey).toMatch(/^[a-f0-9-]{36}$/u);
      expect(calls[1]!.retryKey).toBe(calls[0]!.retryKey);
      expect(calls[2]!.retryKey).toBe(calls[0]!.retryKey);
      expect(store.pending()).toEqual([]);
      const raw = await fs.readFile(filepath);
      for (const privateValue of [ACCESS_TOKEN, CHANNEL_SECRET, "synthetic LINE reply body", "synthetic LINE request body", USER_ID]) {
        expect(raw.includes(Buffer.from(privateValue))).toBe(false);
      }
    } finally {
      await router.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted request with the same persisted retry key and immutable payload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-line-outbox-restart-"));
    const filepath = path.join(dir, "line.sqlite");
    const deliveryId = randomUUID();
    const payload = {
      delivery_id: deliveryId,
      channel: "line" as const,
      target: USER_ID,
      text: "private line reply after interrupted request",
      expires_at_ms: Date.now() + 60_000,
    };
    const first = new GatewayLineEventStore(filepath, DESTINATION, ACCESS_TOKEN);
    first.enqueue(payload);
    expect(first.claimDelivery(deliveryId)).toMatchObject({ delivery_id: deliveryId, target: USER_ID, text: payload.text });
    first.close();

    const reopened = new GatewayLineEventStore(filepath, DESTINATION, ACCESS_TOKEN);
    const pending = reopened.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ delivery_id: deliveryId, delivery_state: "retry_wait" });
    const retryingTransport = new RestartTransport();
    const channel = new LineChannel({
      transport: retryingTransport,
      delivery_store: reopened,
      retry: { max_retries: 1, sleep: async () => undefined },
      log: () => undefined,
    });
    try {
      await channel.start(async () => undefined);
      await vi.waitFor(() => expect(reopened.status(deliveryId)).toMatchObject({ delivery_state: "delivered" }));
      expect(retryingTransport.posts).toEqual([{
        target: USER_ID,
        text: payload.text,
        retry_key: deliveryId,
      }]);
      const raw = await fs.readFile(filepath);
      expect(raw.includes(Buffer.from(payload.text))).toBe(false);
      expect(raw.includes(Buffer.from(ACCESS_TOKEN))).toBe(false);
    } finally {
      await channel.stop();
      reopened.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("expires queued bodies and clears a previous credential scope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-line-outbox-expiry-"));
    const filepath = path.join(dir, "line.sqlite");
    const expiredId = randomUUID();
    const expiredText = "expired reply body never dispatched";
    const store = new GatewayLineEventStore(filepath, DESTINATION, ACCESS_TOKEN);
    const now = Date.now();
    store.enqueue({ delivery_id: expiredId, channel: "line", target: USER_ID,
      text: expiredText, expires_at_ms: now + 10_000 }, now);
    expect(store.pending(now + 10_000)).toEqual([]);
    expect(store.status(expiredId)).toMatchObject({ delivery_state: "retry_exhausted", error_code: "delivery_expired" });

    const rotatedId = randomUUID();
    store.enqueue({ delivery_id: rotatedId, channel: "line", target: USER_ID,
      text: "old credential reply body", expires_at_ms: Date.now() + 60_000 });
    store.close();
    const rotated = new GatewayLineEventStore(filepath, DESTINATION, "rotated-synthetic-token");
    expect(rotated.pending()).toEqual([]);
    rotated.close();
    const oldScope = new GatewayLineEventStore(filepath, DESTINATION, ACCESS_TOKEN);
    try {
      expect(oldScope.status(rotatedId)).toMatchObject({
        delivery_state: "outcome_unknown",
        error_code: "credential_scope_changed",
      });
      const raw = await fs.readFile(filepath);
      for (const privateValue of [expiredText, "old credential reply body", ACCESS_TOKEN, "rotated-synthetic-token"]) {
        expect(raw.includes(Buffer.from(privateValue))).toBe(false);
      }
    } finally {
      oldScope.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

class RestartTransport implements LineTransport {
  handler: LineInboundHandler | null = null;
  readonly posts: Array<{ target: string; text: string; retry_key: string }> = [];
  async start(handler: LineInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(args: { target: string; text: string; retry_key: string }): Promise<LinePostResult> {
    this.posts.push(args);
    return { ok: true, delivery_status: "delivered", request_id: "accepted-after-restart" };
  }
}

function signedEnvelope(text: string): string {
  return JSON.stringify({
    destination: DESTINATION,
    events: [{
      type: "message",
      message: { id: "synthetic-message-id", type: "text", text },
      timestamp: 1_700_000_000_000,
      source: { type: "user", userId: USER_ID },
      webhookEventId: EVENT_ID,
      deliveryContext: { isRedelivery: false },
      replyToken: "ephemeral-reply-token-not-persisted",
    }],
  });
}

async function sendWebhook(port: number, body: string): Promise<Response> {
  const signature = createHmac("sha256", CHANNEL_SECRET).update(Buffer.from(body, "utf8")).digest("base64");
  return await fetch(`http://127.0.0.1:${port}/line/outbox-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  });
}
