import { describe, expect, it, vi } from "vitest";
import type { InboundEphemeralContext, SendResult } from "@blue-tanuki/channel-base";
import type { InboundRequest } from "@blue-tanuki/protocol";
import {
  TelegramChannel,
  splitTelegramText,
  type TelegramFetch,
  type TelegramInboundGrant,
  type TelegramUpdateInbox,
} from "../src/telegram.js";

interface FixtureUpdate {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    text?: string;
    caption?: string;
    chat: { id: number | string; type?: string };
    from?: { id: number | string; username?: string; first_name?: string; is_bot?: boolean };
    photo?: Array<{ file_id: string; file_unique_id?: string; file_size?: number; width?: number; height?: number }>;
    audio?: { file_id: string; file_size?: number; mime_type?: string };
    voice?: { file_id: string; file_size?: number; mime_type?: string };
    document?: { file_id: string; file_unique_id?: string; file_name?: string; file_size?: number; mime_type?: string };
  };
}

async function receiveOnePoll(
  updates: FixtureUpdate[],
  telegramFile?: { file_path: string; bytes: Uint8Array; reported_size?: number },
  inboundGrants?: readonly TelegramInboundGrant[],
): Promise<{
  received: InboundRequest[];
  ephemeralContexts: InboundEphemeralContext[];
  imageSnapshots: Array<{
    request_id: string;
    ephemeral_images: Array<{ media_type: string; data: number[] }>;
  }>;
  audioSnapshots: Array<{
    request_id: string;
    ephemeral_audio: Array<{ format: string; data: number[] }>;
  }>;
  offsets: Array<number | null>;
  inbox: MemoryTelegramInbox;
  fileRequests: string[];
  fileDownloads: string[];
}> {
  const received: InboundRequest[] = [];
  const ephemeralContexts: InboundEphemeralContext[] = [];
  const imageSnapshots: Array<{
    request_id: string;
    ephemeral_images: Array<{ media_type: string; data: number[] }>;
  }> = [];
  const audioSnapshots: Array<{
    request_id: string;
    ephemeral_audio: Array<{ format: string; data: number[] }>;
  }> = [];
  const offsets: Array<number | null> = [];
  const fileRequests: string[] = [];
  const fileDownloads: string[] = [];
  let pollCount = 0;
  let resolveSecondPoll!: () => void;
  const secondPoll = new Promise<void>((resolve) => { resolveSecondPoll = resolve; });
  const fetch: TelegramFetch = async (_input, init) => {
    const url = String(_input);
    if (url.endsWith("/getFile")) {
      const request = JSON.parse(String(init?.body ?? "{}")) as { file_id?: unknown };
      fileRequests.push(String(request.file_id ?? ""));
      return new Response(JSON.stringify({ ok: true, result: telegramFile ? {
        file_path: telegramFile.file_path, file_size: telegramFile.reported_size ?? telegramFile.bytes.byteLength,
      } : {} }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/file/botfixture-token/")) {
      fileDownloads.push(url);
      return new Response(telegramFile?.bytes ?? new Uint8Array(), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    pollCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: unknown };
    offsets.push(typeof body.offset === "number" ? body.offset : null);
    if (pollCount === 1) {
      return new Response(JSON.stringify({ ok: true, result: updates }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (pollCount === 2) resolveSecondPoll();
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      headers: { "content-type": "application/json" },
    });
  };

  const inbox = new MemoryTelegramInbox();
  const testGrants = inboundGrants ?? updates.flatMap(({ message }) => {
    const userId = message?.from?.id;
    const chatId = message?.chat.id;
    if (userId === undefined || chatId === undefined) return [];
    return [{
      user_id: String(userId),
      chat_id: String(chatId),
      message_thread_id: message.message_thread_id ?? null,
    }];
  });
  const channel = new TelegramChannel({
    bot_token: "fixture-token",
    poll_interval_ms: 1,
    poll_timeout_sec: 1,
    request_timeout_ms: 50,
    fetch,
    inbox,
    inbound_grants: testGrants,
  });
  await channel.start(async (request, context) => {
    received.push(request);
    if (context) {
      ephemeralContexts.push(context);
      imageSnapshots.push({
        request_id: context.request_id,
        ephemeral_images: context.ephemeral_images.map((image) => ({
          media_type: image.media_type,
          data: Array.from(image.data),
        })),
      });
      if (context.ephemeral_audio?.length) {
        audioSnapshots.push({
          request_id: context.request_id,
          ephemeral_audio: context.ephemeral_audio.map((audio) => ({
            format: audio.format,
            data: Array.from(audio.data),
          })),
        });
      }
    }
  });
  await secondPoll;
  await channel.stop();
  return { received, ephemeralContexts, imageSnapshots, audioSnapshots, offsets, inbox, fileRequests, fileDownloads };
}

class MemoryTelegramInbox implements TelegramUpdateInbox {
  private current: { update_id: number; digest: string; state: "dispatching" | "handler_returned" | "outcome_unknown" } | null = null;
  latestUpdateId(): number | null { return this.current?.update_id ?? null; }
  claim(updateId: number, payloadDigest: string) {
    if (this.current && updateId < this.current.update_id) return { status: "stale" } as const;
    if (this.current && updateId === this.current.update_id) {
      if (payloadDigest !== this.current.digest) return { status: "identity_conflict" } as const;
      return { status: "duplicate", delivery_state: this.current.state } as const;
    }
    if (this.current?.state === "dispatching") return { status: "blocked_unresolved", delivery_state: "dispatching" } as const;
    this.current = { update_id: updateId, digest: payloadDigest, state: "dispatching" };
    return { status: "accepted" } as const;
  }
  settle(updateId: number, payloadDigest: string, state: "handler_returned" | "outcome_unknown"): void {
    if (!this.current || this.current.update_id !== updateId || this.current.digest !== payloadDigest) throw new Error("fixture identity mismatch");
    this.current.state = state;
  }
  state(): string | null { return this.current?.state ?? null; }
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function telegramResult(result: unknown): Response {
  return Response.json({ ok: true, result });
}

async function idlePoll(signal?: AbortSignal | null): Promise<Response> {
  if (signal && !signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  return telegramResult([]);
}

function fixtureMessage(updateId: number, text: string): FixtureUpdate {
  return { update_id: updateId, message: { message_id: updateId, text,
    chat: { id: 12345, type: "private" }, from: { id: 12345 } } };
}

const lifecycleGrant = { user_id: "12345", chat_id: "12345", message_thread_id: null } as const;

describe("Telegram inbound identity and update handoff", () => {
  it("refuses live polling without the Gateway durable inbox", async () => {
    const channel = new TelegramChannel({ bot_token: "fixture-token" });
    await expect(channel.start(async () => {})).rejects.toThrow("telegram_durable_inbox_required_for_live_polling");
  });

  it("does not log silent-mode message contents or destination IDs", async () => {
    const logs: string[] = [];
    const channel = new TelegramChannel({ log: (line) => logs.push(line) });
    await channel.start(async () => {});
    await channel.send({ channel: "telegram", target: "private-destination-id", content: "private message body" },
      { command_id: "fixture", upstream_commit_hash: "a".repeat(64) });
    expect(logs.join(" ")).not.toContain("private message body");
    expect(logs.join(" ")).not.toContain("private-destination-id");
    expect(logs.join(" ")).toContain("content_chars=20");
    await channel.stop();
  });

  it("uses the stable Telegram sender id when the display username changes", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 10, message: { message_id: 1, text: "first", chat: { id: 12345, type: "private" }, from: { id: 12345, username: "old_name" } } },
      { update_id: 11, message: { message_id: 2, text: "second", chat: { id: 12345, type: "private" }, from: { id: 12345, username: "new_name" } } },
    ]);

    expect(received).toHaveLength(2);
    expect(received.map((request) => request.user)).toEqual(["telegram:12345", "telegram:12345"]);
    expect(received.map((request) => request.metadata?.reply_to)).toEqual(["12345", "12345"]);
    expect(received.map((request) => request.metadata?.telegram_user_id)).toEqual(["12345", "12345"]);
  });

  it("admits only the exact owner-granted user, chat, and topic tuple", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 101, message: { message_id: 1, message_thread_id: 41, text: "allowed", chat: { id: -1001 }, from: { id: 12345 } } },
      { update_id: 102, message: { message_id: 2, message_thread_id: 42, text: "wrong topic", chat: { id: -1001 }, from: { id: 12345 } } },
      { update_id: 103, message: { message_id: 3, message_thread_id: 41, text: "wrong user", chat: { id: -1001 }, from: { id: 54321 } } },
      { update_id: 104, message: { message_id: 4, message_thread_id: 41, text: "wrong chat", chat: { id: -1002 }, from: { id: 12345 } } },
    ], undefined, [{ user_id: "12345", chat_id: "-1001", message_thread_id: 41 }]);

    expect(received.map((request) => request.content)).toEqual(["allowed"]);
    expect(received[0]?.user).toContain(":chat:-1001:thread:41");
  });

  it("rejects ungranted attachments before requesting or downloading their files", async () => {
    const { received, fileRequests, fileDownloads } = await receiveOnePoll([
      { update_id: 105, message: { message_id: 5, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "untrusted-file-capability", file_name: "private.txt", file_size: 8, mime_type: "text/plain" } } },
    ], { file_path: "documents/file_5.txt", bytes: new TextEncoder().encode("private") }, []);

    expect(received).toHaveLength(0);
    expect(fileRequests).toEqual([]);
    expect(fileDownloads).toEqual([]);
  });

  it("hands a repeated update id to Gateway only once in one polling process", async () => {
    const { received, offsets } = await receiveOnePoll([
      { update_id: 7, message: { message_id: 2, text: "one event", chat: { id: 12345 }, from: { id: 12345 } } },
      { update_id: 7, message: { message_id: 2, text: "one event", chat: { id: 12345 }, from: { id: 12345 } } },
    ]);

    expect(received).toHaveLength(1);
    expect(offsets[1]).toBe(8);
  });

  it("does not attribute a message without a stable sender id", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 20, message: { message_id: 5, text: "anonymous", chat: { id: -1007 } } },
    ]);

    expect(received).toHaveLength(0);
  });

  it("keeps unsupported attachment presence explicit without retaining Telegram file identifiers", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 21, message: { message_id: 8, chat: { id: -1007 }, from: { id: 12345 },
        document: { file_id: "private-file-capability", file_name: "secret.txt" } } },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toContain("未対応形式");
    expect(received[0]?.metadata?.telegram_attachment_kinds).toEqual(["document"]);
    expect(received[0]?.metadata?.telegram_attachment_content_available).toBe(false);
    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("unsupported_type");
    expect(JSON.stringify(received[0])).not.toContain("private-file-capability");
    expect(JSON.stringify(received[0])).not.toContain("secret.txt");
  });

  it("passes bounded UTF-8 text documents to Gateway as explicitly untrusted content", async () => {
    const bytes = new TextEncoder().encode("決定事項: 青\n未確認: 期限");
    const { received, fileRequests } = await receiveOnePoll([
      { update_id: 22, message: { message_id: 9, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "private-file-capability", file_name: "secret.txt", file_size: bytes.byteLength, mime_type: "text/plain" } } },
    ], { file_path: "documents/file_1.txt", bytes });

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toContain("未信頼データ");
    expect(received[0]?.content).toContain(JSON.stringify("決定事項: 青\n未確認: 期限"));
    expect(received[0]?.metadata?.telegram_attachment_content_available).toBe(true);
    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("read");
    expect(fileRequests).toEqual(["private-file-capability"]);
    expect(JSON.stringify(received[0])).not.toContain("private-file-capability");
    expect(JSON.stringify(received[0])).not.toContain("secret.txt");
  });

  it("passes verified Telegram image bytes only through a request-scoped ephemeral context", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);
    const { received, ephemeralContexts, imageSnapshots, fileRequests } = await receiveOnePoll([
      { update_id: 221, message: { message_id: 91, caption: "この画像を説明して", chat: { id: 12345, type: "private" }, from: { id: 12345 },
        photo: [{ file_id: "private-photo-capability", file_size: bytes.byteLength, width: 2, height: 2 }] } },
    ], { file_path: "photos/file_91.jpg", bytes });

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toContain("Telegram画像添付があります");
    expect(received[0]?.content).toContain("この画像を説明して");
    expect(received[0]?.metadata?.telegram_attachment_image_available).toBe(true);
    expect(imageSnapshots).toEqual([{
      request_id: "telegram-221",
      ephemeral_images: [{ media_type: "image/jpeg", data: Array.from(bytes) }],
    }]);
    expect(fileRequests).toEqual(["private-photo-capability"]);
    expect(JSON.stringify(received[0])).not.toContain("private-photo-capability");
    expect(JSON.stringify(received[0])).not.toContain("file_91.jpg");
    expect(ephemeralContexts[0]?.request_id).toBe(received[0]?.id);
    expect(ephemeralContexts[0]?.ephemeral_images[0]?.data.every((byte) => byte === 0)).toBe(true);
  });

  it("fails closed when an image document's declared MIME disagrees with its bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const { received, ephemeralContexts } = await receiveOnePoll([
      { update_id: 222, message: { message_id: 92, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "private-image-capability", file_name: "private.png", file_size: bytes.byteLength,
          mime_type: "image/png" } } },
    ], { file_path: "documents/file_92.png", bytes });

    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("invalid_content");
    expect(received[0]?.metadata?.telegram_attachment_image_available).toBe(false);
    expect(received[0]?.content).toContain("画像データを渡しませんでした");
    expect(ephemeralContexts).toHaveLength(0);
    expect(JSON.stringify(received[0])).not.toContain("private-image-capability");
    expect(JSON.stringify(received[0])).not.toContain("private.png");
  });

  it("passes verified Telegram voice bytes only in a request-scoped ephemeral context and clears them", async () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x01, 0x02]);
    const { received, ephemeralContexts, audioSnapshots, fileRequests } = await receiveOnePoll([
      { update_id: 223, message: { message_id: 93, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        voice: { file_id: "private-voice-capability", file_size: bytes.byteLength, mime_type: "audio/ogg" } } },
    ], { file_path: "voice/file_93.oga", bytes });

    expect(received[0]?.content).toContain("文字起こし候補");
    expect(received[0]?.content).toContain("承認・権限の証拠にはしません");
    expect(received[0]?.metadata?.telegram_attachment_audio_available).toBe(true);
    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("read");
    expect(audioSnapshots).toEqual([{
      request_id: "telegram-223",
      ephemeral_audio: [{ format: "ogg", data: Array.from(bytes) }],
    }]);
    expect(fileRequests).toEqual(["private-voice-capability"]);
    expect(JSON.stringify(received[0])).not.toContain("private-voice-capability");
    expect(JSON.stringify(received[0])).not.toContain("file_93.oga");
    expect(ephemeralContexts[0]?.ephemeral_audio?.[0]?.data.every((byte) => byte === 0)).toBe(true);
  });

  it("does not download declared text attachments above the local byte limit", async () => {
    const { received, fileRequests } = await receiveOnePoll([
      { update_id: 23, message: { message_id: 10, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "private-file-capability", file_size: 65_537, mime_type: "text/plain" } } },
    ]);

    expect(received[0]?.content).toContain("上限");
    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("too_large");
    expect(fileRequests).toEqual([]);
  });

  it("enforces the byte limit on the downloaded stream even when Telegram reports a smaller size", async () => {
    const bytes = new Uint8Array(65_537);
    const { received } = await receiveOnePoll([
      { update_id: 24, message: { message_id: 11, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "private-file-capability", file_size: 1, mime_type: "text/plain" } } },
    ], { file_path: "documents/file_2.txt", bytes, reported_size: 1 });

    expect(received[0]?.content).toContain("上限");
    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("too_large");
    expect(received[0]?.content).not.toContain("\u0000");
  });

  it("rejects an unsafe Telegram file path before sending the token-bearing download request", async () => {
    const { received, fileDownloads } = await receiveOnePoll([
      { update_id: 25, message: { message_id: 12, chat: { id: 12345, type: "private" }, from: { id: 12345 },
        document: { file_id: "private-file-capability", file_size: 1, mime_type: "text/plain" } } },
    ], { file_path: "../../outside", bytes: new TextEncoder().encode("x") });

    expect(received[0]?.metadata?.telegram_attachment_processing_status).toBe("unavailable");
    expect(received[0]?.content).toContain("未読取");
    expect(fileDownloads).toEqual([]);
  });

  it("scopes the same sender to each group chat entry", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 24, message: { message_id: 1, text: "first group", chat: { id: -1001, type: "supergroup" }, from: { id: 12345 } } },
      { update_id: 25, message: { message_id: 2, text: "second group", chat: { id: -1002, type: "supergroup" }, from: { id: 12345 } } },
    ]);
    expect(received.map((request) => request.user)).toEqual([
      "telegram:12345:chat:-1001",
      "telegram:12345:chat:-1002",
    ]);
  });

  it("scopes forum topics independently and routes the reply back to the same topic", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 26, message: { message_id: 1, message_thread_id: 41, text: "topic one",
        chat: { id: -1001, type: "supergroup" }, from: { id: 12345 } } },
      { update_id: 27, message: { message_id: 2, message_thread_id: 42, text: "topic two",
        chat: { id: -1001, type: "supergroup" }, from: { id: 12345 } } },
    ]);
    expect(received.map((request) => request.user)).toEqual([
      "telegram:12345:chat:-1001:thread:41",
      "telegram:12345:chat:-1001:thread:42",
    ]);
    expect(received.map((request) => request.metadata?.reply_to)).toEqual(["-1001|41", "-1001|42"]);
  });

  it("marks a thrown Gateway handler outcome unknown and advances only after recording it", async () => {
    const request: FixtureUpdate = { update_id: 31, message: { message_id: 9, text: "synthetic", chat: { id: 12345 }, from: { id: 12345 } } };
    const inbox = new MemoryTelegramInbox();
    const offsets: Array<number | null> = [];
    let pollCount = 0;
    let resolveSecondPoll!: () => void;
    const secondPoll = new Promise<void>((resolve) => { resolveSecondPoll = resolve; });
    const fetch: TelegramFetch = async (_input, init) => {
      pollCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: unknown };
      offsets.push(typeof body.offset === "number" ? body.offset : null);
      if (pollCount === 1) return new Response(JSON.stringify({ ok: true, result: [request] }));
      if (pollCount === 2) resolveSecondPoll();
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", poll_interval_ms: 1, poll_timeout_sec: 1,
      request_timeout_ms: 50, fetch, inbox,
      inbound_grants: [{ user_id: "12345", chat_id: "12345", message_thread_id: null }] });
    await channel.start(async () => { throw new Error("synthetic handler failure"); });
    await secondPoll;
    await channel.stop();
    expect(inbox.state()).toBe("outcome_unknown");
    expect(offsets[1]).toBe(32);
  });
});

