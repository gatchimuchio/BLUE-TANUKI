import { serve } from "../../apps/gateway/dist/serve.js";
import { createGmailWriteTool, gmailWriteTool } from "../../packages/blue-tanuki/dist/index.js";

const fixtureGmailEndpoint = process.env.BLUE_TANUKI_FIXTURE_GMAIL_ENDPOINT;
if (fixtureGmailEndpoint) {
  const fixtureTool = createGmailWriteTool({
    env: { GMAIL_ACCESS_TOKEN: process.env.BLUE_TANUKI_FIXTURE_GMAIL_TOKEN },
    request: async (target) => {
      const profileRead = target.path === "/gmail/v1/users/me/profile";
      const response = await fetch(new URL(profileRead ? "/profile" : "/send", fixtureGmailEndpoint), {
        method: target.method,
        headers: profileRead ? { authorization: `Bearer ${target.token}` } : {
          authorization: `Bearer ${target.token}`,
          "content-type": target.contentType ?? "application/json",
          "idempotency-key": target.idempotency_key,
          "x-command-digest": target.command_digest,
          "x-google-path": target.path,
          "x-fixture-payload-digest": process.env.BLUE_TANUKI_FIXTURE_GMAIL_PAYLOAD_DIGEST,
        },
        ...(target.body !== undefined ? { body: target.body } : {}),
      });
      return {
        status: response.status,
        ok: response.ok,
        content_type: response.headers.get("content-type"),
        body: await response.text(),
        truncated: false,
        request_id: response.headers.get("x-request-id"),
      };
    },
  });
  Object.assign(gmailWriteTool, fixtureTool);
}

const gateway = await serve();
let closing = false;

process.on("message", (message) => {
  if (closing || !message || typeof message !== "object" || message.type !== "shutdown") return;
  closing = true;
  void gateway.shutdown().then(() => {
    if (process.connected) process.send?.({ type: "shutdown_complete" });
    process.disconnect?.();
  }, () => {
    process.exitCode = 1;
    if (process.connected) process.send?.({ type: "shutdown_failed" });
    process.disconnect?.();
  });
});

process.send?.({ type: "ready" });
