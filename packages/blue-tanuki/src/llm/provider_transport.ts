import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { SETTINGS_WRITE_ACTIVATION_DESTINATIONS } from "@blue-tanuki/protocol";
import {
  isLoopbackNetworkAddress,
  isPublicNetworkAddress,
  resolveNetworkAddresses,
  type ResolvedNetworkAddress,
} from "../network_egress.js";
import { hasCredentialQueryParameter } from "../url_security.js";

export class ProviderEgressError extends Error {
  constructor() {
    super("Provider target rejected by egress policy.");
    this.name = "ProviderEgressError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type ProviderHostResolver = (
  hostname: string,
) => Promise<ResolvedNetworkAddress[]>;

const providerEgressAuthorizationBrand: unique symbol = Symbol("provider egress authorization");

export type ProviderEgressAuthorization = { readonly [providerEgressAuthorizationBrand]: true };

interface ProviderEgressScope {
  endpoint: string;
  body: string;
  expires_at_ms: number;
  assert_current: () => void;
  mark_started?: () => void;
}

const providerEgressScopes = new WeakMap<ProviderEgressAuthorization, ProviderEgressScope>();

/** Called only after the approved command and its reserved compute grant are checked. */
export function createProviderEgressAuthorization(scope: ProviderEgressScope): ProviderEgressAuthorization {
  const authorization = Object.freeze({ [providerEgressAuthorizationBrand]: true as const });
  providerEgressScopes.set(authorization, { ...scope });
  return authorization;
}

export interface ProviderDispatch {
  authorization?: ProviderEgressAuthorization;
  resolveHeaders: () => Promise<Record<string, string>>;
}

function assertProviderEgressCurrent(scope: ProviderEgressScope, signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  if (Date.now() >= scope.expires_at_ms) throw new ProviderEgressError();
  scope.assert_current();
}

export interface ProviderEgressTarget {
  hostname: string;
  addresses: readonly ResolvedNetworkAddress[];
}

function hostnameFor(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/u, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const family = isIP(hostname);
  return (family === 4 || family === 6) && isLoopbackNetworkAddress({
    address: hostname,
    family,
  });
}

export async function resolveProviderTarget(
  url: URL,
  signal: AbortSignal,
  resolveHost: ProviderHostResolver = resolveNetworkAddresses,
): Promise<ProviderEgressTarget> {
  const hostname = hostnameFor(url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    hasCredentialQueryParameter(url) ||
    hostname.length === 0
  ) {
    throw new ProviderEgressError();
  }

  const loopbackConfigured = isLoopbackHostname(hostname);
  if (url.protocol === "http:" && !loopbackConfigured) throw new ProviderEgressError();

  const addresses = await resolveWithAbort(hostname, resolveHost, signal);
  if (addresses.length === 0) throw new ProviderEgressError();
  const addressesAllowed = loopbackConfigured
    ? addresses.every(isLoopbackNetworkAddress)
    : addresses.every(isPublicNetworkAddress);
  if (!addressesAllowed) throw new ProviderEgressError();
  return { hostname, addresses };
}

async function resolveWithAbort(
  hostname: string,
  resolveHost: ProviderHostResolver,
  signal: AbortSignal,
): Promise<ResolvedNetworkAddress[]> {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([resolveHost(hostname), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function responseHeaders(response: http.IncomingMessage, compressed: boolean): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (!name || value === undefined || HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (compressed && (name.toLowerCase() === "content-encoding" || name.toLowerCase() === "content-length")) {
      continue;
    }
    headers.append(name, value);
  }
  return headers;
}

function decodeResponseBody(
  response: http.IncomingMessage,
  encodingHeader: string | string[] | undefined,
): Readable {
  if (encodingHeader === undefined) return response;
  if (Array.isArray(encodingHeader) && encodingHeader.length !== 1) {
    throw new TypeError("Provider returned an unsupported content encoding.");
  }
  const encoding = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader)
    ?.trim()
    .toLowerCase();
  if (!encoding || encoding === "identity") return response;

  let decoder: Transform;
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      decoder = createGunzip();
      break;
    case "deflate":
      decoder = createInflate();
      break;
    case "br":
      decoder = createBrotliDecompress();
      break;
    default:
      throw new TypeError("Provider returned an unsupported content encoding.");
  }
  return response.pipe(decoder);
}

function buildPinnedLookup(addresses: readonly ResolvedNetworkAddress[]): LookupFunction {
  const nodeAddresses = addresses.map(({ address, family }) => ({ address, family }));
  const first = nodeAddresses[0];
  if (!first) throw new ProviderEgressError();
  return ((_hostname, options, callback) => {
    if (typeof options === "object" && options !== null && "all" in options && options.all) {
      (callback as (error: null, addresses: typeof nodeAddresses) => void)(null, nodeAddresses);
    } else {
      (callback as (error: null, address: string, family: number) => void)(
        null,
        first.address,
        first.family,
      );
    }
  }) as LookupFunction;
}

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Sends only to a validated, DNS-pinned destination. Redirect responses are never followed. */
export async function fetchProviderWithPinnedEgress(
  input: string | URL | Request,
  init: RequestInit = {},
  resolveHost: ProviderHostResolver = resolveNetworkAddresses,
  dispatch?: ProviderDispatch,
): Promise<Response> {
  let request: Request;
  let url: URL;
  try {
    request = new Request(input, { ...init, redirect: "error" });
    url = new URL(request.url);
  } catch {
    throw new ProviderEgressError();
  }

  const remote = !isLoopbackHostname(hostnameFor(url));
  const authorization = dispatch?.authorization;
  const scope = authorization && providerEgressScopes.get(authorization);
  if (remote || authorization) {
    if (!scope || url.href !== SETTINGS_WRITE_ACTIVATION_DESTINATIONS.openai ||
        url.href !== scope.endpoint || request.method !== "POST" || init.body !== scope.body) {
      throw new ProviderEgressError();
    }
    assertProviderEgressCurrent(scope, request.signal);
  }

  const target = await resolveProviderTarget(url, request.signal, resolveHost);
  const { hostname, addresses } = target;

  if (scope) assertProviderEgressCurrent(scope, request.signal);
  const headers = new Headers(dispatch ? await dispatch.resolveHeaders() : request.headers);
  if (scope && !/^Bearer \S+$/u.test(headers.get("authorization") ?? "")) throw new ProviderEgressError();
  headers.delete("host");
  const normalizedHeaders = Object.fromEntries(headers.entries());
  const lookup = buildPinnedLookup(addresses);
  const requestOptions = {
    protocol: url.protocol,
    hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers: normalizedHeaders,
    lookup,
    ...(remote ? { agent: false, rejectUnauthorized: true } : {}),
    ...(addresses.length > 1 ? { autoSelectFamily: true } : {}),
    ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    signal: request.signal,
  } as http.RequestOptions & {
    autoSelectFamily?: boolean;
    servername?: string;
  };

  return await new Promise<Response>((resolve, reject) => {
    const onResponse = (incoming: http.IncomingMessage): void => {
      const status = incoming.statusCode ?? 0;
      if (isRedirect(status) && incoming.headers.location) {
        incoming.destroy();
        reject(new TypeError("fetch failed"));
        return;
      }

      const rawEncoding = incoming.headers["content-encoding"];
      const encoding = Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding;
      const compressed = encoding !== undefined && encoding.trim().toLowerCase() !== "identity";
      let body: Readable | null = null;
      try {
        body = status === 204 || status === 205 || status === 304
          ? null
          : decodeResponseBody(incoming, rawEncoding);
        const response = new Response(
          body ? Readable.toWeb(body) as ReadableStream<Uint8Array> : null,
          {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders(incoming, compressed),
          },
        );
        resolve(response);
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    };
    if (scope && authorization) {
      assertProviderEgressCurrent(scope, request.signal);
      if (!providerEgressScopes.delete(authorization)) throw new ProviderEgressError();
      scope.mark_started?.();
    }
    const req = url.protocol === "https:"
      ? https.request(requestOptions, onResponse)
      : http.request(requestOptions, onResponse);
    req.once("error", reject);

    if (request.body) {
      const body = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream);
      body.once("error", (error) => req.destroy(error));
      body.pipe(req);
    } else {
      req.end();
    }
  });
}
