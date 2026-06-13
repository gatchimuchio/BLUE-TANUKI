import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CompleteHistoryStore,
  HDSUpperController,
} from "@blue-tanuki/hds-brain";
import { createGatewayEvidencePack } from "../src/evidence_pack.js";

describe("evidence pack", () => {
  it("exports digest-only evidence with redaction and retention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bt-evidence-pack-"));
    const evidenceRoot = path.join(root, "evidence");
    try {
      await fs.mkdir(path.join(evidenceRoot, "evidence-2026-01-01T00.00.00.000Z"), { recursive: true });
      await fs.mkdir(path.join(evidenceRoot, "evidence-2026-01-02T00.00.00.000Z"), { recursive: true });

      const hds = new HDSUpperController();
      hds.decide({
        id: "req-1",
        channel: "webchat",
        user: "owner",
        content: "hello secret-fixture-value",
        timestamp: 1,
      });
      const history = new CompleteHistoryStore();
      history.append({
        kind: "user_input",
        request_id: "req-1",
        actor: "owner",
        source: "test",
        payload: {
          content: "raw secret-fixture-value",
          token: "token-fixture-value",
          api_key: "api-key-fixture-value",
        },
      });

      const pack = await createGatewayEvidencePack({
        rootDir: root,
        env: {
          BLUE_TANUKI_EVIDENCE_DIR: evidenceRoot,
          BLUE_TANUKI_EVIDENCE_RETENTION_MAX_PACKS: "1",
          WEBCHAT_TOKEN: "token-fixture-value",
          OPENROUTER_API_KEY: "api-key-fixture-value",
          TEST_SECRET: "secret-fixture-value",
        },
        audit: hds.getAudit(),
        completeHistory: history,
        now: new Date("2026-06-14T00:00:00.000Z"),
        requested_by: "owner",
        source: "control_center",
      });

      expect(pack.used_for_authority).toBe(false);
      expect(pack.hds_brain_remains_authority).toBe(true);
      expect(pack.audit_chain_valid).toBe(true);
      expect(pack.complete_history_chain_valid).toBe(true);
      expect(pack.secret_redaction).toMatchObject({
        applied: true,
        scan_ok: true,
        findings: [],
      });
      expect(pack.retention.removed_packs).toHaveLength(2);
      expect(pack.manifest.files.map((file) => file.path).sort()).toEqual([
        "audit-summary.json",
        "complete-history-summary.json",
        "report.txt",
        "summary.json",
      ]);

      const exported = await Promise.all(
        ["summary.json", "audit-summary.json", "complete-history-summary.json", "report.txt", "manifest.json"].map((file) =>
          fs.readFile(path.join(pack.pack_dir, file), "utf8"),
        ),
      );
      const text = exported.join("\n");
      expect(text).toContain("BLUE-TANUKI Evidence Pack");
      expect(text).toContain("complete_history_used_for_authority");
      expect(text).not.toContain("secret-fixture-value");
      expect(text).not.toContain("token-fixture-value");
      expect(text).not.toContain("api-key-fixture-value");
      expect(text).not.toContain("raw secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before writing when redaction scan finds a configured secret", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bt-evidence-pack-fail-"));
    const evidenceRoot = path.join(root, "evidence");
    try {
      const hds = new HDSUpperController();
      const history = new CompleteHistoryStore();
      await expect(
        createGatewayEvidencePack({
          rootDir: root,
          env: {
            BLUE_TANUKI_EVIDENCE_DIR: evidenceRoot,
            TEST_SECRET: "owner-secret-appears-as-actor",
          },
          audit: hds.getAudit(),
          completeHistory: history,
          now: new Date("2026-06-14T00:00:00.000Z"),
          requested_by: "owner-secret-appears-as-actor",
          source: "control_center",
        }),
      ).rejects.toThrow(/evidence redaction scan failed/);
      const dirs = await fs.readdir(evidenceRoot).catch(() => []);
      expect(dirs).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