describe("Telegram inbound stop and restart", () => {
  it("aborts the old long poll and claims a late reply only when replayed into the restarted poll", async () => {
    const update = fixtureMessage(71, "synthetic restart update");
    const oldRequest = deferred<AbortSignal | null | undefined>();
    const oldResponse = deferred<Response>();
    const restartedRequest = deferred<void>();
    const restartedResponse = deferred<Response>();
    const afterDispatch = deferred<void>();
    const offsets: Array<number | null> = [];
    const inbox = new MemoryTelegramInbox();
    const claim = vi.spyOn(inbox, "claim");
    const oldHandler = vi.fn(async () => {});
    const currentHandler = vi.fn(async () => {});
    const fetch: TelegramFetch = async (input, init) => {
      expect(String(input)).toMatch(/\/getUpdates$/u);
      const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: number };
      offsets.push(body.offset ?? null);
      if (offsets.length === 1) {
        oldRequest.resolve(init?.signal);
        return oldResponse.promise;
      }
      if (offsets.length === 2) {
        restartedRequest.resolve();
        return restartedResponse.promise;
      }
      afterDispatch.resolve();
      return idlePoll(init?.signal);
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", request_timeout_ms: 2000,
      inbound_grants: [lifecycleGrant], fetch, inbox });
    try {
      await channel.start(oldHandler);
      const signal = await oldRequest.promise;
      expect(signal?.aborted).toBe(false);
      const stopping = channel.stop();
      await channel.start(currentHandler);
      await restartedRequest.promise;
      await stopping;
      expect(signal?.aborted).toBe(true);

      // Simulate an HTTP producer that returns even after its signal is canceled.
      oldResponse.resolve(telegramResult([update]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(offsets).toEqual([null, null]);
      expect(claim).not.toHaveBeenCalled();
      expect(oldHandler).not.toHaveBeenCalled();

      restartedResponse.resolve(telegramResult([update]));
      await afterDispatch.promise;
      expect(claim.mock.calls).toEqual([[71, expect.any(String)]]);
      expect(currentHandler.mock.calls).toEqual([[expect.objectContaining({ id: "telegram-71" }), undefined]]);
      expect(inbox.state()).toBe("handler_returned");
      expect(offsets[2]).toBe(72);
    } finally {
      await channel.stop();
      oldResponse.resolve(telegramResult([]));
      restartedResponse.resolve(telegramResult([]));
    }
  });

  it("preserves a claimed attachment as outcome unknown and refuses a download after stop", async () => {
    const update: FixtureUpdate = { update_id: 81, message: { message_id: 81,
      chat: { id: 12345, type: "private" }, from: { id: 12345 },
      document: { file_id: "synthetic-text", file_name: "note.txt", mime_type: "text/plain", file_size: 8 } } };
    const fileRequest = deferred<AbortSignal | null | undefined>();
    const fileResponse = deferred<Response>();
    const inbox = new MemoryTelegramInbox();
    const settle = vi.spyOn(inbox, "settle");
    const handler = vi.fn(async () => {});
    let pollCount = 0;
    let downloads = 0;
    const fetch: TelegramFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        pollCount += 1;
        return pollCount === 1 ? telegramResult([update]) : idlePoll(init?.signal);
      }
      if (url.endsWith("/getFile")) {
        fileRequest.resolve(init?.signal);
        return fileResponse.promise;
      }
      downloads += 1;
      return new Response("fixture!", { headers: { "content-type": "text/plain" } });
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", request_timeout_ms: 2000,
      inbound_grants: [lifecycleGrant], fetch, inbox });
    try {
      await channel.start(handler);
      const signal = await fileRequest.promise;
      expect(signal?.aborted).toBe(false);
      expect(inbox.latestUpdateId()).toBe(81);
      expect(inbox.state()).toBe("dispatching");

      await channel.stop();
      expect(signal?.aborted).toBe(true);
      expect(inbox.state()).toBe("outcome_unknown");
      fileResponse.resolve(telegramResult({ file_path: "documents/note.txt", file_size: 8 }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(pollCount).toBe(1);
      expect(downloads).toBe(0);
      expect(handler).not.toHaveBeenCalled();
      expect(settle.mock.calls).toEqual([[81, expect.any(String), "outcome_unknown"]]);
    } finally {
      await channel.stop();
      fileResponse.resolve(telegramResult({}));
    }
  });

  it("preserves an active handler as outcome unknown and suppresses the old batch after restart", async () => {
    const first = fixtureMessage(91, "synthetic in-flight handler");
    const next = fixtureMessage(92, "synthetic following message");
    const handlerEntered = deferred<void>();
    const releaseOldHandler = deferred<void>();
    const afterDispatch = deferred<void>();
    const oldReply = deferred<SendResult>();
    const newReply = deferred<SendResult>();
    const outbound: string[] = [];
    const meta = { command_id: "fixture", upstream_commit_hash: "a".repeat(64) };
    const oldHandler = vi.fn(async () => {
      handlerEntered.resolve();
      await releaseOldHandler.promise;
      oldReply.resolve(await channel.send({ channel: "telegram", target: "12345", content: "old reply" }, meta));
    });
    const currentHandler = vi.fn(async () => {
      newReply.resolve(await channel.send({ channel: "telegram", target: "12345", content: "new reply" }, meta));
    });
    const inbox = new MemoryTelegramInbox();
    const claim = vi.spyOn(inbox, "claim");
    const settle = vi.spyOn(inbox, "settle");
    const offsets: Array<number | null> = [];
    const fetch: TelegramFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { offset?: number; text?: string };
      if (String(input).endsWith("/sendMessage")) {
        outbound.push(body.text ?? "");
        return telegramResult({ message_id: 100 + outbound.length });
      }
      expect(String(input)).toMatch(/\/getUpdates$/u);
      offsets.push(body.offset ?? null);
      if (offsets.length <= 2) return telegramResult([first, next]);
      afterDispatch.resolve();
      return idlePoll(init?.signal);
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", request_timeout_ms: 2000,
      inbound_grants: [lifecycleGrant], fetch, inbox });
    try {
      await channel.start(oldHandler);
      await handlerEntered.promise;
      await channel.stop();
      expect(inbox.state()).toBe("outcome_unknown");
      expect(inbox.latestUpdateId()).toBe(91);
      expect(claim.mock.calls).toEqual([[91, expect.any(String)]]);
      const stopped = await channel.send({ channel: "telegram", target: "12345", content: "stopped reply" }, meta);
      expect(stopped).toMatchObject({ delivered: false, delivery_status: "not_delivered", error_code: "cancelled_before_dispatch" });

      await channel.start(currentHandler);
      await afterDispatch.promise;
      expect(offsets).toEqual([null, 92, 93]);
      expect(currentHandler.mock.calls).toEqual([[expect.objectContaining({ id: "telegram-92" }), undefined]]);
      expect(await newReply.promise).toMatchObject({ delivered: true, external_id: "telegram-101" });

      releaseOldHandler.resolve();
      expect(await oldReply.promise).toMatchObject({ delivered: false, delivery_status: "not_delivered", error_code: "cancelled_before_dispatch" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outbound).toEqual(["new reply"]);
      expect(oldHandler.mock.calls).toEqual([[expect.objectContaining({ id: "telegram-91" }), undefined]]);
      expect(claim.mock.calls.map(([id]) => id)).toEqual([91, 91, 92]);
      expect(settle.mock.calls).toEqual([
        [91, expect.any(String), "outcome_unknown"],
        [92, expect.any(String), "handler_returned"],
      ]);
      expect(inbox.latestUpdateId()).toBe(92);
      expect(inbox.state()).toBe("handler_returned");
    } finally {
      await channel.stop();
      releaseOldHandler.resolve();
    }
  });
});

