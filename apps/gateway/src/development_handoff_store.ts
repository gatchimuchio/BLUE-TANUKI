import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  FailureLearningDevelopmentHandoffSchema,
  type FailureLearningDevelopmentHandoff,
} from "@blue-tanuki/protocol";
import { sha256Hex, stableJson } from "@blue-tanuki/hds-brain";

const STORE_SCHEMA_VERSION = "blue-tanuki.development-handoff-store.v1";
const MAX_HANDOFFS = 256;

export interface DevelopmentHandoffInboxSnapshot {
  status: "persistent" | "memory_only" | "unavailable";
  count: number;
  items: readonly FailureLearningDevelopmentHandoff[];
}

type StoreState = {
  schema_version: typeof STORE_SCHEMA_VERSION;
  items: FailureLearningDevelopmentHandoff[];
};

export class DevelopmentHandoffStore {
  private items: FailureLearningDevelopmentHandoff[] = [];
  private unavailable = false;

  constructor(private readonly filepath?: string) {
    if (!filepath || !existsSync(filepath)) return;
    try {
      const parsed = parseStoreSnapshot(JSON.parse(readFileSync(filepath, "utf8")) as unknown);
      this.items = parsed.items;
    } catch {
      // Preserve a malformed inbox for recovery; do not replace it or block runtime authority.
      this.unavailable = true;
    }
  }

  receive(input: FailureLearningDevelopmentHandoff):
    | { status: "stored" | "replayed" }
    | { status: "invalid" | "record_conflict" | "capacity_reached" | "unavailable" | "write_failed" } {
    if (this.unavailable) return { status: "unavailable" };
    const parsed = FailureLearningDevelopmentHandoffSchema.safeParse(input);
    if (!parsed.success || !isValidHandoff(parsed.data)) return { status: "invalid" };
    const handoff = parsed.data;
    const existing = this.items.find((item) => item.handoff_id === handoff.handoff_id);
    if (existing) return sameJson(existing, handoff) ? { status: "replayed" } : { status: "record_conflict" };
    if (this.items.length >= MAX_HANDOFFS) return { status: "capacity_reached" };

    const nextItems = [...this.items, structuredClone(handoff)];
    if (this.filepath) {
      try {
        const parent = path.dirname(this.filepath);
        mkdirSync(parent, { recursive: true });
        const tempPath = `${this.filepath}.tmp-${process.pid}`;
        writeFileSync(tempPath, JSON.stringify({ schema_version: STORE_SCHEMA_VERSION, items: nextItems }, null, 2) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(tempPath, this.filepath);
      } catch {
        this.unavailable = true;
        return { status: "write_failed" };
      }
    }
    this.items = nextItems;
    return { status: "stored" };
  }

  snapshot(): DevelopmentHandoffInboxSnapshot {
    return {
      status: this.unavailable ? "unavailable" : this.filepath ? "persistent" : "memory_only",
      count: this.items.length,
      items: this.items.map((item) => structuredClone(item)),
    };
  }
}

export function developmentHandoffStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DevelopmentHandoffStore {
  const explicitFile = env.BLUE_TANUKI_DEVELOPMENT_HANDOFF_FILE;
  if (explicitFile) return new DevelopmentHandoffStore(path.resolve(explicitFile));

  const failureFile = env.BLUE_TANUKI_FAILURE_MEMORY_FILE;
  if (failureFile) return new DevelopmentHandoffStore(path.join(path.dirname(path.resolve(failureFile)), "development-handoffs.json"));

  const failureDir = env.BLUE_TANUKI_FAILURE_MEMORY_DIR;
  if (failureDir) return new DevelopmentHandoffStore(path.join(path.resolve(failureDir), "development-handoffs.json"));

  return new DevelopmentHandoffStore();
}

function parseStoreSnapshot(value: unknown): StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid development handoff store");
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== STORE_SCHEMA_VERSION || !Array.isArray(raw.items) || raw.items.length > MAX_HANDOFFS) {
    throw new Error("invalid development handoff store");
  }
  const items = raw.items.map((item) => {
    const parsed = FailureLearningDevelopmentHandoffSchema.safeParse(item);
    if (!parsed.success || !isValidHandoff(parsed.data)) throw new Error("invalid development handoff item");
    return parsed.data;
  });
  if (new Set(items.map((item) => item.handoff_id)).size !== items.length) {
    throw new Error("duplicate development handoff id");
  }
  return { schema_version: STORE_SCHEMA_VERSION, items };
}

function isValidHandoff(handoff: FailureLearningDevelopmentHandoff): boolean {
  const candidateDigest = sha256Hex(stableJson(handoff.candidate));
  const expectedId = sha256Hex(`blue-tanuki.failure-learning-development-handoff.v1:${handoff.source_record_digest}`);
  return handoff.handoff_id === expectedId &&
    handoff.candidate_content_digest === candidateDigest &&
    handoff.candidate.signature_digest === handoff.source_signature_digest &&
    handoff.candidate.projection_digest === handoff.source_projection_digest &&
    handoff.used_for_authority === false && handoff.may_execute === false && handoff.may_promote_version === false;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
