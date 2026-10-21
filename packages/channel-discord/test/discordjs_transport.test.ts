import { describe, expect, it } from "vitest";
import { DiscordJsTransport } from "../src/discordjs_transport.js";

function transportWithSendFailure(error: unknown): DiscordJsTransport {
  const transport = new DiscordJsTransport({ bot_token: "synthetic-token" });
  (transport as unknown as { client: unknown }).client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async () => { throw error; },
      }),
    },
  };
  return transport;
}

describe("DiscordJsTransport delivery classification", () => {
  it("sends a reply through Discord's native message reference option", async () => {
    const transport = new DiscordJsTransport({ bot_token: "synthetic-token" });
    let posted: unknown;
    (transport as unknown as { client: unknown }).client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async (payload: unknown) => { posted = payload; return { id: "987654321" }; },
        }),
      },
    };
    await expect(transport.postMessage({ channel: "123456789", text: "reply", reply_to_message_id: "555666777" }))
      .resolves.toEqual({ ok: true, message_id: "987654321" });
    expect(posted).toEqual({ content: "reply", reply: { messageReference: "555666777" } });
  });

  it("marks only an HTTP 429 as an explicit rate-limit rejection and rejects invalid Retry-After", async () => {
    const transport = transportWithSendFailure(Object.assign(new Error("rate limited"), {
      status: 429,
      rawError: { retry_after: 0 },
    }));
    await expect(transport.postMessage({ channel: "123456789", text: "synthetic" })).resolves.toMatchObject({
      ok: false,
      delivery_status: "not_delivered",
      rate_limit_rejected: true,
      retry_after_invalid: true,
    });
  });

  it("recognizes discord.js's route-queue RateLimitError as a confirmed rejection", async () => {
    const transport = transportWithSendFailure(Object.assign(new Error("route rate limit"), {
      name: "RateLimitError",
      retryAfter: 275,
    }));
    await expect(transport.postMessage({ channel: "123456789", text: "synthetic" })).resolves.toMatchObject({
      ok: false,
      delivery_status: "not_delivered",
      rate_limit_rejected: true,
      retry_after_invalid: false,
      retry_after_ms: 275,
    });
  });

  it("keeps server and transport failures outcome-unknown", async () => {
    const transport = transportWithSendFailure(Object.assign(new Error("remote failure"), { status: 503 }));
    await expect(transport.postMessage({ channel: "123456789", text: "synthetic" })).resolves.toMatchObject({
      ok: false,
      delivery_status: "unknown",
    });
  });
});
