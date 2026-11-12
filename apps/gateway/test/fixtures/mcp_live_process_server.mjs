import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

const root = process.argv[2];
const requestedPort = Number(process.argv[3] ?? "0");
if (!root || !Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  process.exit(2);
}

let toolCalls = 0;
const mcpServer = new McpServer({ name: "BLUE-TANUKI local fixture", version: "1.0.0" });
mcpServer.registerTool("write_synthetic_note", {
  description: "Write one synthetic test note under the test-owned temporary root.",
  inputSchema: z.object({ note: z.string().min(1).max(80) }),
}, async ({ note }) => {
  toolCalls += 1;
  await writeFile(join(root, "mcp-call-count.txt"), String(toolCalls), "utf8");
  if (note === "fail") {
    return { isError: true, content: [{ type: "text", text: "synthetic failure" }] };
  }
  await writeFile(join(root, "mcp-note.txt"), note, "utf8");
  return {
    content: [{ type: "text", text: "synthetic write completed" }],
    structuredContent: { note_bytes: Buffer.byteLength(note, "utf8") },
  };
});

const handler = createMcpHandler(() => mcpServer);
const httpServer = createServer((request, response) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const host = request.headers.host ?? "127.0.0.1";
    const webRequest = new Request(`http://${host}${request.url ?? "/mcp"}`, {
      method: request.method ?? "GET",
      headers: request.headers,
      ...(body.length > 0 ? { body } : {}),
    });
    const webResponse = await handler.fetch(webRequest);
    const responseHeaders = Object.fromEntries(webResponse.headers.entries());
    const responseBody = Buffer.from(await webResponse.arrayBuffer());
    response.writeHead(webResponse.status, responseHeaders);
    response.end(responseBody);
  })().catch(() => {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(500);
      response.end();
    }
  });
});

httpServer.on("error", () => process.exit(3));
httpServer.listen(requestedPort, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string") process.exit(4);
  process.stdout.write(`READY http://127.0.0.1:${address.port}/mcp\n`);
});

async function stop() {
  await handler.close().catch(() => undefined);
  await new Promise((resolve) => httpServer.close(() => resolve()));
}

process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.split(/\r?\n/u).includes("STOP")) void stop().finally(() => process.exit(0));
});
