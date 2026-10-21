import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@blue-tanuki/protocol";
import { TelegramChannel, type TelegramFetch } from "../src/telegram.js";

interface FixtureUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number | string; username?: string; first_name?: string; is_bot?: boolean };
  };
}

async function receiveOnePoll(updates: FixtureUpdate[]): Promise<{
  received: InboundRequest[];
  offsets: Array<number | null>;
}> {
  const received: InboundRequest[] = [];
  const offsets: Array<number | null> = [];
  let pollCount = 0;
  let resolveSecondPoll!: () => void;
  const secondPoll = new Promise<void>((resolve) => { resolveSecondPoll = resolve; });
  const fetch: TelegramFetch = async (_input, init) => {
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

  const channel = new TelegramChannel({
    bot_token: "fixture-token",
    poll_interval_ms: 1,
    poll_timeout_sec: 1,
    request_timeout_ms: 50,
    fetch,
  });
  await channel.start(async (request) => { received.push(request); });
  await secondPoll;
  await channel.stop();
  return { received, offsets };
}

describe("Telegram inbound identity and update handoff", () => {
  it("uses the stable Telegram sender id when the display username changes", async () => {
    const { received } = await receiveOnePoll([
      { update_id: 10, message: { message_id: 1, text: "first", chat: { id: -1007 }, from: { id: 12345, username: "old_name" } } },
      { update_id: 11, message: { message_id: 2, text: "second", chat: { id: -1007 }, from: { id: 12345, username: "new_name" } } },
    ]);

    expect(received).toHaveLength(2);
    expect(received.map((request) => request.user)).toEqual(["telegram:12345", "telegram:12345"]);
    expect(received.map((request) => request.metadata?.reply_to)).toEqual(["-1007", "-1007"]);
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
});
