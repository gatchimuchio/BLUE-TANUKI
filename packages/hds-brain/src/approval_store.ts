import { HDSPrivateReplaceableFile } from "./private_append_only_file.js";
import type { ApprovalGrant } from "./approval_policy.js";

export interface ApprovalGrantStore {
  list(): readonly ApprovalGrant[];
  add(grant: ApprovalGrant): ApprovalGrant;
  revoke(id: string): boolean;
  clearExpired(now?: number): number;
  size(): number;
}

export class MemoryApprovalGrantStore implements ApprovalGrantStore {
  protected grants = new Map<string, ApprovalGrant>();
  constructor(initial: readonly ApprovalGrant[] = []) { for (const grant of initial) this.grants.set(grant.id, grant); }
  list(): readonly ApprovalGrant[] { return Array.from(this.grants.values()).sort((a, b) => a.created_at - b.created_at); }
  add(grant: ApprovalGrant): ApprovalGrant {
    const previous = this.grants.get(grant.id);
    this.grants.set(grant.id, grant);
    try {
      this.afterMutation();
    } catch (error) {
      if (previous) this.grants.set(grant.id, previous);
      else this.grants.delete(grant.id);
      throw error;
    }
    return grant;
  }
  revoke(id: string): boolean {
    const grant = this.grants.get(id);
    if (!grant || !grant.revocable) return false;
    this.grants.delete(id);
    try {
      this.afterMutation();
    } catch (error) {
      this.grants.set(id, grant);
      throw error;
    }
    return true;
  }
  clearExpired(now = Date.now()): number {
    const expired = [...this.grants.entries()].filter(([, grant]) => grant.expires_at !== null && grant.expires_at <= now);
    if (expired.length === 0) return 0;
    for (const [id] of expired) this.grants.delete(id);
    try {
      this.afterMutation();
    } catch (error) {
      for (const [id, grant] of expired) this.grants.set(id, grant);
      throw error;
    }
    return expired.length;
  }
  size(): number { return this.grants.size; }
  protected afterMutation(): void {}
}

export class JsonFileApprovalGrantStore extends MemoryApprovalGrantStore {
  private readonly filepath: string;
  private readonly persistence: HDSPrivateReplaceableFile;
  private unavailable = false;

  constructor(filepath: string) {
    const persistence = new HDSPrivateReplaceableFile(filepath);
    const raw = persistence.readUtf8IfPresent();
    super(loadGrants(filepath, raw));
    this.filepath = persistence.filepath;
    this.persistence = persistence;
    if (raw === undefined) this.persist();
  }

  override list(): readonly ApprovalGrant[] { this.assertAvailable(); return super.list(); }
  override add(grant: ApprovalGrant): ApprovalGrant { this.assertAvailable(); return super.add(grant); }
  override revoke(id: string): boolean { this.assertAvailable(); return super.revoke(id); }
  override clearExpired(now = Date.now()): number { this.assertAvailable(); return super.clearExpired(now); }
  override size(): number { this.assertAvailable(); return super.size(); }

  protected override afterMutation(): void {
    try {
      this.persist();
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
  }

  private persist(): void {
    this.persistence.replaceUtf8(JSON.stringify({ version: 1, grants: super.list() }, null, 2) + "\n");
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error("approval_grant_store_unavailable_after_persistence_failure");
  }
}

function loadGrants(filepath: string, contents: string | undefined): ApprovalGrant[] { if (contents === undefined) return []; const raw = contents.trim(); if (!raw) return []; const parsed = JSON.parse(raw) as unknown; if (Array.isArray(parsed)) return parseGrantArray(parsed); if (isRecord(parsed) && Array.isArray(parsed.grants)) return parseGrantArray(parsed.grants); throw new Error(`ApprovalGrantStore: invalid grants file: ${filepath}`); }
function parseGrantArray(values: unknown[]): ApprovalGrant[] { return values.map((value, index) => { if (!isRecord(value)) throw new Error(`ApprovalGrantStore: grant[${index}] must be object`); for (const key of ["id", "mode", "decision", "operation", "target_scope", "risk", "actor", "created_by", "created_at", "expires_at", "revocable"]) if (!(key in value)) throw new Error(`ApprovalGrantStore: grant[${index}] missing ${key}`); return value as unknown as ApprovalGrant; }); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
