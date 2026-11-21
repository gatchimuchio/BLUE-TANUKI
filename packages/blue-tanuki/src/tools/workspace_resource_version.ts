import { randomBytes } from "node:crypto";

const MAX_TRACKED_WORKSPACES = 4_096;
const workspaceRevisionByRoot = new Map<string, string>();
const unavailableWorkspaceRevisions = new Set<string>();

function assertWorkspaceIdentityDigest(rootIdentityDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(rootIdentityDigest)) {
    throw new Error("Broker workspace revision requires a valid root identity digest");
  }
}

function createRevisionDigest(): string {
  return randomBytes(32).toString("hex");
}

function rememberRevision(rootIdentityDigest: string, revisionDigest: string): void {
  workspaceRevisionByRoot.delete(rootIdentityDigest);
  if (workspaceRevisionByRoot.size >= MAX_TRACKED_WORKSPACES) {
    const oldestRootIdentityDigest = workspaceRevisionByRoot.keys().next().value;
    if (oldestRootIdentityDigest !== undefined) workspaceRevisionByRoot.delete(oldestRootIdentityDigest);
  }
  workspaceRevisionByRoot.set(rootIdentityDigest, revisionDigest);
}

/**
 * Returns an opaque, process-scoped revision for Broker-mediated workspace actions.
 * It is not a content hash, permission, or cross-process fencing token.
 */
export function brokerWorkspaceMutationRevisionDigest(rootIdentityDigest: string): string {
  assertWorkspaceIdentityDigest(rootIdentityDigest);
  if (unavailableWorkspaceRevisions.has(rootIdentityDigest)) {
    throw new Error("Broker workspace revision is unavailable; filesystem actions remain blocked");
  }
  const current = workspaceRevisionByRoot.get(rootIdentityDigest);
  if (current !== undefined) {
    // Keep active roots in the bounded map; eviction only causes a fresh fail-closed revision.
    rememberRevision(rootIdentityDigest, current);
    return current;
  }
  const initial = createRevisionDigest();
  rememberRevision(rootIdentityDigest, initial);
  return initial;
}

/**
 * Invalidates shell observations after a Broker adapter has been dispatched for this root.
 * If a new revision cannot be issued, the root stays fail-closed for later inspections.
 */
export function advanceBrokerWorkspaceMutationRevisionDigest(rootIdentityDigest: string): void {
  assertWorkspaceIdentityDigest(rootIdentityDigest);
  unavailableWorkspaceRevisions.add(rootIdentityDigest);
  try {
    rememberRevision(rootIdentityDigest, createRevisionDigest());
    unavailableWorkspaceRevisions.delete(rootIdentityDigest);
  } catch (error) {
    throw new Error("Broker workspace revision could not advance; filesystem actions remain blocked", { cause: error });
  }
}
