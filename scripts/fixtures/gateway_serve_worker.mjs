import { serve } from "../../apps/gateway/dist/serve.js";

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
