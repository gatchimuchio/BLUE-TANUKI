import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchProviderWithPinnedEgress,
  ProviderEgressError,
  resolveProviderTarget,
} from "../src/llm/provider_transport.js";
import { OpenAICompatibleBackend } from "../src/llm/openai_compatible.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const instance = {
    url: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  servers.push(instance);
  return instance;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("provider pinned egress transport", () => {
  it("connects to an explicitly configured loopback provider and returns its response", async () => {
    let body = "";
    let authorization: string | undefined;
    const server = await startHttpServer((request, response) => {
      authorization = request.headers.authorization;
      void readBody(request).then((text) => {
        body = text;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "fixture-model",
          choices: [{ finish_reason: "stop", message: { content: "local response" } }],
        }));
      });
    });
    const backend = new OpenAICompatibleBackend({
      endpoint: `${server.url}/v1`,
      defaultModel: "fixture-model",
      apiKey: "synthetic-provider-key",
    });

    const result = await backend.call({ messages: [{ role: "user", content: "synthetic prompt" }] });

    expect(result.content).toBe("local response");
    expect(authorization).toBe("Bearer synthetic-provider-key");
    expect(JSON.parse(body)).toMatchObject({
      model: "fixture-model",
      messages: [{ role: "user", content: "synthetic prompt" }],
    });
  });

  it("rejects a redirect without forwarding the provider body or credential", async () => {
    let firstRequests = 0;
    let secondRequests = 0;
    const destination = await startHttpServer((_request, response) => {
      secondRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "should not arrive" } }] }));
    });
    const redirector = await startHttpServer((_request, response) => {
      firstRequests += 1;
      response.writeHead(302, { location: `${destination.url}/collect` });
      response.end("redirect body");
    });
    const backend = new OpenAICompatibleBackend({
      endpoint: `${redirector.url}/v1`,
      defaultModel: "fixture-model",
      apiKey: "synthetic-provider-key",
    });

    await expect(backend.call({ messages: [{ role: "user", content: "synthetic prompt" }] }))
      .rejects.toMatchObject({ kind: "disconnected", retryable: true });

    expect(firstRequests).toBe(1);
    expect(secondRequests).toBe(0);
  });

  it("rejects private DNS answers before opening a socket", async () => {
    let socketConnections = 0;
    const countServer = createTcpServer((socket) => {
      socketConnections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      countServer.once("error", reject);
      countServer.listen(0, "127.0.0.1", resolve);
    });
    const address = countServer.address() as AddressInfo;
    servers.push({ close: () => new Promise<void>((resolve, reject) => {
      countServer.close((error) => error ? reject(error) : resolve());
    }) });

    const resolveHost = async () => [{ address: "127.0.0.1", family: 4 as const }];
    await expect(fetchProviderWithPinnedEgress(
      `https://provider.invalid:${address.port}/v1`,
      { method: "POST", body: "synthetic marker" },
      resolveHost,
    ))
      .rejects.toBeInstanceOf(ProviderEgressError);
    expect(socketConnections).toBe(0);
  });

  it("rejects mixed public and private DNS answers", async () => {
    const url = new URL("https://provider.invalid/v1");
    const resolveHost = async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ];

    await expect(resolveProviderTarget(url, new AbortController().signal, resolveHost))
      .rejects.toBeInstanceOf(ProviderEgressError);
  });

  it("rejects credential-bearing endpoint query parameters", async () => {
    const url = new URL("https://provider.invalid/v1?api_key=synthetic-marker");
    const resolveHost = async () => {
      throw new Error("DNS must not run for a credential-bearing URL");
    };

    await expect(resolveProviderTarget(url, new AbortController().signal, resolveHost))
      .rejects.toBeInstanceOf(ProviderEgressError);
  });

  it("returns a non-retryable provider input error for remote plaintext endpoints", async () => {
    const backend = new OpenAICompatibleBackend({
      endpoint: "http://provider.invalid/v1",
      defaultModel: "fixture-model",
    });

    await expect(backend.call({ messages: [{ role: "user", content: "synthetic prompt" }] }))
      .rejects.toMatchObject({ kind: "bad_request", retryable: false });
  });
});
