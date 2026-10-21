import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramChannel, type TelegramFetch } from "@blue-tanuki/channel-telegram";
import { GatewayTelegramUpdateStore } from "../src/telegram_update_store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(token = "fixture-bot-token"): { root: string; filepath: string; store: GatewayTelegramUpdateStore } {
  const root = mkdtempSync(join(tmpdir(), "blue-tanuki-telegram-inbox-"));
  roots.push(root);
  const filepath = join(root, "private", "telegram-inbox.sqlite");
  return { root, filepath, store: new GatewayTelegramUpdateStore(filepath, token) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("GatewayTelegramUpdateStore", () => {
  it("persists a high-water cursor, distinguishes duplicates and conflicting payloads, and scopes by bot", () => {
    const { filepath, store } = makeStore();
    const body = "合成メッセージの秘密本文";
    expect(store.latestUpdateId()).toBeNull();
    expect(store.claim(101, digest(body), 100)).toEqual({ status: "accepted" });
    store.settle(101, digest(body), "handler_returned", 200);
    expect(store.latestUpdateId()).toBe(101);
    expect(store.claim(101, digest(body))).toEqual({ status: "duplicate", delivery_state: "handler_returned" });
    expect(store.claim(101, digest("別内容"))).toEqual({ status: "identity_conflict" });
    expect(store.claim(100, digest("古いupdate"))).toEqual({ status: "stale" });
    store.close();

    const reopened = new GatewayTelegramUpdateStore(filepath, "fixture-bot-token");
    const otherBot = new GatewayTelegramUpdateStore(filepath, "another-fixture-bot-token");
    try {
      expect(reopened.latestUpdateId()).toBe(101);
      expect(reopened.claim(101, digest(body))).toEqual({ status: "duplicate", delivery_state: "handler_returned" });
      expect(otherBot.latestUpdateId()).toBeNull();
      const persistedBytes = readFileSync(filepath).toString("utf8");
      expect(persistedBytes).not.toContain(body);
      expect(persistedBytes).not.toContain("fixture-bot-token");
    } finally {
      reopened.close();
      otherBot.close();
    }
  });

  it("recovers interrupted admission as outcome unknown and suppresses replay", () => {
    const { filepath, store } = makeStore();
    const payloadDigest = digest("synthetic in-flight update");
    expect(store.claim(202, payloadDigest, 10)).toEqual({ status: "accepted" });
    store.close();

    const reopened = new GatewayTelegramUpdateStore(filepath, "fixture-bot-token");
    try {
      expect(reopened.latestUpdateId()).toBe(202);
      expect(reopened.claim(202, payloadDigest)).toEqual({ status: "duplicate", delivery_state: "outcome_unknown" });
      expect(reopened.claim(203, digest("synthetic next update"))).toEqual({ status: "accepted" });
      reopened.settle(203, digest("synthetic next update"), "handler_returned");
    } finally {
      reopened.close();
    }
  });

  it("connects durable admission to the Telegram polling consumer across restarts", async () => {
    const { filepath, store } = makeStore();
    const update = { update_id: 77, message: { message_id: 6, text: "synthetic replay", chat: { id: 12345 }, from: { id: 54321 } } };
    const firstRequests: number[] = [];
    const firstFetch = repeatedUpdateFetch(update, firstRequests);
    const firstChannel = new TelegramChannel({ bot_token: "fixture-bot-token", inbox: store, fetch: firstFetch.fetch,
      poll_interval_ms: 1, poll_timeout_sec: 1, request_timeout_ms: 50 });
    const firstPolls = firstFetch.secondPoll;
    let firstHandlerCalls = 0;
    await firstChannel.start(async () => { firstHandlerCalls += 1; });
    await firstPolls;
    await firstChannel.stop();
    expect(firstHandlerCalls).toBe(1);
    expect(firstRequests[0]).toBe(0);
    expect(firstRequests[1]).toBe(78);
    store.close();

    const reopened = new GatewayTelegramUpdateStore(filepath, "fixture-bot-token");
    const restartedRequests: number[] = [];
    const restartedFetch = repeatedUpdateFetch(update, restartedRequests);
    const restartedChannel = new TelegramChannel({ bot_token: "fixture-bot-token", inbox: reopened,
      fetch: restartedFetch.fetch, poll_interval_ms: 1, poll_timeout_sec: 1, request_timeout_ms: 50 });
    const restartedPolls = restartedFetch.secondPoll;
    let replayedHandlerCalls = 0;
    try {
      await restartedChannel.start(async () => { replayedHandlerCalls += 1; });
      await restartedPolls;
      await restartedChannel.stop();
      expect(replayedHandlerCalls).toBe(0);
      expect(restartedRequests[0]).toBe(78);
      expect(reopened.latestUpdateId()).toBe(77);
    } finally {
      await restartedChannel.stop();
      reopened.close();
    }
  });
});

function repeatedUpdateFetch(
  update: { update_id: number; message: { message_id: number; text: string; chat: { id: number }; from: { id: number } } },
  offsets: number[],
): { fetch: TelegramFetch; secondPoll: Promise<void> } {
  let pollCount = 0;
  let resolveSecondPoll!: () => void;
  const secondPoll = new Promise<void>((resolve) => { resolveSecondPoll = resolve; });
  const fetch: TelegramFetch = async (_input, init) => {
    pollCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: unknown };
    offsets.push(typeof body.offset === "number" ? body.offset : 0);
    if (pollCount === 2) resolveSecondPoll();
    return new Response(JSON.stringify({ ok: true, result: [update] }));
  };
  return { fetch, secondPoll };
}
