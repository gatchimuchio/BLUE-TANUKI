import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { InboundRouter } from "@blue-tanuki/channel-base";
import {
  TeamsChannel,
  type TeamsInboundHandler,
  type TeamsInboundMessage,
  type TeamsInboundGrant,
  type TeamsPostResult,
  type TeamsTransport,
} from "@blue-tanuki/channel-teams";
import { GatewayTeamsEventStore } from "../src/teams_event_store.js";
import { planGatewayInboundBoundary } from "../src/serve.js";

const CLIENT_ID = "11111111-2222-4333-8444-555555555555";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FixtureTeamsTransport implements TeamsTransport {
  private handler: TeamsInboundHandler | null = null;
  async start(handler: TeamsInboundHandler): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> { this.handler = null; }
  async postMessage(): Promise<TeamsPostResult> { return { ok: true, message_id: "synthetic-reply-id" }; }
  async emit(message: TeamsInboundMessage): Promise<void> {
    if (!this.handler) throw new Error("teams_transport_not_started");
    await this.handler(message);
  }
}

describe("GatewayTeamsEventStore", () => {
  it("persists replay decisions as digests and converts interrupted dispatch to outcome-unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-inbox-"));
    const filepath = path.join(dir, "teams.sqlite");
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const conversation = "19:private-conversation@thread.v2";
    const messageId = "synthetic-message-id";
    const text = "synthetic private text never persist";
    const eventId = digest(JSON.stringify([tenant, conversation, messageId]));
    const payloadDigest = digest(text);
    const first = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    try {
      expect(first.claim(eventId, payloadDigest)).toEqual({ status: "accepted" });
      expect(first.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "dispatching" });
    } finally {
      first.close();
    }

    try {
      const reopened = new GatewayTeamsEventStore(filepath, CLIENT_ID);
      expect(reopened.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      reopened.settle(eventId, payloadDigest, "outcome_unknown");
      expect(reopened.claim(eventId, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      expect(reopened.claim(eventId, digest("changed text"))).toEqual({ status: "identity_conflict" });
      const otherBot = new GatewayTeamsEventStore(filepath, "22222222-3333-4444-8555-666666666666");
      expect(otherBot.claim(eventId, payloadDigest)).toEqual({ status: "accepted" });
      otherBot.close();
      reopened.close();
      const persisted = await fs.readFile(filepath);
      for (const raw of [CLIENT_ID, eventId, tenant, conversation, messageId, text]) {
        expect(persisted.includes(Buffer.from(raw))).toBe(false);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("routes a granted synthetic Teams event into the Gateway inbound boundary exactly once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-teams-route-"));
    const filepath = path.join(dir, "teams.sqlite");
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const message: TeamsInboundMessage = {
      tenant_id: tenant,
      conversation_id: "19:conversation@thread.v2",
      conversation_type: "groupChat",
      user_id: "29:owner-platform-id",
      text: "synthetic request body",
      message_id: "synthetic-activity-id",
    };
    const grant: TeamsInboundGrant = {
      tenant_id: tenant,
      conversation_id: message.conversation_id,
      conversation_type: "groupChat",
      user_id: message.user_id,
      team_id: null,
      channel_id: null,
    };
    const store = new GatewayTeamsEventStore(filepath, CLIENT_ID);
    const transport = new FixtureTeamsTransport();
    const channel = new TeamsChannel({ transport, inbox: store, inbound_grants: [grant], log: () => {} });
    const router = new InboundRouter({
      propagateHandlerErrorsForChannels: ["teams"],
      redactHandlerErrorsForChannels: ["teams"],
    });
    router.register(channel);
    const requests: Array<{ user: string; content: string }> = [];
    try {
      await router.start(async (request) => {
        const boundary = planGatewayInboundBoundary(request);
        expect(boundary.boundary_ok).toBe(true);
        requests.push({ user: boundary.request.user, content: boundary.request.content });
      });
      await transport.emit(message);
      await transport.emit(message);
      await transport.emit({ ...message, text: "conflicting replay payload" });
      await transport.emit({ ...message, conversation_id: "19:another-conversation@thread.v2" });
      expect(requests).toEqual([{
        user: expect.stringMatching(/^teams:[a-f0-9]{64}$/u),
        content: "synthetic request body",
      }]);
      expect((await fs.readFile(filepath)).includes(Buffer.from("synthetic request body"))).toBe(false);
    } finally {
      await router.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
