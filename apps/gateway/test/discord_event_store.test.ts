import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayDiscordEventStore } from "../src/discord_event_store.js";

const stores: GatewayDiscordEventStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function storeAt(filepath: string, token = "discord-token-fixture"): GatewayDiscordEventStore {
  const store = new GatewayDiscordEventStore(filepath, token);
  stores.push(store);
  return store;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("GatewayDiscordEventStore", () => {
  it("durably deduplicates message snowflakes and detects payload conflicts per bot scope", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-inbox-"));
    try {
      const filepath = path.join(dir, "discord.sqlite");
      const store = storeAt(filepath);
      const payloadDigest = digest("private discord message fixture");
      expect(store.claim("123456789", payloadDigest)).toEqual({ status: "accepted" });
      store.settle("123456789", payloadDigest, "handler_returned");
      expect(store.claim("123456789", payloadDigest)).toEqual({
        status: "duplicate",
        delivery_state: "handler_returned",
      });
      expect(store.claim("123456789", digest("changed payload"))).toEqual({ status: "identity_conflict" });
      expect(store.claim("123456789", payloadDigest)).toMatchObject({ status: "duplicate" });

      const otherBot = storeAt(filepath, "another-discord-token-fixture");
      expect(otherBot.claim("123456789", payloadDigest)).toEqual({ status: "accepted" });
      otherBot.close();
      store.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted message as outcome-unknown and persists no raw identifiers, text, or token", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-discord-inbox-"));
    try {
      const filepath = path.join(dir, "discord.sqlite");
      const messageId = "987654321012345678";
      const token = "discord-token-never-persist-fixture";
      const message = "private message never persist fixture";
      const payloadDigest = digest(message);
      const first = storeAt(filepath, token);
      expect(first.claim(messageId, payloadDigest)).toEqual({ status: "accepted" });
      first.close();

      const reopened = storeAt(filepath, token);
      expect(reopened.claim(messageId, payloadDigest)).toEqual({
        status: "duplicate",
        delivery_state: "outcome_unknown",
      });
      const persisted = await fs.readFile(filepath);
      expect(persisted.includes(Buffer.from(messageId))).toBe(false);
      expect(persisted.includes(Buffer.from(message))).toBe(false);
      expect(persisted.includes(Buffer.from(token))).toBe(false);
      reopened.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
