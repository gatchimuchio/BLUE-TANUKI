import { createHash } from "node:crypto";
import { createServer } from "node:http";

const FIXTURE_TOKEN = "local-inspection-only-token";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const accepted = [];
let effects = 0;
let readQueries = 0;
let dropNextResponse = true;

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && /^\/reconcile\/[a-f0-9]{64}$/.test(url.pathname)) {
      readQueries += 1;
      const key = decodeURIComponent(url.pathname.slice("/reconcile/".length));
      const matches = accepted.filter((record) => record.idempotency_key === key);
      const status = matches.length === 0 ? "not_found" : matches.length === 1 ? "accepted" : "ambiguous";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status, matches }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/send" ||
        request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}` ||
        request.headers["x-google-path"] !== "/gmail/v1/users/me/messages/send") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const key = request.headers["idempotency-key"];
    const commandDigest = request.headers["x-command-digest"];
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) ||
        typeof commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(commandDigest) || !body) {
      response.writeHead(400).end();
      return;
    }

    // Deliberately non-idempotent: every POST creates another effect, even when its key repeats.
    effects += 1;
    const record = {
      idempotency_key: key,
      command_digest: commandDigest,
      payload_digest: digest(body),
      receipt_id: `inspection-receipt-${effects}`,
    };
    accepted.push(record);
    if (dropNextResponse) {
      dropNextResponse = false;
      response.destroy();
      return;
    }
    response.writeHead(202, { "content-type": "application/json", "x-request-id": record.receipt_id });
    response.end(JSON.stringify({ id: record.receipt_id, status: "accepted" }));
  })().catch(() => { if (!response.destroyed) response.destroy(); });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.send?.({ type: "startup_error", reason: "inspection_server_address_unavailable" });
    server.close(() => process.exit(1));
    return;
  }
  process.send?.({ type: "ready", url: `http://127.0.0.1:${address.port}` });
});

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "status" && typeof message.request_id === "string") {
    process.send?.({ type: "status", request_id: message.request_id,
      snapshot: { effects, read_queries: readQueries, accepted: [...accepted] } });
  } else if (message.type === "shutdown") {
    server.close(() => { process.disconnect?.(); });
  }
});
