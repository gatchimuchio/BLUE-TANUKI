import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { queryLocalInspectionReceipt } from "../src/local_inspection_adapter.js";

const key = "a".repeat(64);
const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  return { url, server };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("loopback-only reconciliation adapter", () => {
  it("rejects remote, credentialed, routed, and unbounded request inputs before fetch", async () => {
    for (const endpoint of [
      "https://127.0.0.1:1234",
      "http://example.invalid:1234",
      "http://user:secret@127.0.0.1:1234",
      "http://127.0.0.1:1234/prefix",
      "http://127.0.0.1:1234/?query=1",
    ]) {
      await expect(queryLocalInspectionReceipt(endpoint, key)).rejects.toThrow("local_inspection_endpoint_invalid");
    }
    await expect(queryLocalInspectionReceipt("http://127.0.0.1:1234", "not-a-digest"))
      .rejects.toThrow("local_inspection_request_invalid");
    await expect(queryLocalInspectionReceipt("http://127.0.0.1:1234", key, 5_001))
      .rejects.toThrow("local_inspection_request_invalid");
  });

  it("does not follow redirects", async () => {
    let redirected = 0;
    const target = await serve((_request, response) => { redirected += 1; response.writeHead(200).end("{}"); });
    const source = await serve((_request, response) => {
      response.writeHead(302, { location: `${target.url}/capture` }).end();
    });
    await expect(queryLocalInspectionReceipt(source.url, key)).rejects.toThrow("local_inspection_request_failed");
    expect(redirected).toBe(0);
  });

  it("caps a chunked response before parsing it", async () => {
    const endpoint = await serve((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe(`/reconcile/${key}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "not_found", matches: [] }) + " ".repeat(65 * 1024));
    });
    await expect(queryLocalInspectionReceipt(endpoint.url, key)).rejects.toThrow("local_inspection_response_too_large");
  });
});
