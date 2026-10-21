import { describe, expect, it } from "vitest";
import type { InboundEphemeralContext } from "@blue-tanuki/channel-base";
import type { InboundRequest } from "@blue-tanuki/protocol";
import { TelegramChannel, splitTelegramText, type TelegramFetch, type TelegramUpdateInbox } from "../src/telegram.js";

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
    document?: { file_id: string; file_unique_id?: string; file_name?: string; file_size?: number; mime_type?: string };
  };
}

async function receiveOnePoll(updates: FixtureUpdate[], telegramFile?: { file_path: string; bytes: Uint8Array; reported_size?: number }): Promise<{
  received: InboundRequest[];
  ephemeralContexts: InboundEphemeralContext[];
  imageSnapshots: Array<{
    request_id: string;
    ephemeral_images: Array<{ media_type: string; data: number[] }>;
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
  const channel = new TelegramChannel({
    bot_token: "fixture-token",
    poll_interval_ms: 1,
    poll_timeout_sec: 1,
    request_timeout_ms: 50,
    fetch,
    inbox,
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
    }
  });
  await secondPoll;
  await channel.stop();
  return { received, ephemeralContexts, imageSnapshots, offsets, inbox, fileRequests, fileDownloads };
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
      request_timeout_ms: 50, fetch, inbox });
    await channel.start(async () => { throw new Error("synthetic handler failure"); });
    await secondPoll;
    await channel.stop();
    expect(inbox.state()).toBe("outcome_unknown");
    expect(offsets[1]).toBe(32);
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
