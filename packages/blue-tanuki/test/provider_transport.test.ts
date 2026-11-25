import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as https from "node:https";
import { createServer as createTcpServer, isIP } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderEgressAuthorization,
  fetchProviderWithPinnedEgress,
  ProviderEgressError,
  resolveProviderTarget,
} from "../src/llm/provider_transport.js";
import { OpenAICompatibleBackend } from "../src/llm/openai_compatible.js";

vi.mock("node:https", () => ({
  request: vi.fn(() => { throw new Error("Unexpected HTTPS socket in transport test"); }),
}));

const openaiEndpoint = "https://api.openai.com/v1/chat/completions";
const approvedBody = JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "synthetic prompt" }] });
const approvedRequest = { method: "POST", body: approvedBody };
const publicAddresses = [{ address: "93.184.216.34", family: 4 as const }];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.mocked(https.request).mockClear();
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

  it("blocks remote Provider egress before DNS when no J-issued ComputeGrant reaches the transport", async () => {
    let dnsLookups = 0;
    const resolveHost = async () => {
      dnsLookups += 1;
      return [{ address: "93.184.216.34", family: 4 as const }];
    };

    await expect(fetchProviderWithPinnedEgress(
      "https://provider.example/v1",
      { method: "POST", headers: { authorization: "Bearer synthetic-secret" }, body: "synthetic protected marker" },
      resolveHost,
    )).rejects.toBeInstanceOf(ProviderEgressError);

    expect(dnsLookups).toBe(0);
  });

  describe("OpenAI transport authorization", () => {
    it("does not accept a copy of an authorization or resolve credentials without authority", async () => {
      const assertCurrent = vi.fn();
      const markStarted = vi.fn();
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: assertCurrent, mark_started: markStarted,
      });
      const resolveHost = vi.fn(async () => publicAddresses);
      const resolveHeaders = vi.fn(async () => ({}));

      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, { resolveHeaders }))
        .rejects.toBeInstanceOf(ProviderEgressError);
      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, {
        authorization: { ...authorization }, resolveHeaders,
      })).rejects.toBeInstanceOf(ProviderEgressError);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect(markStarted).not.toHaveBeenCalled();
      expect(resolveHost).not.toHaveBeenCalled();
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    });

    it.each([
      ["host", "https://provider.invalid/v1/chat/completions", approvedRequest],
      ["path", "https://api.openai.com/v1/other", approvedRequest],
      ["query", `${openaiEndpoint}?extra=1`, approvedRequest],
      ["scheme", "http://api.openai.com/v1/chat/completions", approvedRequest],
      ["method", openaiEndpoint, { ...approvedRequest, method: "PUT" }],
      ["body", openaiEndpoint, { ...approvedRequest, body: "changed synthetic input" }],
    ])("rejects a mismatched %s before DNS or credential resolution", async (_case, endpoint, request) => {
      const assertCurrent = vi.fn();
      const markStarted = vi.fn();
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: assertCurrent, mark_started: markStarted,
      });
      const resolveHost = vi.fn(async () => publicAddresses);
      const resolveHeaders = vi.fn(async () => ({}));

      await expect(fetchProviderWithPinnedEgress(endpoint, request, resolveHost, { authorization, resolveHeaders }))
        .rejects.toBeInstanceOf(ProviderEgressError);

      expect(resolveHost).not.toHaveBeenCalled();
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    });

    it.each([
      { name: "private", addresses: [{ address: "10.0.0.1", family: 4 as const }] },
      { name: "mixed", addresses: [...publicAddresses, { address: "127.0.0.1", family: 4 as const }] },
    ])("rejects $name DNS answers even with a current authorization", async ({ addresses }) => {
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: () => {}, mark_started: vi.fn(),
      });
      const resolveHost = vi.fn(async () => addresses);
      const resolveHeaders = vi.fn(async () => ({}));

      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, {
        authorization, resolveHeaders,
      })).rejects.toBeInstanceOf(ProviderEgressError);

      expect(resolveHost).toHaveBeenCalledTimes(1);
      expect(resolveHost).toHaveBeenCalledWith("api.openai.com");
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    });

    it("rejects an authorization that expires during DNS resolution", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      try {
        const authorization = createProviderEgressAuthorization({
          endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: 2_000,
          assert_current: () => {}, mark_started: vi.fn(),
        });
        const resolveHost = vi.fn(async () => {
          now.mockReturnValue(2_000);
          return publicAddresses;
        });
        const resolveHeaders = vi.fn(async () => ({}));

        await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, {
          authorization, resolveHeaders,
        })).rejects.toBeInstanceOf(ProviderEgressError);

        expect(resolveHost).toHaveBeenCalledTimes(1);
        expect(resolveHost).toHaveBeenCalledWith("api.openai.com");
        expect(resolveHeaders).not.toHaveBeenCalled();
        expect(https.request).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
    });

    it.each(["DNS", "credentials"])("rechecks permission after %s resolution before opening a socket", async (stage) => {
      const revoked = new Error("synthetic permission revocation");
      let current = true;
      const markStarted = vi.fn();
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: () => { if (!current) throw revoked; },
        mark_started: markStarted,
      });
      const resolveHost = vi.fn(async () => {
        if (stage === "DNS") current = false;
        return publicAddresses;
      });
      const resolveHeaders = vi.fn(async () => {
        current = false;
        return { authorization: "Bearer synthetic-provider-key" };
      });

      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, {
        authorization, resolveHeaders,
      })).rejects.toBe(revoked);

      expect(resolveHost).toHaveBeenCalledTimes(1);
      expect(resolveHost).toHaveBeenCalledWith("api.openai.com");
      expect(resolveHeaders).toHaveBeenCalledTimes(stage === "credentials" ? 1 : 0);
      expect(markStarted).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    });

    it("requires a start-boundary guard and rejects before opening HTTPS when it fails", async () => {
      const missingGuard = {
        endpoint: openaiEndpoint,
        body: approvedBody,
        expires_at_ms: Date.now() + 60_000,
        assert_current: vi.fn(),
      };
      expect(() => createProviderEgressAuthorization(missingGuard as never))
        .toThrow(ProviderEgressError);

      const revoked = new Error("synthetic current execution permission revocation");
      const markStarted = vi.fn(() => { throw revoked; });
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: () => {}, mark_started: markStarted,
      });
      const resolveHost = vi.fn(async () => publicAddresses);
      const resolveHeaders = vi.fn(async () => ({ authorization: "Bearer synthetic-provider-key" }));

      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, {
        authorization, resolveHeaders,
      })).rejects.toBe(revoked);

      expect(markStarted).toHaveBeenCalledTimes(1);
      expect(https.request).not.toHaveBeenCalled();
    });

    it("consumes an authorization before invoking HTTPS even when the attempt fails", async () => {
      const startFailure = new Error("synthetic request start failure");
      vi.mocked(https.request).mockImplementationOnce(() => { throw startFailure; });
      const markStarted = vi.fn();
      const authorization = createProviderEgressAuthorization({
        endpoint: openaiEndpoint, body: approvedBody, expires_at_ms: Date.now() + 60_000,
        assert_current: () => {}, mark_started: markStarted,
      });
      const resolveHost = vi.fn(async () => publicAddresses);
      const resolveHeaders = vi.fn(async () => ({ authorization: "Bearer synthetic-provider-key" }));
      const dispatch = { authorization, resolveHeaders };

      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, dispatch))
        .rejects.toBe(startFailure);
      await expect(fetchProviderWithPinnedEgress(openaiEndpoint, approvedRequest, resolveHost, dispatch))
        .rejects.toBeInstanceOf(ProviderEgressError);

      expect(resolveHost).toHaveBeenCalledTimes(1);
      expect(resolveHost).toHaveBeenCalledWith("api.openai.com");
      expect(resolveHeaders).toHaveBeenCalledTimes(1);
      expect(markStarted).toHaveBeenCalledTimes(1);
      expect(https.request).toHaveBeenCalledTimes(1);
    });
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

  it("rejects special-purpose, mapped, and non-global NAT64 destinations", async () => {
    const addresses = [
      "192.88.99.2",
      "64:ff9b:1::1",
      "100::1",
      "100:0:0:1::1",
      "2001::1",
      "2001:2::1",
      "2001:10::1",
      "2002:c000:0201::1",
      "3fff::1",
      "5f00::1",
      "::ffff:93.184.216.34",
      "0:0:0:0:0:ffff:5db8:d822",
      "64:ff9b::10.0.0.1",
      "64:ff9b::127.0.0.1",
    ];

    for (const address of addresses) {
      const family = isIP(address);
      if (family !== 4 && family !== 6) throw new Error(`invalid test address: ${address}`);
      await expect(resolveProviderTarget(
        new URL("https://provider.invalid/v1"),
        new AbortController().signal,
        async () => [{ address, family }],
      ), address).rejects.toBeInstanceOf(ProviderEgressError);
    }
  });

  it("accepts globally reachable special assignments and NAT64 with a public IPv4 address", async () => {
    const addresses = [
      "93.184.216.34",
      "192.0.0.9",
      "192.0.0.10",
      "2001:1::1",
      "2001:1::2",
      "2001:1::3",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "64:ff9b::8.8.8.8",
    ];

    for (const address of addresses) {
      const family = isIP(address);
      if (family !== 4 && family !== 6) throw new Error(`invalid test address: ${address}`);
      await expect(resolveProviderTarget(
        new URL("https://provider.invalid/v1"),
        new AbortController().signal,
        async () => [{ address, family }],
      ), address).resolves.toMatchObject({ hostname: "provider.invalid" });
    }
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