describe("Telegram outbound stop and acknowledgement", () => {
  const meta = { command_id: "fixture", upstream_commit_hash: "a".repeat(64) };

  it("keeps an admitted update stopped across Gateway stop-signal rotation during attachment normalization", async () => {
    let gatewayStop = new AbortController();
    const attachmentRequested = deferred<void>();
    const attachmentResponse = deferred<Response>();
    const oldReply = deferred<SendResult>();
    const currentReply = deferred<SendResult>();
    const oldUpdate = fixtureMessage(101, "previous input");
    oldUpdate.message!.document = { file_id: "fixture-file", file_name: "note.txt", mime_type: "text/plain", file_size: 8 };
    let polls = 0;
    const sent: string[] = [];
    const fetch: TelegramFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        return polls === 1
          ? telegramResult([oldUpdate, fixtureMessage(102, "fresh input")])
          : idlePoll(init?.signal);
      }
      if (url.endsWith("/getFile")) {
        attachmentRequested.resolve();
        return attachmentResponse.promise;
      }
      if (url.endsWith("/documents/note.txt")) return new Response("fixture!");
      const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      sent.push(body.text);
      return telegramResult({ message_id: 200 + sent.length });
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", outbound_stop_signal: () => gatewayStop.signal,
      fetch, inbox: new MemoryTelegramInbox(), inbound_grants: [lifecycleGrant] });
    try {
      await channel.start(async (request) => {
        if (request.id === "telegram-101") {
          oldReply.resolve(await channel.send({ channel: "telegram", target: "12345", content: "old" }, meta));
          return;
        }
        currentReply.resolve(await channel.send({ channel: "telegram", target: "12345", content: "current" }, meta));
      });
      await attachmentRequested.promise;
      gatewayStop.abort();
      expect(await channel.send({ channel: "telegram", target: "12345", content: "blocked" }, meta)).toMatchObject({
        delivered: false, delivery_status: "not_delivered", error_code: "cancelled_before_dispatch",
      });
      gatewayStop = new AbortController();
      attachmentResponse.resolve(telegramResult({ file_path: "documents/note.txt", file_size: 8 }));
      expect(await oldReply.promise).toMatchObject({ delivered: false, delivery_status: "not_delivered", error_code: "cancelled_before_dispatch" });
      expect(await currentReply.promise).toMatchObject({ delivered: true, external_id: "telegram-201" });
      expect(sent).toEqual(["current"]);
    } finally {
      attachmentResponse.resolve(telegramResult({}));
      await channel.stop();
    }
  });

  it("settles a partial pre-start send as unknown when stopped and discards a late acknowledgement", async () => {
    let sends = 0;
    const reached = deferred<AbortSignal | null | undefined>();
    const lateResponse = deferred<Response>();
    const fetch: TelegramFetch = async (_input, init) => {
      sends += 1;
      if (sends === 1) return telegramResult({ message_id: 301 });
      reached.resolve(init?.signal);
      return lateResponse.promise;
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", fetch, request_timeout_ms: 2000 });
    const result = channel.send({ channel: "telegram", target: "12345", content: "x".repeat(8193) }, meta);
    try {
      const signal = await reached.promise;
      expect(signal?.aborted).toBe(false);
      await channel.stop();
      expect(signal?.aborted).toBe(true);
      expect(await result).toMatchObject({ delivered: false, delivery_status: "unknown", error: "telegram_partial_delivery_unknown",
        error_code: "delivery_outcome_unknown" });
      lateResponse.resolve(telegramResult({ message_id: 302 }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sends).toBe(2);
      expect(channel.getHistory().filter(entry => entry.ok).map(entry => entry.external_id)).toEqual(["telegram-301"]);
    } finally {
      lateResponse.resolve(telegramResult({}));
      await channel.stop();
    }
  });

  it("bounds the send confirmation body and never promotes an acknowledgement that arrives after the deadline", async () => {
    let sentSignal: AbortSignal | null | undefined;
    let responseBody!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: controller => { responseBody = controller; } });
    const fetch: TelegramFetch = async (_input, init) => {
      sentSignal = init?.signal;
      return new Response(stream);
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", fetch, request_timeout_ms: 25 });
    try {
      expect(await channel.send({ channel: "telegram", target: "12345", content: "fixture" }, meta)).toMatchObject({
        delivered: false, delivery_status: "unknown", error_code: "delivery_outcome_unknown",
      });
      expect(sentSignal?.aborted).toBe(true);
    } finally {
      responseBody.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, result: { message_id: 303 } })));
      responseBody.close();
      await channel.stop();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(channel.getHistory().some(entry => entry.ok)).toBe(false);
  });

  it("requires a native message identifier before any subsequent chunk", async () => {
    const fetch = vi.fn<TelegramFetch>(async () => telegramResult({}));
    const channel = new TelegramChannel({ bot_token: "fixture-token", fetch });
    const result = await channel.send({ channel: "telegram", target: "12345", content: "x".repeat(4097) }, meta);
    expect(result).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "delivery_outcome_unknown" });
    expect(result.external_id).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Telegram message splitting", () => {
  it("preserves long text and splits on Unicode code points within the UTF-16 limit", () => {
    const text = `${"line one\n".repeat(600)}${"🙂".repeat(4200)}`;
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
  });

  it("returns an explicit unknown outcome when a later message chunk fails", async () => {
    let sends = 0;
    const fetch: TelegramFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      if (body.text === undefined) throw new Error("missing test text");
      sends += 1;
      return sends === 1
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
        : new Response(JSON.stringify({ ok: false, description: "synthetic failure" }));
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", fetch, inbox: new MemoryTelegramInbox() });
    const result = await channel.send({ channel: "telegram", target: "12345", content: "x".repeat(4097) },
      { command_id: "fixture", upstream_commit_hash: "a".repeat(64) });
    expect(sends).toBe(2);
    expect(result).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "delivery_outcome_unknown" });
  });

  it("blocks redirects and keeps Bot API failure bodies and URLs out of diagnostics", async () => {
    const token = "12345:synthetic-protected-bot-credential";
    const responseDescription = "synthetic private reply context";
    const requestOptions: Array<RequestRedirect | undefined> = [];
    const fetch: TelegramFetch = async (input, init) => {
      requestOptions.push(init?.redirect);
      if (requestOptions.length === 1) {
        return Response.json({ ok: false, description: `${responseDescription} ${token}` }, { status: 403 });
      }
      throw new Error(`request failed for ${String(input)}`);
    };
    const channel = new TelegramChannel({ bot_token: token, fetch });
    const payload = { channel: "telegram", target: "12345", content: "synthetic message" };
    const meta = { command_id: "fixture", upstream_commit_hash: "a".repeat(64) };
    const rejected = await channel.send(payload, meta);
    const unknown = await channel.send(payload, meta);
    expect(requestOptions).toEqual(["error", "error"]);
    expect(rejected).toMatchObject({ delivered: false, delivery_status: "not_delivered", error: "http_403" });
    expect(unknown).toMatchObject({ delivered: false, delivery_status: "unknown", error_code: "delivery_outcome_unknown" });
    const diagnostics = JSON.stringify([rejected, unknown, channel.getHistory()]);
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain(responseDescription);
  });

  it("sends all chunks to the original Telegram forum topic", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetch: TelegramFetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    };
    const channel = new TelegramChannel({ bot_token: "fixture-token", fetch, inbox: new MemoryTelegramInbox() });
    const result = await channel.send({ channel: "telegram", target: "-1001|41", content: "x".repeat(4097) },
      { command_id: "fixture", upstream_commit_hash: "a".repeat(64) });
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent.map((body) => body.message_thread_id)).toEqual([41, 41]);
    expect(sent.every((body) => body.chat_id === "-1001")).toBe(true);
  });
});
