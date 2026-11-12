import { createHash } from "node:crypto";
import { parseLoopbackMcpEndpoint } from "./mcp_endpoint.js";

export type McpConnectionObservationState = "not_observed" | "catalog_reachable" | "preflight_failed";
export type McpCallObservationState = "not_observed" | "dispatching" | "response_received" | "outcome_unknown";

export interface McpRuntimeObservationSnapshot {
  readonly connection: {
    readonly state: McpConnectionObservationState;
    readonly observed_at: string | null;
  };
  readonly last_call: {
    readonly state: McpCallObservationState;
    readonly observed_at: string | null;
  };
  readonly used_for_authority: false;
  readonly may_execute: false;
}

interface StoredMcpRuntimeObservation {
  connection: McpRuntimeObservationSnapshot["connection"];
  last_call: McpRuntimeObservationSnapshot["last_call"];
}

const MAX_TRACKED_ENDPOINTS = 8;

function emptyObservation(): StoredMcpRuntimeObservation {
  return {
    connection: { state: "not_observed", observed_at: null },
    last_call: { state: "not_observed", observed_at: null },
  };
}

function endpointDigest(endpoint: string | URL): string | null {
  try {
    const canonical = parseLoopbackMcpEndpoint(endpoint);
    return createHash("sha256").update(canonical.href, "utf8").digest("hex");
  } catch {
    return null;
  }
}

/** Process-local observations from normal MCP calls. This is not a health check or authority input. */
export class McpRuntimeObservationStore {
  private readonly observations = new Map<string, StoredMcpRuntimeObservation>();

  recordCatalogReachable(endpoint: string | URL): void {
    this.update(endpoint, (current) => ({
      ...current,
      connection: { state: "catalog_reachable", observed_at: new Date().toISOString() },
    }));
  }

  recordPreflightFailed(endpoint: string | URL): void {
    this.update(endpoint, (current) => ({
      ...current,
      connection: { state: "preflight_failed", observed_at: new Date().toISOString() },
    }));
  }

  recordDispatchStarted(endpoint: string | URL): void {
    this.update(endpoint, (current) => ({
      ...current,
      last_call: { state: "dispatching", observed_at: new Date().toISOString() },
    }));
  }

  recordResponseReceived(endpoint: string | URL): void {
    this.update(endpoint, (current) => ({
      ...current,
      last_call: { state: "response_received", observed_at: new Date().toISOString() },
    }));
  }

  recordOutcomeUnknown(endpoint: string | URL): void {
    this.update(endpoint, (current) => ({
      ...current,
      last_call: { state: "outcome_unknown", observed_at: new Date().toISOString() },
    }));
  }

  snapshot(endpoint: string | URL | undefined): McpRuntimeObservationSnapshot {
    const digest = endpoint === undefined ? null : endpointDigest(endpoint);
    const stored = digest === null ? undefined : this.observations.get(digest);
    const observation = stored ?? emptyObservation();
    return {
      connection: { ...observation.connection },
      last_call: { ...observation.last_call },
      used_for_authority: false,
      may_execute: false,
    };
  }

  private update(
    endpoint: string | URL,
    update: (current: StoredMcpRuntimeObservation) => StoredMcpRuntimeObservation,
  ): void {
    const digest = endpointDigest(endpoint);
    if (digest === null) return;
    const current = this.observations.get(digest) ?? emptyObservation();
    const next = update(current);
    this.observations.delete(digest);
    if (this.observations.size >= MAX_TRACKED_ENDPOINTS) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }
    this.observations.set(digest, next);
  }
}

export const mcpRuntimeObservationStore = new McpRuntimeObservationStore();
