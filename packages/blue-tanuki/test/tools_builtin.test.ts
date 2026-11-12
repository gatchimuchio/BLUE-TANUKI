import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  invokeFileSearch,
  inspectFileSearchTargetVersion,
  inspectFileWriteTargetVersion,
  inspectFileWriteOutcomeState,
  invokeFileWrite,
  inspectFileDeleteTargetVersion,
  invokeFileDelete,
  inspectFileEditTargetVersion,
  inspectFileEditContentReview,
  invokeFileEdit,
  invokeHttpFetch,
  invokeWebSearch,
  invokeGitHubRead,
  invokeGitHubWrite,
  inspectGitHubIssueCreateTargetVersion,
  inspectGitHubIssueCreateContentReview,
  inspectGitHubIssueUpdateTargetVersion,
  inspectGitHubIssueUpdateContentReview,
  inspectGitHubIssueCommentCreateTargetVersion,
  inspectGitHubIssueCommentCreateContentReview,
  inspectGitHubPullRequestCommentCreateTargetVersion,
  inspectGitHubPullRequestCommentCreateContentReview,
  inspectGitHubPullRequestCreateTargetVersion,
  inspectGitHubPullRequestCreateContentReview,
  inspectGitHubCodePushTargetVersion,
  inspectGitHubCodePushContentReview,
  inspectGitHubReleaseDraftCreateTargetVersion,
  inspectGitHubReleaseDraftCreateContentReview,
  invokeGmailRead,
  invokeGoogleCalendarRead,
  invokeGoogleDriveRead,
  buildGoogleDailyBriefContent,
  invokeGmailWrite,
  invokeGoogleCalendarWrite,
  invokeGoogleDriveWrite,
  invokeBrowserRead,
  invokeBrowserSnapshot,
  invokeBrowserAutomation,
  invokeShellExec,
  registerBuiltinTools,
  type BrowserAutomationOptions,
  type FileSearchOptions,
  type GitHubReadOptions,
  type GitHubWriteOptions,
  type GoogleReadOptions,
  type GoogleWriteOptions,
  type HttpFetchOptions,
} from "../src/tools/builtin.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { inspectShellExecTargetVersion } from "../src/tools/shell_exec.js";
import { SYNTHETIC_FILE_EDIT_TEST_FAILURE_PROFILE } from "../src/tools/shell_exec_profile.js";
import { inspectGoogleDriveWriteTargetVersion } from "../src/tools/google_write.js";

const ctx = {
  command_id: "cmd-1",
  upstream_commit_hash: "hash-1",
};

describe("built-in tools", () => {
  it("registerBuiltinTools registers tools and their capabilities", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.get("echo")).toBeDefined();
    expect(registry.get("file.search")).toBeDefined();
    expect(registry.get("file.write")).toBeDefined();
    expect(registry.get("file.delete")).toBeDefined();
    expect(registry.get("file.edit")).toBeDefined();
    expect(registry.get("http.fetch")).toBeDefined();
    expect(registry.get("web.search")).toBeDefined();
    expect(registry.get("github.read")).toBeDefined();
    expect(registry.get("github.write")).toBeDefined();
    expect(registry.get("gmail.read")).toBeDefined();
    expect(registry.get("google.calendar.read")).toBeDefined();
    expect(registry.get("google.drive.read")).toBeDefined();
    expect(registry.get("gmail.write")).toBeDefined();
    expect(registry.get("google.calendar.write")).toBeDefined();
    expect(registry.get("google.drive.write")).toBeDefined();
    expect(registry.get("browser.read")).toBeDefined();
    expect(registry.get("browser.snapshot")).toBeDefined();
    expect(registry.get("browser.automation")).toBeDefined();
    expect(registry.get("shell.exec")).toBeDefined();
    expect(registry.get("composio.search")).toBeDefined();
    expect(registry.get("composio.accounts")).toBeDefined();
    expect(registry.get("composio.scopes")).toBeDefined();
    expect(registry.get("composio.execute")).toBeDefined();
    expect(registry.listCapabilities()).toEqual([
      "browser:act",
      "browser:snapshot",
      "email:send",
      "external:send",
      "fs:delete",
      "fs:read",
      "fs:write",
      "github:code.write",
      "github:comment.write",
      "github:issue.write",
      "github:pr.write",
      "github:release.write",
      "google:calendar.read",
      "google:calendar.write",
      "google:drive.read",
      "google:drive.write",
      "google:gmail.read",
      "google:gmail.write",
      "network:composio.dev",
      "network:github.com",
      "network:googleapis.com",
      "network:http",
      "secrets:COMPOSIO_API_KEY",
      "secrets:GITHUB_TOKEN",
      "secrets:GMAIL_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
      "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
      "shell:exec",
      "tool:browser.automation",
      "tool:browser.read",
      "tool:browser.snapshot",
      "tool:composio.accounts",
      "tool:composio.execute",
      "tool:composio.scopes",
      "tool:composio.search",
      "tool:echo",
      "tool:file.delete",
      "tool:file.edit",
      "tool:file.search",
      "tool:file.write",
      "tool:github.read",
      "tool:github.write",
      "tool:gmail.read",
      "tool:gmail.write",
      "tool:google.calendar.read",
      "tool:google.calendar.write",
      "tool:google.drive.read",
      "tool:google.drive.write",
      "tool:http.fetch",
      "tool:shell.exec",
      "tool:web.search",
    ]);
  });

  it("file.search returns bounded read-only text matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "alpha\nneedle here\n", "utf8");
      await fs.mkdir(path.join(dir, "sub"));
      await fs.writeFile(path.join(dir, "sub", "b.txt"), "needle again\n", "utf8");

      const result = (await invokeFileSearch(
        { root: ".", query: "needle", max_results: 1 },
        fileSearchEnv(dir),
      )) as {
        root: string;
        sandbox_root: string;
        matches: Array<{ path: string; line_number: number; line: string }>;
      };

      expect(result.root).toBe(await fs.realpath(dir));
      expect(result.sandbox_root).toBe(await fs.realpath(dir));
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.line).toContain("needle");
      expect(result.matches[0]!.line_number).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.search binds the bounded observed directory version and rejects a changed target before returning results", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-search-version-"));
    try {
      const args = { root: ".", query: "needle", max_results: 5 };
      await fs.writeFile(path.join(dir, "a.txt"), "needle original\n", "utf8");
      const operationPlanBindingDigest = "a".repeat(64);
      const expected = await inspectFileSearchTargetVersion(args, {
        ...fileSearchEnv(dir), operation_plan_binding_digest: operationPlanBindingDigest,
      });
      expect(Object.keys(expected).sort()).toEqual([
        "canonical_root_digest", "files_examined", "may_execute", "operation_plan_binding_digest", "requested_root_digest",
        "resource_version_digest", "schema_version", "used_for_authority",
      ]);
      expect(expected).toMatchObject({ files_examined: 1, operation_plan_binding_digest: operationPlanBindingDigest,
        used_for_authority: false, may_execute: false });
      const matching = await invokeFileSearch(args, { ...fileSearchEnv(dir), expected_target_version: expected,
        include_target_version_observation: true }) as {
        target_version_observation: typeof expected;
      };
      expect(matching.target_version_observation).toEqual(expected);

      await fs.writeFile(path.join(dir, "a.txt"), "needle changed\n", "utf8");
      await expect(invokeFileSearch(args, { ...fileSearchEnv(dir), expected_target_version: expected }))
        .rejects.toThrow(/target version changed/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("file.search requires BLUE_TANUKI_FILE_ROOT", async () => {
    await expect(
      invokeFileSearch({ root: ".", query: "needle" }, { env: {} }),
    ).rejects.toThrow(/BLUE_TANUKI_FILE_ROOT/);
  });

  it("file.search denies roots outside the sandbox", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    const sandbox = path.join(parent, "sandbox");
    const outside = path.join(parent, "outside");
    try {
      await fs.mkdir(sandbox);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "a.txt"), "needle outside\n", "utf8");

      await expect(
        invokeFileSearch(
          { root: outside, query: "needle" },
          fileSearchEnv(sandbox),
        ),
      ).rejects.toThrow(/BLUE_TANUKI_FILE_ROOT/);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("file.search denies symlink escape from the sandbox", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    const sandbox = path.join(parent, "sandbox");
    const outside = path.join(parent, "outside");
    const link = path.join(sandbox, "link-out");
    try {
      await fs.mkdir(sandbox);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "secret.txt"), "needle outside\n", "utf8");
      await fs.symlink(outside, link, "junction");

      await expect(
        invokeFileSearch(
          { root: "link-out", query: "needle" },
          fileSearchEnv(sandbox),
        ),
      ).rejects.toThrow(/symlink/);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("file.search denies secret-like requested roots and skips secret-like files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      await fs.writeFile(path.join(dir, ".env"), "TOKEN=needle\n", "utf8");
      await fs.writeFile(path.join(dir, "id_rsa"), "needle private key\n", "utf8");
      await fs.writeFile(path.join(dir, "safe.txt"), "needle safe\n", "utf8");

      await expect(
        invokeFileSearch({ root: ".env", query: "needle" }, fileSearchEnv(dir)),
      ).rejects.toThrow(/secret-like path/);

      const result = (await invokeFileSearch(
        { root: ".", query: "needle", max_results: 10 },
        fileSearchEnv(dir),
      )) as {
        matches: Array<{ path: string; line: string }>;
      };

      expect(result.matches).toEqual([
        expect.objectContaining({ path: "safe.txt", line: "needle safe" }),
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.write creates, appends, and overwrites only inside the sandbox", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      await fs.mkdir(path.join(dir, "notes"));
      const created = await invokeFileWrite(
        { path: "notes/a.txt", content: "alpha\n" },
        fileSearchEnv(dir),
      );
      expect(created).toMatchObject({
        path: "notes/a.txt",
        mode: "create",
        bytes_written: 6,
      });
      await invokeFileWrite(
        { path: "notes/a.txt", content: "beta\n", mode: "append" },
        fileSearchEnv(dir),
      );
      expect(await fs.readFile(path.join(dir, "notes", "a.txt"), "utf8")).toBe(
        "alpha\nbeta\n",
      );
      await invokeFileWrite(
        { path: "notes/a.txt", content: "gamma\n", mode: "overwrite" },
        fileSearchEnv(dir),
      );
      expect(await fs.readFile(path.join(dir, "notes", "a.txt"), "utf8")).toBe(
        "gamma\n",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("J計画のfile.writeはpayload変更と実行直前の競合を拒否し、既存内容を保つ", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-plan-write-"));
    const env = { BLUE_TANUKI_FILE_ROOT: dir };
    const args = { path: "notes.txt", content: "reviewed content\n", mode: "create" };
    const operationPlanBindingDigest = "a".repeat(64);
    const commandDigest = "b".repeat(64);
    const evidence = { env, operation_plan_binding_digest: operationPlanBindingDigest, command_digest: commandDigest };
    try {
      const observation = await inspectFileWriteTargetVersion(args, evidence);
      await expect(invokeFileWrite({ ...args, content: "changed after review\n" }, {
        ...evidence, expected_target_version: observation,
      })).rejects.toThrow(/target version changed/);
      await fs.writeFile(path.join(dir, "notes.txt"), "concurrent owner content\n", "utf8");
      await expect(invokeFileWrite(args, { ...evidence, expected_target_version: observation }))
        .rejects.toThrow(/must be absent|target version changed/);
      expect(await fs.readFile(path.join(dir, "notes.txt"), "utf8")).toBe("concurrent owner content\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown結果のfile.writeをsandbox内でdigestだけ照合し、本文を返さない", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-write-outcome-"));
    const env = { BLUE_TANUKI_FILE_ROOT: dir };
    const content = "synthetic write result\n";
    const args = { path: "notes.txt", content, mode: "create", max_bytes: 128 };
    try {
      const absent = await inspectFileWriteOutcomeState(args, { env });
      expect(absent).toMatchObject({ state: "absent" });
      await fs.writeFile(path.join(dir, "notes.txt"), content, "utf8");
      const present = await inspectFileWriteOutcomeState(args, { env });
      expect(present).toMatchObject({ state: "present",
        observed_payload_digest: createHash("sha256").update(content, "utf8").digest("hex") });
      expect(JSON.stringify(present)).not.toContain(content);
      await fs.writeFile(path.join(dir, "notes.txt"), "different content\n", "utf8");
      const mismatch = await inspectFileWriteOutcomeState(args, { env });
      expect(mismatch.state).toBe("present");
      expect(mismatch.observed_payload_digest).not.toBe(present.observed_payload_digest);
      expect(JSON.stringify(mismatch)).not.toContain("different content");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("J計画のfile.deleteはroot・対象identity・変更前hashを結び、競合後の削除を拒否する", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-plan-delete-"));
    const env = { BLUE_TANUKI_FILE_ROOT: dir };
    const args = { path: "notes.txt", max_bytes: 128 };
    const operationPlanBindingDigest = "a".repeat(64);
    const commandDigest = "b".repeat(64);
    const evidence = { env, operation_plan_binding_digest: operationPlanBindingDigest, command_digest: commandDigest };
    try {
      await fs.writeFile(path.join(dir, "notes.txt"), "reviewed delete target\n", "utf8");
      const observation = await inspectFileDeleteTargetVersion(args, evidence);
      expect(observation).toMatchObject({
        operation_plan_binding_digest: operationPlanBindingDigest,
        command_digest: commandDigest,
        target_state: "present",
        used_for_authority: false,
        may_execute: false,
      });
      expect(JSON.stringify(observation)).not.toContain(dir);
      expect(observation.file_content_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(observation)).not.toContain("reviewed delete target");

      await fs.writeFile(path.join(dir, "notes.txt"), "changed after final review\n", "utf8");
      await expect(invokeFileDelete(args, { ...evidence, expected_target_version: observation }))
        .rejects.toThrow(/target version changed/);
      expect(await fs.readFile(path.join(dir, "notes.txt"), "utf8")).toBe("changed after final review\n");

      const current = await inspectFileDeleteTargetVersion(args, evidence);
      await expect(invokeFileDelete(args, { ...evidence, command_digest: "c".repeat(64), expected_target_version: current }))
        .rejects.toThrow(/matching J-selected target evidence/);
      const deleted = await invokeFileDelete(args, { ...evidence, expected_target_version: current });
      expect(deleted).toEqual({ deleted: true });
      await expect(fs.stat(path.join(dir, "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.delete fails closed for unplanned, secret, directory, oversized, and symlink targets", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-delete-target-"));
    const sandbox = path.join(parent, "sandbox");
    const outside = path.join(parent, "outside.txt");
    const binding = "a".repeat(64);
    const command = "b".repeat(64);
    try {
      await fs.mkdir(sandbox);
      await fs.writeFile(path.join(sandbox, ".env"), "secret", "utf8");
      await fs.writeFile(path.join(sandbox, "large.txt"), "x".repeat(20), "utf8");
      await fs.writeFile(outside, "outside", "utf8");
      await fs.symlink(outside, path.join(sandbox, "link.txt"), "file");
      const opts = { env: { BLUE_TANUKI_FILE_ROOT: sandbox }, operation_plan_binding_digest: binding, command_digest: command };
      await expect(inspectFileDeleteTargetVersion({ path: "../outside.txt" }, opts)).rejects.toThrow(/relative path|traversal/);
      await expect(inspectFileDeleteTargetVersion({ path: ".env" }, opts)).rejects.toThrow(/secret-like path/);
      await expect(inspectFileDeleteTargetVersion({ path: "large.txt", max_bytes: 8 }, opts)).rejects.toThrow(/max_bytes/);
      await expect(inspectFileDeleteTargetVersion({ path: "link.txt" }, opts)).rejects.toThrow(/symlink/);
      await expect(inspectFileDeleteTargetVersion({ path: "missing.txt" }, opts)).rejects.toThrow();
      await expect(inspectFileDeleteTargetVersion({ path: outside }, opts)).rejects.toThrow(/relative path|BLUE_TANUKI_FILE_ROOT/);
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("通常file操作は私有runtime状態とそのalias・root指定を拒否する", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-private-state-"));
    const privateDir = path.join(root, "private-state");
    try {
      await fs.mkdir(privateDir);
      await fs.writeFile(path.join(privateDir, "j-state.sqlite"), "needle private runtime");
      await fs.writeFile(path.join(root, "safe.txt"), "needle safe");
      await fs.symlink(privateDir, path.join(root, "alias"), "junction");
      for (const dir of ["private-state", "alias"]) {
        await expect(invokeFileSearch({ root: dir, query: "needle" }, fileSearchEnv(root))).rejects.toThrow(/secret-like/);
        await expect(invokeFileWrite({ path: `${dir}/j-state.sqlite`, content: "changed", mode: "overwrite" }, fileSearchEnv(root)))
          .rejects.toThrow(/secret-like|private runtime/);
      }
      for (const sandbox of [privateDir, path.join(root, "alias")]) {
        await expect(invokeFileSearch({ root: ".", query: "needle" }, fileSearchEnv(sandbox))).rejects.toThrow(/private runtime/);
      }
      const searched = await invokeFileSearch({ root: ".", query: "needle" }, fileSearchEnv(root)) as { matches: Array<{ path: string }> };
      expect(searched.matches.map((match) => match.path)).toEqual(["safe.txt"]);
      expect(await fs.readFile(path.join(privateDir, "j-state.sqlite"), "utf8")).toBe("needle private runtime");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("通常file経路は設定済みHDS記憶と個人化停止台帳を検索・編集・削除できない", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-hds-memory-file-boundary-"));
    const sandbox = path.join(parent, "sandbox");
    const memoryDir = path.join(parent, "memory");
    const memoryFile = path.join(memoryDir, "memory.jsonl");
    const personalizationFile = `${memoryFile}.personalization.jsonl`;
    const binding = "a".repeat(64);
    const command = "b".repeat(64);
    const env = { BLUE_TANUKI_FILE_ROOT: sandbox, BLUE_TANUKI_MEMORY_DIR: memoryDir };
    try {
      await fs.mkdir(sandbox);
      await fs.mkdir(memoryDir);
      await fs.writeFile(memoryFile, "HDS_MEMORY_PRIVATE_SENTINEL\n", "utf8");
      await fs.writeFile(personalizationFile, "HDS_STOP_LEDGER_PRIVATE_SENTINEL\n", "utf8");
      await fs.writeFile(path.join(sandbox, "safe.txt"), "unrelated ordinary file\n", "utf8");
      await fs.link(memoryFile, path.join(sandbox, "memory-alias.jsonl"));
      await fs.link(personalizationFile, path.join(sandbox, "stop-ledger-alias.jsonl"));
      await fs.mkdir(path.join(sandbox, "nested"));
      await fs.link(memoryFile, path.join(sandbox, "nested", "nested-memory-alias.jsonl"));

      const search = await invokeFileSearch({ root: ".", query: "PRIVATE_SENTINEL" }, { env }) as {
        matches: Array<{ path: string; line: string }>;
      };
      expect(search.matches).toEqual([]);
      const ordinarySearch = await invokeFileSearch({ root: ".", query: "ordinary" }, { env }) as {
        matches: Array<{ path: string; line: string }>;
      };
      expect(ordinarySearch.matches.map((match) => match.path)).toEqual(["safe.txt"]);
      await expect(invokeFileSearch({ root: ".", file_path: "memory-alias.jsonl", query: "", max_results: 5 }, { env }))
        .rejects.toThrow(/HDS memory storage/);
      await expect(invokeFileSearch({ root: ".", file_path: "nested/nested-memory-alias.jsonl", query: "", max_results: 5 }, { env }))
        .rejects.toThrow(/HDS memory storage/);
      await expect(invokeFileSearch({ root: ".", file_path: "stop-ledger-alias.jsonl", query: "", max_results: 5 }, { env }))
        .rejects.toThrow(/HDS memory storage/);

      await expect(invokeFileWrite({ path: "memory-alias.jsonl", content: "replacement", mode: "overwrite" }, { env }))
        .rejects.toThrow(/HDS memory storage/);
      await expect(inspectFileEditTargetVersion({ path: "memory-alias.jsonl", search: "PRIVATE", replace: "changed",
        expected_replacements: 1 }, { env, operation_plan_binding_digest: binding, command_digest: command }))
        .rejects.toThrow(/HDS memory storage/);
      await expect(inspectFileDeleteTargetVersion({ path: "memory-alias.jsonl", max_bytes: 1024 }, {
        env, operation_plan_binding_digest: binding, command_digest: command,
      })).rejects.toThrow(/HDS memory storage/);
      await expect(inspectFileDeleteTargetVersion({ path: "stop-ledger-alias.jsonl", max_bytes: 1024 }, {
        env, operation_plan_binding_digest: binding, command_digest: command,
      })).rejects.toThrow(/HDS memory storage/);

      const absentMemoryEnv = { BLUE_TANUKI_FILE_ROOT: sandbox, BLUE_TANUKI_MEMORY_FILE: path.join(sandbox, "not-created.jsonl") };
      await expect(invokeFileWrite({ path: "not-created.jsonl", content: "must not seed M", mode: "create" }, {
        env: absentMemoryEnv,
      })).rejects.toThrow(/HDS memory storage/);
      expect(await fs.readFile(memoryFile, "utf8")).toBe("HDS_MEMORY_PRIVATE_SENTINEL\n");
      expect(await fs.readFile(personalizationFile, "utf8")).toBe("HDS_STOP_LEDGER_PRIVATE_SENTINEL\n");
      await expect(fs.stat(path.join(sandbox, "not-created.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("file.write fails closed for accidental overwrite, sandbox escape, and secret-like paths", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    const sandbox = path.join(parent, "sandbox");
    const outside = path.join(parent, "outside.txt");
    try {
      await fs.mkdir(sandbox);
      await fs.writeFile(path.join(sandbox, "a.txt"), "old", "utf8");
      await expect(
        invokeFileWrite({ path: "a.txt", content: "new" }, fileSearchEnv(sandbox)),
      ).rejects.toThrow(/exist|EEXIST/);
      await expect(
        invokeFileWrite({ path: outside, content: "x" }, fileSearchEnv(sandbox)),
      ).rejects.toThrow(/BLUE_TANUKI_FILE_ROOT/);
      await expect(
        invokeFileWrite({ path: ".env", content: "TOKEN=x" }, fileSearchEnv(sandbox)),
      ).rejects.toThrow(/secret-like path/);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("file.write denies symlink targets", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    const sandbox = path.join(parent, "sandbox");
    const outside = path.join(parent, "outside");
    const link = path.join(sandbox, "link-out");
    try {
      await fs.mkdir(sandbox);
      await fs.mkdir(outside);
      await fs.symlink(outside, link, "junction");
      await expect(
        invokeFileWrite(
          { path: "link-out/a.txt", content: "new", mode: "overwrite" },
          fileSearchEnv(sandbox),
        ),
      ).rejects.toThrow(/symlink/);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("file.edit performs exact replacements with an expected count", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "one fish\none bird\n", "utf8");
      const args = {
        path: "a.txt",
        search: "one",
        replace: "blue",
        expected_replacements: 2,
      };
      const options = { ...fileSearchEnv(dir), command_digest: "a".repeat(64),
        operation_plan_binding_digest: "b".repeat(64) };
      const targetVersion = await inspectFileEditTargetVersion(args, options);
      const edited = await invokeFileEdit(
        args,
        { ...options, expected_target_version: targetVersion },
      );
      expect(edited).toEqual({
        edited: true,
        replacements: 2,
        bytes_written: Buffer.byteLength("blue fish\nblue bird\n"),
      });
      expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe(
        "blue fish\nblue bird\n",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reveals a purpose-bound file.edit diff without applying it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    const before = "one fish\none bird\n";
    try {
      await fs.writeFile(path.join(dir, "a.txt"), before, "utf8");
      const args = { path: "a.txt", search: "one", replace: "blue", expected_replacements: 2 };
      const options = { ...fileSearchEnv(dir), command_digest: "a".repeat(64),
        operation_plan_binding_digest: "b".repeat(64) };
      const review = await inspectFileEditContentReview(args, options);
      expect(review).toMatchObject({ path: "a.txt", replacement_count: 2,
        before_content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        after_content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        target_version_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        operation_plan_binding_digest: options.operation_plan_binding_digest,
        command_digest: options.command_digest,
        used_for_authority: false, may_execute: false });
      expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(review.diff).toContain("@@ -1,1 +1,1 @@ replacement 1/2");
      expect(review.diff).toContain("-one\n+blue\n");
      expect(review.diff).toContain("@@ -2,1 +2,1 @@ replacement 2/2");
      expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.edit refuses replacement-count mismatch and binary-looking files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      const options = { ...fileSearchEnv(dir), command_digest: "a".repeat(64),
        operation_plan_binding_digest: "b".repeat(64) };
      await fs.writeFile(path.join(dir, "a.txt"), "one one\n", "utf8");
      await expect(
        inspectFileEditTargetVersion(
          { path: "a.txt", search: "one", replace: "two" },
          options,
        ),
      ).rejects.toThrow(/expected 1 replacement/);

      await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2]));
      await expect(
        inspectFileEditTargetVersion(
          { path: "b.bin", search: "x", replace: "y" },
          options,
        ),
      ).rejects.toThrow(/binary/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.edit rejects a target changed after J-selected preflight and preserves the changed content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      const args = { path: "a.txt", search: "one", replace: "blue" };
      const options = { ...fileSearchEnv(dir), command_digest: "a".repeat(64),
        operation_plan_binding_digest: "b".repeat(64) };
      await fs.writeFile(path.join(dir, "a.txt"), "one fish\n", "utf8");
      const targetVersion = await inspectFileEditTargetVersion(args, options);
      await fs.writeFile(path.join(dir, "a.txt"), "one owner changed this\n", "utf8");
      await expect(invokeFileEdit(args, { ...options, expected_target_version: targetVersion }))
        .rejects.toThrow(/target version changed/);
      expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("one owner changed this\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("http.fetch is GET/HEAD only and returns a bounded response", async () => {
    const opts = fakeHttp({
      "example.test": { address: "93.184.216.34", family: 4 },
    }, async () => ({
      status: 200,
      ok: true,
      content_type: "text/plain",
      location: null,
      body: "hello",
      truncated: true,
    }));

    const result = (await invokeHttpFetch(
      { url: "https://example.test", max_bytes: 5 },
      opts,
    )) as { status: number; body: string; truncated: boolean };

    expect(result).toMatchObject({
      status: 200,
      body: "hello",
      truncated: true,
    });

    await expect(
      invokeHttpFetch({ url: "https://example.test", method: "POST" }, opts),
    ).rejects.toThrow(/GET or HEAD/);
  });

  it("propagates cancellation to HTTP, GitHub, and Google request adapters", async () => {
    const httpController = new AbortController();
    let httpSignal: AbortSignal | undefined;
    const http = fakeHttp({ "example.test": { address: "93.184.216.34", family: 4 } },
      async (_target, _method, _maxBytes, signal) => {
        httpSignal = signal;
        httpController.abort();
        throw new Error("request aborted");
      });
    await expect(invokeHttpFetch({ url: "https://example.test/" },
      { ...http, signal: httpController.signal })).rejects.toThrow("request aborted");
    expect(httpSignal).toBe(httpController.signal);

    const githubController = new AbortController();
    let githubSignal: AbortSignal | undefined;
    const githubArgs = { operation: "issue.create", owner: "gatchimuchio", repo: "blue-tanuki",
      title: "cancel fixture", body: "no external request" };
    const githubOptions = fakeGitHubWrite(async (_target, signal) => {
      githubSignal = signal;
      githubController.abort();
      throw new Error("request aborted");
    }, { GITHUB_TOKEN: "ghp_fixture", BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki" });
    const githubCommandDigest = "a".repeat(64);
    const githubPlanDigest = "b".repeat(64);
    const githubTargetVersion = await inspectGitHubIssueCreateTargetVersion(githubArgs, {
      ...githubOptions, command_digest: githubCommandDigest, operation_plan_binding_digest: githubPlanDigest,
    });
    await expect(invokeGitHubWrite({ operation: "issue.create", owner: "gatchimuchio", repo: "blue-tanuki",
      title: "cancel fixture", body: "no external request" }, {
      ...githubOptions,
      command_digest: githubCommandDigest,
      operation_plan_binding_digest: githubPlanDigest,
      expected_target_version_observation: githubTargetVersion,
      signal: githubController.signal,
    })).rejects.toThrow(/outcome_unknown.*request aborted/);
    expect(githubSignal).toBe(githubController.signal);

    const googleController = new AbortController();
    let googleSignal: AbortSignal | undefined;
    await expect(invokeGoogleCalendarWrite({ operation: "event.create", summary: "cancel fixture",
      start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z",
      availability_observation: await observedCalendarAvailability() }, {
      ...fakeGoogleWrite(async (_target, signal) => {
        googleSignal = signal;
        googleController.abort();
        throw new Error("request aborted");
      }),
      signal: googleController.signal,
    })).rejects.toThrow("request aborted");
    expect(googleSignal).toBe(googleController.signal);

    const githubReadController = new AbortController();
    let githubReadSignal: AbortSignal | undefined;
    await expect(invokeGitHubRead({ resource: "repo", owner: "gatchimuchio", repo: "blue-tanuki" }, {
      ...fakeGitHub(async (_target, signal) => {
        githubReadSignal = signal;
        githubReadController.abort();
        throw new Error("request aborted");
      }),
      signal: githubReadController.signal,
    })).rejects.toThrow("request aborted");
    expect(githubReadSignal).toBe(githubReadController.signal);

    const googleReadController = new AbortController();
    let googleReadSignal: AbortSignal | undefined;
    await expect(invokeGoogleCalendarRead({ calendar_id: "primary" }, {
      ...fakeGoogle(async (_target, signal) => {
        googleReadSignal = signal;
        googleReadController.abort();
        throw new Error("request aborted");
      }, { GOOGLE_ACCESS_TOKEN: "google-read-fixture" }),
      signal: googleReadController.signal,
    })).rejects.toThrow("request aborted");
    expect(googleReadSignal).toBe(googleReadController.signal);
  });

  it("does not convert a cancelled Google daily brief into a successful unavailable summary", async () => {
    const controller = new AbortController();
    const options = fakeGoogle(async (_target, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new Error("request aborted");
    }, { GOOGLE_ACCESS_TOKEN: "google-read-fixture" });

    await expect(buildGoogleDailyBriefContent({ ...options, signal: controller.signal, services: ["gmail"] }))
      .rejects.toThrow(/cancelled; result is incomplete/);
  });

  it.each([
    ["loopback", "loopback.test", "127.0.0.1"],
    ["private", "private.test", "10.12.0.4"],
    ["metadata", "metadata.test", "169.254.169.254"],
    ["link-local", "linklocal.test", "169.254.10.20"],
  ])("http.fetch denies %s DNS targets", async (_name, host, address) => {
    await expect(
      invokeHttpFetch(
        { url: `http://${host}/secret` },
        fakeHttp({ [host]: { address, family: 4 } }),
      ),
    ).rejects.toThrow(/non-public address/);
  });

  it("http.fetch denies private IPv6 DNS targets", async () => {
    await expect(
      invokeHttpFetch(
        { url: "https://ipv6-private.test/" },
        fakeHttp({
          "ipv6-private.test": { address: "fc00::1", family: 6 },
        }),
      ),
    ).rejects.toThrow(/non-public address/);
  });

  it("http.fetch denies IPv4-mapped IPv6 targets", async () => {
    await expect(
      invokeHttpFetch(
        { url: "https://mapped-loopback.test/" },
        fakeHttp({
          "mapped-loopback.test": { address: "::ffff:7f00:1", family: 6 },
        }),
      ),
    ).rejects.toThrow(/non-public address/);
  });

  it("http.fetch validates every redirect target", async () => {
    const opts = fakeHttp(
      {
        "public.test": { address: "93.184.216.34", family: 4 },
        "metadata.test": { address: "169.254.169.254", family: 4 },
      },
      async (target) => ({
        status: target.hostname === "public.test" ? 302 : 200,
        ok: false,
        content_type: "text/plain",
        location: target.hostname === "public.test"
          ? "http://metadata.test/latest/meta-data"
          : null,
        body: "",
        truncated: false,
      }),
    );

    await expect(
      invokeHttpFetch({ url: "http://public.test/start" }, opts),
    ).rejects.toThrow(/non-public address/);
  });

  it("http.fetch caps redirect chains at three hops", async () => {
    const opts = fakeHttp(
      {
        "a.test": { address: "93.184.216.34", family: 4 },
        "b.test": { address: "93.184.216.35", family: 4 },
        "c.test": { address: "93.184.216.36", family: 4 },
        "d.test": { address: "93.184.216.37", family: 4 },
      },
      async (target) => ({
        status: 302,
        ok: false,
        content_type: null,
        location: `http://${nextRedirectHost(target.hostname)}/`,
        body: "",
        truncated: false,
      }),
    );

    await expect(
      invokeHttpFetch({ url: "http://a.test/start" }, opts),
    ).rejects.toThrow(/redirect limit/);
  });

  it("http.fetch supports optional domain allowlist mode", async () => {
    const opts = fakeHttp({
      "api.example.com": { address: "93.184.216.34", family: 4 },
      "outside.test": { address: "93.184.216.35", family: 4 },
    }, async () => ({
      status: 200,
      ok: true,
      content_type: "text/plain",
      location: null,
      body: "ok",
      truncated: false,
    }));

    await expect(
      invokeHttpFetch(
        { url: "https://api.example.com/" },
        { ...opts, env: { BLUE_TANUKI_HTTP_ALLOWLIST: "example.com" } },
      ),
    ).resolves.toMatchObject({ status: 200, body: "ok" });

    await expect(
      invokeHttpFetch(
        { url: "https://outside.test/" },
        { ...opts, env: { BLUE_TANUKI_HTTP_ALLOWLIST: "example.com" } },
      ),
    ).rejects.toThrow(/BLUE_TANUKI_HTTP_ALLOWLIST/);
  });

  it("web.search uses a configured provider endpoint and parses JSON results", async () => {
    const seen: string[] = [];
    const opts = fakeHttp(
      {
        "search.example.com": { address: "93.184.216.34", family: 4 },
      },
      async (target) => {
        seen.push(target.url.href);
        return {
          status: 200,
          ok: true,
          content_type: "application/json",
          location: null,
          body: JSON.stringify({
            results: [
              {
                title: "Alpha",
                url: "https://example.com/a",
                snippet: "first",
              },
              {
                name: "Beta",
                link: "https://example.com/b",
                description: "second",
              },
            ],
          }),
          truncated: false,
        };
      },
    );

    const result = (await invokeWebSearch(
      { query: "blue tanuki", max_results: 2 },
      {
        ...opts,
        env: {
          BLUE_TANUKI_WEB_SEARCH_ENDPOINT:
            "https://search.example.com/search?q={query}&count={max_results}",
        },
      },
    )) as {
      query: string;
      endpoint: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    };

    expect(seen).toEqual([
      "https://search.example.com/search?q=blue%20tanuki&count=2",
    ]);
    expect(result.query).toBe("blue tanuki");
    expect(result.endpoint).toBe(seen[0]);
    expect(result.results).toEqual([
      { title: "Alpha", url: "https://example.com/a", snippet: "first" },
      { title: "Beta", url: "https://example.com/b", snippet: "second" },
    ]);
  });

  it("web.search fails closed when no provider endpoint is configured", async () => {
    await expect(
      invokeWebSearch(
        { query: "blue tanuki" },
        fakeHttp({ "search.example.com": { address: "93.184.216.34", family: 4 } }),
      ),
    ).rejects.toThrow(/BLUE_TANUKI_WEB_SEARCH_ENDPOINT/);
  });

  it("web.search inherits http.fetch SSRF and allowlist enforcement", async () => {
    await expect(
      invokeWebSearch(
        { query: "metadata" },
        {
          ...fakeHttp({
            "metadata.test": { address: "169.254.169.254", family: 4 },
          }),
          env: {
            BLUE_TANUKI_WEB_SEARCH_ENDPOINT:
              "http://metadata.test/search?q={query}",
          },
        },
      ),
    ).rejects.toThrow(/non-public address/);

    await expect(
      invokeWebSearch(
        { query: "outside" },
        {
          ...fakeHttp({
            "outside.test": { address: "93.184.216.34", family: 4 },
          }),
          env: {
            BLUE_TANUKI_WEB_SEARCH_ENDPOINT:
              "https://outside.test/search?q={query}",
            BLUE_TANUKI_HTTP_ALLOWLIST: "example.com",
          },
        },
      ),
    ).rejects.toThrow(/BLUE_TANUKI_HTTP_ALLOWLIST/);
  });

  it("github.read reads public repo metadata from fixed GitHub API paths", async () => {
    const seen: Array<{ path: string; maxBytes: number }> = [];
    const result = (await invokeGitHubRead(
      {
        resource: "issues",
        owner: "gatchimuchio",
        repo: "blue-tanuki",
        state: "closed",
        max_results: 2,
        max_bytes: 4096,
      },
      fakeGitHub(async (target) => {
        seen.push(target);
        return {
          status: 200,
          ok: true,
          content_type: "application/json",
          body: JSON.stringify([{ number: 1, title: "done" }]),
          truncated: false,
          rate_limit_remaining: "59",
        };
      }),
    )) as {
      resource: string;
      api_host: string;
      path: string;
      status: number;
      rate_limit_remaining: string;
      data: Array<{ number: number; title: string }>;
    };

    expect(seen).toEqual([
      {
        path: "/repos/gatchimuchio/blue-tanuki/issues?state=closed&per_page=2",
        maxBytes: 4096,
      },
    ]);
    expect(result).toMatchObject({
      resource: "issues",
      api_host: "api.github.com",
      path: "/repos/gatchimuchio/blue-tanuki/issues?state=closed&per_page=2",
      status: 200,
      rate_limit_remaining: "59",
      data: [{ number: 1, title: "done" }],
    });
  });

  it("github.read fails closed for invalid resources and path components", async () => {
    await expect(
      invokeGitHubRead(
        { resource: "release", owner: "gatchimuchio", repo: "blue-tanuki" },
        fakeGitHub(),
      ),
    ).rejects.toThrow(/resource/);

    await expect(
      invokeGitHubRead(
        { resource: "repo", owner: "gatchimuchio/escape", repo: "blue-tanuki" },
        fakeGitHub(),
      ),
    ).rejects.toThrow(/owner/);

    await expect(
      invokeGitHubRead(
        { resource: "pr", owner: "gatchimuchio", repo: "blue-tanuki" },
        fakeGitHub(),
      ),
    ).rejects.toThrow(/number/);
  });

  it("Google read tools use fixed Google APIs and return bounded read-only summaries", async () => {
    const seen: Array<{
      service: string;
      hostname: string;
      path: string;
      maxBytes: number;
      token: string;
    }> = [];
    const opts = fakeGoogle(async (target) => {
      seen.push({
        service: target.service,
        hostname: target.hostname,
        path: target.path,
        maxBytes: target.maxBytes,
        token: target.token,
      });
      if (target.path.startsWith("/gmail/v1/users/me/messages?")) {
        return googleJson({ messages: [{ id: "msg-1" }] });
      }
      if (target.path.startsWith("/gmail/v1/users/me/messages/msg-1?")) {
        return googleJson({
          id: "msg-1",
          threadId: "thread-1",
          snippet: "Hello from Gmail",
          payload: {
            headers: [
              { name: "Subject", value: "Daily report" },
              { name: "From", value: "ops@example.test" },
              { name: "Date", value: "Tue, 12 May 2026 09:00:00 +0000" },
            ],
          },
        });
      }
      if (target.path.startsWith("/calendar/v3/calendars/primary/events?")) {
        return googleJson({
          items: [
            {
              id: "event-1",
              status: "confirmed",
              summary: "Standup",
              start: { dateTime: "2026-05-12T09:00:00Z" },
              end: { dateTime: "2026-05-12T09:15:00Z" },
              htmlLink: "https://calendar.google.com/event?eid=event-1",
            },
          ],
        });
      }
      if (target.path.startsWith("/drive/v3/files?")) {
        return googleJson({
          files: [
            {
              id: "file-1",
              name: "Spec notes",
              mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-05-12T08:00:00Z",
              webViewLink: "https://drive.google.com/file/d/file-1/view",
            },
          ],
        });
      }
      throw new Error(`unexpected Google path: ${target.path}`);
    });

    const gmail = (await invokeGmailRead(
      { query: "newer_than:1d", max_results: 1, max_bytes: 4096 },
      opts,
    )) as { service: string; mutation_sent: boolean; messages: Array<{ subject: string }> };
    const calendar = (await invokeGoogleCalendarRead(
      { calendar_id: "primary", days: 1, max_results: 1, max_bytes: 4096 },
      opts,
    )) as { service: string; events: Array<{ summary: string }> };
    const drive = (await invokeGoogleDriveRead(
      { query: "trashed=false", max_results: 1, max_bytes: 4096 },
      opts,
    )) as { service: string; files: Array<{ name: string }> };

    expect(gmail).toMatchObject({
      service: "gmail",
      mutation_sent: false,
      messages: [{ subject: "Daily report" }],
    });
    expect(calendar.events).toMatchObject([{ id: "event-1", status: "confirmed", summary: "Standup",
      start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z",
      html_link: "https://calendar.google.com/event?eid=event-1", identity_complete: false,
      event_id: { original: "event-1", normalized: "event-1" },
      start_identity: { kind: "date_time", complete: true }, end_identity: { kind: "date_time", complete: true } }]);
    expect(drive.files).toMatchObject([{ id: "file-1", name: "Spec notes",
      mime_type: "application/vnd.google-apps.document", modified_time: "2026-05-12T08:00:00Z",
      web_view_link: "https://drive.google.com/file/d/file-1/view" }]);
    expect(seen.map((item) => item.hostname)).toEqual([
      "gmail.googleapis.com",
      "gmail.googleapis.com",
      "www.googleapis.com",
      "www.googleapis.com",
    ]);
    expect(seen.every((item) => item.maxBytes === 4096)).toBe(true);
    expect(JSON.stringify({ gmail, calendar, drive })).not.toContain("google-token");
  });

  it("Google read tools fail closed before network when tokens are missing", async () => {
    let called = false;
    const opts = fakeGoogle(async () => {
      called = true;
      throw new Error("should not call network");
    }, {});

    await expect(
      invokeGmailRead({ query: "newer_than:1d" }, opts),
    ).rejects.toThrow(/GMAIL_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleCalendarRead({ calendar_id: "primary" }, opts),
    ).rejects.toThrow(/GOOGLE_CALENDAR_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleDriveRead({ query: "trashed=false" }, opts),
    ).rejects.toThrow(/GOOGLE_DRIVE_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    expect(called).toBe(false);
  });

  it("Google Daily Brief content composes read-only service summaries without exposing tokens", async () => {
    const content = await buildGoogleDailyBriefContent({
      ...fakeGoogle(async (target) => {
        if (target.path.startsWith("/gmail/v1/users/me/messages?")) return googleJson({ messages: [{ id: "msg-1" }] });
        if (target.path.startsWith("/gmail/v1/users/me/messages/msg-1?")) {
          return googleJson({
            id: "msg-1",
            payload: { headers: [{ name: "Subject", value: "Inbox item" }, { name: "From", value: "ops@example.test" }] },
          });
        }
        if (target.path.startsWith("/calendar/v3/calendars/primary/events?")) {
          return googleJson({ items: [{ id: "event-1", summary: "Standup", start: { dateTime: "2026-05-12T09:00:00Z" } }] });
        }
        if (target.path.startsWith("/drive/v3/files?")) {
          return googleJson({ files: [{ id: "file-1", name: "Spec notes", modifiedTime: "2026-05-12T08:00:00Z" }] });
        }
        throw new Error(`unexpected Google path: ${target.path}`);
      }),
      maxResults: 1,
    });

    expect(content).toContain("source=google_read read_only=true mutation_sent=false");
    expect(content).toContain("Gmail: 1 message(s)");
    expect(content).toContain("Calendar: 1 event(s)");
    expect(content).toContain("Drive: 1 file(s)");
    expect(content).not.toContain("google-token");
  });

  it("Google write tools use fixed Google APIs and return audit-safe mutation summaries", async () => {
    const seen: Array<{
      service: string;
      hostname: string;
      path: string;
      method: string;
      token: string;
      body?: string;
      contentType?: string;
    }> = [];
    const opts = fakeGoogleWrite(async (target) => {
      seen.push({
        service: target.service,
        hostname: target.hostname,
        path: target.path,
        method: target.method,
        token: target.token,
        body: target.body,
        contentType: target.contentType,
      });
      if (target.path === "/gmail/v1/users/me/drafts") {
        return googleWriteJson({ id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } }, 200);
      }
      if (target.path.startsWith("/calendar/v3/calendars/primary/events?")) {
        return googleWriteJson({
          id: "event-1",
          status: "confirmed",
          summary: "Standup",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
        }, 200);
      }
      const driveRead = syntheticDriveCreateRead(target);
      if (driveRead) return driveRead;
      throw new Error(`unexpected Google write path: ${target.path}`);
    });

    const gmail = (await invokeGmailWrite(
      {
        operation: "draft.create",
        to: "owner@example.test",
        subject: "Draft subject",
        body_text: "draft body",
        max_bytes: 4096,
      },
      opts,
    )) as { mutation_sent: boolean; mutation_status: string; result: Record<string, unknown> };
    const availabilityObservation = await observedCalendarAvailability();
    const calendar = (await invokeGoogleCalendarWrite(
      {
        operation: "event.create",
        calendar_id: "primary",
        summary: "Standup",
        start: "2026-05-12T09:00:00Z",
        end: "2026-05-12T09:15:00Z",
        availability_observation: availabilityObservation,
        max_bytes: 4096,
      },
      opts,
    )) as { result: Record<string, unknown> };
    const driveArgs = { operation: "file.create", parent_id: "parent-1", name: "notes.txt",
      content: "hello", mime_type: "text/plain", max_bytes: 4096 };
    const driveCommandDigest = "a".repeat(64);
    const driveTargetVersionObservation = await inspectGoogleDriveWriteTargetVersion(driveArgs, {
      ...opts, command_digest: driveCommandDigest, operation_plan_binding_digest: "b".repeat(64),
    });
    const drive = (await invokeGoogleDriveWrite(driveArgs, { ...opts, command_digest: driveCommandDigest,
      target_version_observation: driveTargetVersionObservation })) as { result: Record<string, unknown> };

    expect(gmail).toMatchObject({
      mutation_sent: true,
      mutation_status: "confirmed",
      result: { id: "draft-1", message_id: "msg-1", message_thread_id: "thread-1" },
    });
    expect(calendar.result).toMatchObject({ id: "event-1", status: "confirmed", summary: "Standup" });
    expect(drive.result).toMatchObject({ id: "file-1", verification: { name: "notes.txt", mime_type: "text/plain",
      metadata_verified: true, content_verified: true } });
    expect(seen.filter((item) => item.method === "POST").map((item) => [item.service, item.hostname, item.method])).toEqual([
      ["gmail", "gmail.googleapis.com", "POST"],
      ["calendar", "www.googleapis.com", "POST"],
      ["drive", "www.googleapis.com", "POST"],
    ]);
    expect(seen.find((item) => item.service === "gmail" && item.method === "POST")!.body).toContain("raw");
    expect(seen.find((item) => item.service === "calendar" && item.method === "POST")!.path).toContain("sendUpdates=none");
    expect(seen.find((item) => item.service === "calendar" && item.method === "POST")!.body).not.toContain("attendees");
    expect(seen.find((item) => item.service === "drive" && item.method === "POST")!.contentType).toContain("multipart/related");
    expect(JSON.stringify({ gmail, calendar, drive })).not.toContain("google-write-token");
  });

  it("Google write tools fail closed before network when tokens or required args are missing", async () => {
    let called = false;
    const opts = fakeGoogleWrite(async () => {
      called = true;
      throw new Error("should not call network");
    }, {});
    const driveArgs = { operation: "file.create", parent_id: "parent-1", name: "notes.txt", content: "hello" };
    const driveTargetVersionObservation = await inspectGoogleDriveWriteTargetVersion(driveArgs, {
      ...fakeGoogleWrite(syntheticDriveCreateRead), command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64),
    });

    await expect(
      invokeGmailWrite({ operation: "message.send", to: "owner@example.test", subject: "hi", body_text: "hello" }, opts),
    ).rejects.toThrow(/GMAIL_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleCalendarWrite({ operation: "event.create", summary: "Standup", start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z", availability_observation: await observedCalendarAvailability() }, opts),
    ).rejects.toThrow(/GOOGLE_CALENDAR_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleDriveWrite(driveArgs, { ...opts, command_digest: "a".repeat(64),
        target_version_observation: driveTargetVersionObservation }),
    ).rejects.toThrow(/GOOGLE_DRIVE_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);

    await expect(
      invokeGoogleCalendarWrite(
        { operation: "event.create", summary: "Standup", start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z", attendees: "owner@example.test" },
        fakeGoogleWrite(async () => {
          called = true;
          throw new Error("should not call network");
        }),
      ),
    ).rejects.toThrow(/attendees.*mutation_sent=false/);
    expect(called).toBe(false);
  });

  it("github.write creates an issue only with token and allowlisted repo", async () => {
    const seen: Array<{
      method: string;
      path: string;
      body: Record<string, unknown>;
      maxBytes: number;
      token: string;
    }> = [];
    const readPaths: string[] = [];
    const args = {
      operation: "issue.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "Phase smoke",
      body: "created by test",
      max_bytes: 4096,
    };
    const baseOptions = fakeGitHubWrite(async (target) => {
      seen.push(target);
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 123,
          number: 7,
          title: "Phase smoke",
          body: "created by test",
          html_url: "https://github.com/gatchimuchio/blue-tanuki/issues/7",
        }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "ABC123",
      };
    }, undefined, async (target) => {
      readPaths.push(target.path);
      expect(target.token).toBe("ghp_dummy");
      return {
        status: 200,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
          owner: { login: "gatchimuchio" }, private: false }),
        truncated: false,
        rate_limit_remaining: "58",
      };
    });
    const options = await reviewedGitHubIssue(args, baseOptions);
    const result = (await invokeGitHubWrite(
      args,
      options,
    )) as {
      operation: string;
      api_host: string;
      repo: string;
      method: string;
      path: string;
      status: number;
      github_request_id: string;
      result_digest: string;
      result: { id: number; number: number; title: string };
    };

    expect(seen).toEqual([
      {
        method: "POST",
        path: "/repos/gatchimuchio/blue-tanuki/issues",
        body: { title: "Phase smoke", body: "created by test" },
        maxBytes: 4096,
        token: "ghp_dummy",
      },
    ]);
    expect(result).toMatchObject({
      operation: "issue.create",
      api_host: "api.github.com",
      repo: "gatchimuchio/blue-tanuki",
      method: "POST",
      path: "/repos/gatchimuchio/blue-tanuki/issues",
      status: 201,
      github_request_id: "ABC123",
      result: {
        id: 123,
        number: 7,
        title: "Phase smoke",
      },
    });
    expect(result.result_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readPaths).toEqual([
      "/repos/gatchimuchio/blue-tanuki",
      "/repos/gatchimuchio/blue-tanuki",
    ]);
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
    expect(JSON.stringify(result)).not.toContain("html_url");
  });

  it("github.write issue.create sends no mutation when the reviewed repository identity changes", async () => {
    const args = {
      operation: "issue.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "Stale target",
      body: "must not be sent",
    };
    let reads = 0;
    let writes = 0;
    const options = await reviewedGitHubIssue(args, fakeGitHubWrite(async () => {
      writes += 1;
      throw new Error("mutation must not be sent for a stale target");
    }, undefined, async () => {
      reads += 1;
      return {
        status: 200,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 123,
          name: "blue-tanuki",
          full_name: "gatchimuchio/blue-tanuki",
          owner: { login: "gatchimuchio" },
          private: reads > 1,
        }),
        truncated: false,
        rate_limit_remaining: "58",
      };
    }));

    await expect(invokeGitHubWrite(args, options))
      .rejects.toThrow(/repository target changed after review.*mutation_sent=false/);
    expect(reads).toBe(2);
    expect(writes).toBe(0);
  });

  it("github.write issue.create content review binds the exact repository and payload without authority", async () => {
    const args = {
      operation: "issue.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "Reviewed title",
      body: "Reviewed body",
    };
    const review = await inspectGitHubIssueCreateContentReview(args, {
      ...fakeGitHubWrite(),
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
    });

    expect(review).toMatchObject({
      kind: "github_issue_create",
      operation: "github.write.issue.create",
      requested_owner: "gatchimuchio",
      requested_repo: "blue-tanuki",
      canonical_full_name: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      repository_visibility: "public",
      title: "Reviewed title",
      body: "Reviewed body",
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
      notification_effect: "github_api_may_trigger_notifications",
      provider_observation_is_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(review.request_payload_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(review)).not.toContain("ghp_dummy");
  });

  it("github.write issue.update review binds the current issue and exact requested changes without authority", async () => {
    const args = {
      operation: "issue.update",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      title: "Revised title",
    };
    const options = fakeGitHubIssueUpdate();
    const review = await inspectGitHubIssueUpdateContentReview(args, {
      ...options,
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
    });

    expect(review).toMatchObject({
      kind: "github_issue_update",
      operation: "github.write.issue.update",
      canonical_full_name: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      repository_visibility: "public",
      issue_id: 456,
      issue_number: 7,
      issue_state: "open",
      issue_locked: false,
      issue_updated_at: "2026-11-07T12:00:00Z",
      current_title: "Original title",
      current_body: "Original body",
      requested_title: "Revised title",
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
      notification_effect: "github_api_may_trigger_notifications",
      provider_observation_is_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(review.request_payload_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(review)).not.toContain("ghp_dummy");
  });

  it("github.write issue.update rechecks the exact issue before one PATCH and verifies the receipt", async () => {
    const args = {
      operation: "issue.update",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      title: "Revised title",
      body: "Revised body",
    };
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const options = await reviewedGitHubIssueUpdate(args, fakeGitHubIssueUpdate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 200,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 456,
          number: 7,
          state: "open",
          locked: false,
          updated_at: "2026-11-08T01:00:00Z",
          title: "Revised title",
          body: "Revised body",
          html_url: "https://github.com/gatchimuchio/blue-tanuki/issues/7",
        }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "UPDATE123",
      };
      }));

    const result = await invokeGitHubWrite(args, options) as Record<string, unknown>;
    expect(seen).toEqual([{
      method: "PATCH",
      path: "/repos/gatchimuchio/blue-tanuki/issues/7",
      body: { title: "Revised title", body: "Revised body" },
    }]);
    expect(result).toMatchObject({
      operation: "issue.update",
      method: "PATCH",
      status: 200,
      mutation_status: "provider_accepted",
      result: { id: 456, number: 7, title: "Revised title", state: "open", locked: false },
      provider_data_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    });
    expect(JSON.stringify(result)).not.toContain("html_url");
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write issue.update reports a mismatched PATCH receipt as unknown without retrying", async () => {
    const args = {
      operation: "issue.update",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      title: "Requested title",
    };
    let writes = 0;
    const options = await reviewedGitHubIssueUpdate(args, fakeGitHubIssueUpdate(async () => {
      writes += 1;
      return {
        status: 200,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 456,
          number: 7,
          state: "open",
          locked: false,
          updated_at: "2026-11-08T01:00:00Z",
          title: "Different title",
          body: "Original body",
        }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "MISMATCH",
      };
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/outcome_unknown; do not retry automatically/);
    expect(writes).toBe(1);
  });

  it("github.write issue.update sends no PATCH after the reviewed issue state changes", async () => {
    const args = {
      operation: "issue.update",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      body: "New body",
    };
    let reads = 0;
    let writes = 0;
    const options = await reviewedGitHubIssueUpdate(args, fakeGitHubIssueUpdate(async () => {
      writes += 1;
      throw new Error("stale issue must not be patched");
    }, async (target) => {
      reads += 1;
      if (target.path.endsWith("/issues/7")) {
        const changed = reads > 2;
        return githubReadJson({
          id: 456,
          number: 7,
          state: changed ? "closed" : "open",
          locked: false,
          updated_at: changed ? "2026-11-08T01:00:00Z" : "2026-11-07T12:00:00Z",
          title: "Original title",
          body: "Original body",
        });
      }
      return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, default_branch: "main", private: false });
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/target changed after review.*outcome=stale/);
    expect(reads).toBe(4);
    expect(writes).toBe(0);
  });

  it("github.write issue.update rejects pull requests before any PATCH", async () => {
    let writes = 0;
    const args = { operation: "issue.update", owner: "gatchimuchio", repo: "blue-tanuki", number: 7, title: "No PR edit" };
    const options = fakeGitHubIssueUpdate(async () => {
      writes += 1;
      throw new Error("pull requests are not issue.update targets");
    }, async (target) => target.path.endsWith("/issues/7")
      ? githubReadJson({ id: 456, number: 7, state: "open", locked: false, updated_at: "2026-11-07T12:00:00Z",
        title: "PR title", body: null, pull_request: { url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" } })
      : githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false }));

    await expect(inspectGitHubIssueUpdateTargetVersion(args, {
      ...options, command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/target is a pull request.*BUILD_GAP/);
    expect(writes).toBe(0);
  });

  it("github.write issue.comment.create review binds the exact issue and comment without authority", async () => {
    const args = {
      operation: "issue.comment.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      body: "Reviewed comment body",
    };
    const options = fakeGitHubIssueCommentCreate();
    const review = await inspectGitHubIssueCommentCreateContentReview(args, {
      ...options,
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
    });

    expect(review).toMatchObject({
      kind: "github_issue_comment_create",
      operation: "github.write.issue.comment.create",
      canonical_full_name: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      repository_visibility: "public",
      issue_id: 456,
      issue_number: 7,
      issue_state: "open",
      issue_locked: false,
      issue_updated_at: "2026-11-07T12:00:00Z",
      issue_title: "Original title",
      body: args.body,
      command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
      notification_effect: "github_api_may_trigger_notifications",
      provider_observation_is_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(review.request_payload_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.target_version_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(review)).not.toContain("ghp_dummy");
  });

  it("github.write issue.comment.create rechecks the issue and verifies one exact POST receipt", async () => {
    const args = {
      operation: "issue.comment.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      body: "One exact comment",
    };
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const options = await reviewedGitHubIssueCommentCreate(args, fakeGitHubIssueCommentCreate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 789, body: args.body, issue_url: "https://api.github.test/ignored" }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "COMMENT123",
      };
    }));

    const result = await invokeGitHubWrite(args, options) as Record<string, unknown>;
    expect(seen).toEqual([{
      method: "POST",
      path: "/repos/gatchimuchio/blue-tanuki/issues/7/comments",
      body: { body: args.body },
    }]);
    expect(result).toMatchObject({
      operation: "issue.comment.create",
      method: "POST",
      status: 201,
      mutation_status: "provider_accepted",
      result: { id: 789 },
      provider_data_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    });
    expect(JSON.stringify(result)).not.toContain(args.body);
    expect(JSON.stringify(result)).not.toContain("issue_url");
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write issue.comment.create stops on a stale issue without POST", async () => {
    const args = {
      operation: "issue.comment.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      body: "Do not post on changed issue",
    };
    let reads = 0;
    let writes = 0;
    const options = await reviewedGitHubIssueCommentCreate(args, fakeGitHubIssueCommentCreate(async () => {
      writes += 1;
      throw new Error("stale issue must not receive a comment");
    }, async (target) => {
      reads += 1;
      if (target.path.endsWith("/issues/7")) {
        return githubReadJson({
          id: 456,
          number: 7,
          state: reads > 2 ? "closed" : "open",
          locked: false,
          updated_at: reads > 2 ? "2026-11-08T01:00:00Z" : "2026-11-07T12:00:00Z",
          title: "Original title",
          body: "Ignored issue body",
        });
      }
      return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, default_branch: "main", private: false });
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/target changed after review.*outcome=stale/);
    expect(reads).toBe(4);
    expect(writes).toBe(0);
  });

  it("github.write issue.comment.create rejects pull requests and locked issues before POST", async () => {
    let writes = 0;
    const args = { operation: "issue.comment.create", owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "comment" };
    const pullRequest = fakeGitHubIssueCommentCreate(async () => {
      writes += 1;
      throw new Error("pull requests are handled by another operation");
    }, async (target) => target.path.endsWith("/issues/7")
      ? githubReadJson({ id: 456, number: 7, state: "open", locked: false, updated_at: "2026-11-07T12:00:00Z",
        title: "PR title", body: null, pull_request: { url: "https://api.github.test/pulls/7" } })
      : githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false }));
    await expect(inspectGitHubIssueCommentCreateTargetVersion(args, {
      ...pullRequest, command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/target is a pull request.*BUILD_GAP/);

    const lockedIssue = fakeGitHubIssueCommentCreate(async () => {
      writes += 1;
      throw new Error("locked issue must not receive a comment");
    }, async (target) => target.path.endsWith("/issues/7")
      ? githubReadJson({ id: 456, number: 7, state: "open", locked: true, updated_at: "2026-11-07T12:00:00Z",
        title: "Locked issue", body: null })
      : githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false }));
    await expect(inspectGitHubIssueCommentCreateTargetVersion(args, {
      ...lockedIssue, command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/target is locked.*BLOCKED_AUTHORITY/);
    expect(writes).toBe(0);
  });

  it("github.write issue.comment.create marks an unconfirmed POST result unknown without retry", async () => {
    const args = {
      operation: "issue.comment.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      number: 7,
      body: "Expected comment",
    };
    let writes = 0;
    const options = await reviewedGitHubIssueCommentCreate(args, fakeGitHubIssueCommentCreate(async () => {
      writes += 1;
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 789, body: "Different comment" }),
        truncated: false,
        rate_limit_remaining: "58",
      };
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/outcome_unknown; do not retry automatically/);
    expect(writes).toBe(1);
  });

  it("github.write pr.comment.create reviews the exact PR timeline target and body", async () => {
    const args = { operation: "pr.comment.create", owner: "gatchimuchio", repo: "blue-tanuki",
      number: 7, body: "Reviewed PR timeline comment" };
    const review = await inspectGitHubPullRequestCommentCreateContentReview(args, {
      ...fakeGitHubPullRequestCommentCreate(), command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
    });

    expect(review).toMatchObject({
      kind: "github_pull_request_comment_create",
      operation: "github.write.pr.comment.create",
      canonical_full_name: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      repository_visibility: "public",
      pull_request_id: 456,
      pull_request_number: 7,
      pull_request_state: "open",
      pull_request_locked: false,
      pull_request_updated_at: "2026-11-07T12:00:00Z",
      pull_request_title: "Original pull request title",
      comment_kind: "pull_request_timeline",
      body: args.body,
      notification_effect: "github_api_may_trigger_notifications",
      publication_effect: "visible_to_repository_audience",
      comment_removal_retracts_notifications: false,
      provider_observation_is_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("github.write pr.comment.create reviews a single exact diff line and binds both PR commits", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Reviewed diff line",
      path: "src/a.ts", line: 10, side: "RIGHT" };
    const review = await inspectGitHubPullRequestCommentCreateContentReview(args, {
      ...fakeGitHubPullRequestCommentCreate(), command_digest: "e".repeat(64),
      operation_plan_binding_digest: "f".repeat(64),
    });

    expect(review).toMatchObject({
      kind: "github_pull_request_comment_create",
      comment_kind: "pull_request_review_inline",
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
      head_commit_sha: "c".repeat(40),
      base_commit_sha: "d".repeat(40),
      diff_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      diff_excerpt: expect.stringContaining("> - | 10 | +new line"),
      body: args.body,
      provider_observation_is_atomic: false,
      used_for_authority: false,
      may_execute: false,
    });
    expect(review.review_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(review)).not.toContain("secret");
  });

  it("github.write pr.comment.create sends an inline comment once at the reviewed head and exact location", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "One inline review comment",
      path: "src/a.ts", line: 10, side: "RIGHT" };
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const options = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 791, body: args.body, path: args.path, line: args.line, side: args.side,
          commit_id: "c".repeat(40), pull_request_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "PR-INLINE-COMMENT123",
      };
    }));

    const result = await invokeGitHubWrite(args, options) as Record<string, unknown>;
    expect(seen).toEqual([{ method: "POST", path: "/repos/gatchimuchio/blue-tanuki/pulls/7/comments",
      body: { body: args.body, path: args.path, line: args.line, side: args.side, commit_id: "c".repeat(40) } }]);
    expect(result).toMatchObject({ operation: "pr.comment.create", status: 201, mutation_status: "provider_accepted",
      method: "POST", path: "/repos/gatchimuchio/blue-tanuki/pulls/7/comments", result: { id: 791 },
      provider_data_is_untrusted: true, used_for_authority: false, may_execute: false });
    expect(JSON.stringify(result)).not.toContain(args.body);
    expect(JSON.stringify(result)).not.toContain("pull_request_url");
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write pr.comment.create accepts a forward cross-side range when file line numbers descend", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Review replaced lines",
      path: "src/a.ts", start_line: 11, start_side: "LEFT", line: 9, side: "RIGHT" };
    const patch = "@@ -9,3 +9,1 @@\n-old line nine\n-old line ten\n-old line eleven\n+new line nine";
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const defaultRead = fakeGitHubPullRequestCommentCreate().read_request!;
    const options = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 792, body: args.body, path: args.path, start_line: args.start_line,
          start_side: args.start_side, line: args.line, side: args.side, commit_id: "c".repeat(40),
          pull_request_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "PR-INLINE-RANGE-COMMENT123",
      };
    }, async (target, signal) => target.path.includes("/pulls/7/files?")
      ? githubReadJson([{ filename: "src/a.ts", status: "modified", patch }])
      : defaultRead(target, signal)));

    const review = await inspectGitHubPullRequestCommentCreateContentReview(args, options);
    expect(review).toMatchObject({ start_line: 11, start_side: "LEFT", line: 9, side: "RIGHT",
      diff_excerpt: expect.stringContaining("> 11 | - | -old line eleven\n> - | 9 | +new line nine") });
    await expect(invokeGitHubWrite(args, options)).resolves.toMatchObject({
      operation: "pr.comment.create", mutation_status: "provider_accepted", result: { id: 792 },
    });
    expect(seen).toEqual([{ method: "POST", path: "/repos/gatchimuchio/blue-tanuki/pulls/7/comments",
      body: { body: args.body, path: args.path, start_line: 11, start_side: "LEFT", line: 9, side: "RIGHT",
        commit_id: "c".repeat(40) } }]);
  });

  it("github.write pr.comment.create rejects a range whose endpoint order is reversed in the diff", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Reversed range",
      path: "src/a.ts", start_line: 9, start_side: "RIGHT", line: 11, side: "LEFT" };
    const patch = "@@ -9,3 +9,1 @@\n-old line nine\n-old line ten\n-old line eleven\n+new line nine";
    let writes = 0;
    const defaultRead = fakeGitHubPullRequestCommentCreate().read_request!;
    const options = fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("reversed range must not be posted");
    }, async (target, signal) => target.path.includes("/pulls/7/files?")
      ? githubReadJson([{ filename: "src/a.ts", status: "modified", patch }])
      : defaultRead(target, signal));
    await expect(reviewedGitHubPullRequestCommentCreate(args, options))
      .rejects.toThrow(/reversed or crosses pull request diff hunks/);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create refuses a selected range larger than the bounded review excerpt", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Oversized range",
      path: "src/a.ts", start_line: 1, start_side: "RIGHT", line: 7, side: "RIGHT" };
    const additions = Array.from({ length: 7 }, () => `+${"x".repeat(600)}`).join("\n");
    const patch = `@@ -1,0 +1,7 @@\n${additions}`;
    let writes = 0;
    const defaultRead = fakeGitHubPullRequestCommentCreate().read_request!;
    const options = fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("oversized range must not be posted");
    }, async (target, signal) => target.path.includes("/pulls/7/files?")
      ? githubReadJson([{ filename: "src/a.ts", status: "modified", patch }])
      : defaultRead(target, signal));
    await expect(reviewedGitHubPullRequestCommentCreate(args, options))
      .rejects.toThrow(/exceeds the bounded Owner review excerpt/);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create rejects an inline line missing from the current diff before POST", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Invalid line",
      path: "src/a.ts", line: 99, side: "RIGHT" };
    let writes = 0;
    await expect(reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("invalid diff line must not be posted");
    }))).rejects.toThrow(/not a unique line in the current pull request diff/);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create refuses to POST when the reviewed diff changes", async () => {
    const args = { operation: "pr.comment.create", comment_kind: "pull_request_review_inline",
      owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "Do not post on changed diff",
      path: "src/a.ts", line: 10, side: "RIGHT" };
    let diffReads = 0;
    let writes = 0;
    const defaultRead = fakeGitHubPullRequestCommentCreate().read_request!;
    const options = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("changed reviewed diff must not receive a comment");
    }, async (target, signal) => {
      if (target.path.includes("/pulls/7/files?")) {
        diffReads += 1;
        const patch = diffReads === 1
          ? "@@ -9,2 +9,3 @@\n context line\n-old line\n+new line\n+extra line"
          : "@@ -9,2 +9,3 @@\n context line\n-old line\n+changed source line\n+extra line";
        return githubReadJson([{ filename: "src/a.ts", status: "modified", patch }]);
      }
      return defaultRead(target, signal);
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/target changed after review.*outcome=stale/);
    expect(diffReads).toBe(2);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create rechecks the PR and sends one exact timeline POST", async () => {
    const args = { operation: "pr.comment.create", owner: "gatchimuchio", repo: "blue-tanuki",
      number: 7, body: "One exact PR comment" };
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const options = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ id: 790, body: args.body,
          issue_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/issues/7" }),
        truncated: false,
        rate_limit_remaining: "58",
        request_id: "PR-COMMENT123",
      };
    }));

    const result = await invokeGitHubWrite(args, options) as Record<string, unknown>;
    expect(seen).toEqual([{ method: "POST", path: "/repos/gatchimuchio/blue-tanuki/issues/7/comments",
      body: { body: args.body } }]);
    expect(result).toMatchObject({
      operation: "pr.comment.create",
      status: 201,
      mutation_status: "provider_accepted",
      result: { id: 790 },
      provider_data_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    });
    expect(JSON.stringify(result)).not.toContain(args.body);
    expect(JSON.stringify(result)).not.toContain("issue_url");
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write pr.comment.create rejects an issue or locked PR before POST", async () => {
    let writes = 0;
    const args = { operation: "pr.comment.create", owner: "gatchimuchio", repo: "blue-tanuki", number: 7, body: "comment" };
    const issueTarget = fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("non-PR target must not receive a comment");
    }, async (target) => target.path.endsWith("/issues/7")
      ? githubReadJson({ id: 456, number: 7, state: "open", locked: false, updated_at: "2026-11-07T12:00:00Z", title: "Issue" })
      : githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false }));
    await expect(inspectGitHubPullRequestCommentCreateTargetVersion(args, {
      ...issueTarget, command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/target is not the requested pull request.*BUILD_GAP/);

    const lockedPr = fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("locked PR must not receive a comment");
    }, async (target) => target.path.endsWith("/issues/7")
      ? githubReadJson({ id: 456, number: 7, state: "open", locked: true, updated_at: "2026-11-07T12:00:00Z",
        title: "Locked PR", pull_request: { url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" } })
      : githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false }));
    await expect(inspectGitHubPullRequestCommentCreateTargetVersion(args, {
      ...lockedPr, command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/target is locked.*BLOCKED_AUTHORITY/);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create rejects a stale PR without POST", async () => {
    const args = { operation: "pr.comment.create", owner: "gatchimuchio", repo: "blue-tanuki",
      number: 7, body: "Do not post on changed PR" };
    let reads = 0;
    let writes = 0;
    const options = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      throw new Error("stale PR must not receive a comment");
    }, async (target) => {
      reads += 1;
      if (target.path.endsWith("/issues/7")) {
        return githubReadJson({ id: 456, number: 7, state: reads > 2 ? "closed" : "open", locked: false,
          updated_at: reads > 2 ? "2026-11-08T01:00:00Z" : "2026-11-07T12:00:00Z", title: "Original PR",
          pull_request: { url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" } });
      }
      return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, private: false });
    }));

    await expect(invokeGitHubWrite(args, options)).rejects.toThrow(/target changed after review.*outcome=stale/);
    expect(reads).toBe(4);
    expect(writes).toBe(0);
  });

  it("github.write pr.comment.create keeps explicit rejection distinct and malformed success unknown without retry", async () => {
    const args = { operation: "pr.comment.create", owner: "gatchimuchio", repo: "blue-tanuki",
      number: 7, body: "Expected PR comment" };
    let writes = 0;
    const rejection = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async () => {
      writes += 1;
      return { status: 422, ok: false, content_type: "application/json", body: "{}", truncated: false };
    }));
    await expect(invokeGitHubWrite(args, rejection)).resolves.toMatchObject({
      operation: "pr.comment.create", mutation_status: "provider_rejected", retry_permitted: false,
    });
    expect(writes).toBe(1);

    let malformedWrites = 0;
    const malformed = await reviewedGitHubPullRequestCommentCreate(args, fakeGitHubPullRequestCommentCreate(async () => {
      malformedWrites += 1;
      return { status: 201, ok: true, content_type: "application/json",
        body: JSON.stringify({ id: 790, body: args.body, issue_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/issues/8" }),
        truncated: false };
    }));
    await expect(invokeGitHubWrite(args, malformed)).rejects.toThrow(/outcome_unknown; do not retry automatically/);
    expect(malformedWrites).toBe(1);
  });

  it("github.write issue.create treats mismatched returned issue content as outcome unknown without retrying", async () => {
    const args = {
      operation: "issue.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "Result mismatch",
      body: "result identity must match",
    };
    let writes = 0;
    const options = await reviewedGitHubIssue(args, fakeGitHubWrite(async () => {
      writes += 1;
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 123,
          number: 7,
          title: "different provider title",
          body: args.body,
          html_url: "https://github.com/gatchimuchio/blue-tanuki/issues/7",
        }),
        truncated: false,
        rate_limit_remaining: "58",
      };
    }));

    await expect(invokeGitHubWrite(args, options))
      .rejects.toThrow(/did not confirm the exact created issue; outcome_unknown/);
    expect(writes).toBe(1);
  });

  it("github.write pr.create binds the reviewed same-repository branch tips and exact content to one POST", async () => {
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const args = {
      operation: "pr.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "Add the feature",
      body: "Exact PR body",
      head: "feature/pr-creation",
      base: "main",
      draft: "true",
      maintainer_can_modify: "false",
    };
    const writeOptions = await reviewedGitHubPullRequestCreate(args, fakeGitHubPullRequestCreate(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({
          id: 987,
          number: 42,
          title: "Add the feature",
          body: "Exact PR body",
          state: "open",
          draft: true,
          maintainer_can_modify: false,
          head: { ref: "feature/pr-creation", sha: GITHUB_PR_HEAD_SHA,
            repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
          base: { ref: "main", sha: GITHUB_PR_BASE_SHA,
            repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
        }),
        truncated: false,
        rate_limit_remaining: "57",
        request_id: "REQ",
      };
    }));
    const review = await inspectGitHubPullRequestCreateContentReview(args, writeOptions);
    expect(review).toMatchObject({
      kind: "github_pull_request_create",
      canonical_full_name: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      head_repository_id: 123,
      head_ref: "feature/pr-creation",
      head_commit_sha: GITHUB_PR_HEAD_SHA,
      base_ref: "main",
      base_commit_sha: GITHUB_PR_BASE_SHA,
      title: "Add the feature",
      body: "Exact PR body",
      draft: true,
      draft_was_defaulted: false,
      maintainer_can_modify: false,
      creation_is_reversible: false,
      used_for_authority: false,
      may_execute: false,
    });
    const result = await invokeGitHubWrite(args, writeOptions);
    expect(result).toMatchObject({
      operation: "pr.create",
      mutation_status: "provider_accepted",
      result: { id: 987, number: 42, head_commit_sha: GITHUB_PR_HEAD_SHA, base_commit_sha: GITHUB_PR_BASE_SHA, draft: true },
    });
    expect(JSON.stringify(result)).not.toContain("Exact PR body");
    expect(seen).toEqual([{
      method: "POST",
      path: "/repos/gatchimuchio/blue-tanuki/pulls",
      body: {
        title: "Add the feature",
        head: "feature/pr-creation",
        base: "main",
        draft: true,
        body: "Exact PR body",
        maintainer_can_modify: false,
      },
    }]);

    const explicitSameRepositoryArgs = { ...args, head_repository: "gatchimuchio/blue-tanuki" };
    const explicitSameRepositoryWrites: Array<Record<string, unknown>> = [];
    const explicitSameRepositoryOptions = await reviewedGitHubPullRequestCreate(explicitSameRepositoryArgs,
      fakeGitHubPullRequestCreate(async (target) => {
        explicitSameRepositoryWrites.push(target.body ?? {});
        return {
          status: 201,
          ok: true,
          content_type: "application/json",
          body: JSON.stringify({
            id: 988,
            number: 43,
            title: "Add the feature",
            body: "Exact PR body",
            state: "open",
            draft: true,
            maintainer_can_modify: false,
            head: { ref: "feature/pr-creation", sha: GITHUB_PR_HEAD_SHA,
              repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
            base: { ref: "main", sha: GITHUB_PR_BASE_SHA,
              repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
          }),
          truncated: false,
          rate_limit_remaining: "57",
          request_id: "REQ-EXPLICIT-SAME-REPOSITORY",
        };
      }));
    await invokeGitHubWrite(explicitSameRepositoryArgs, explicitSameRepositoryOptions);
    expect(explicitSameRepositoryWrites).toEqual([{
      title: "Add the feature",
      head: "feature/pr-creation",
      base: "main",
      draft: true,
      body: "Exact PR body",
      maintainer_can_modify: false,
    }]);

    const branchReads = new Map<string, number>();
    let writes = 0;
    const changingBranch = fakeGitHubPullRequestCreate(async () => {
      writes += 1;
      throw new Error("stale branch must not receive a POST");
    }, async (target) => {
      const branchPrefix = "/branches/";
      const branchIndex = target.path.indexOf(branchPrefix);
      if (branchIndex >= 0) {
        const ref = target.path.slice(branchIndex + branchPrefix.length);
        if (ref === "main") return githubReadJson({ name: ref, commit: { sha: GITHUB_PR_BASE_SHA } });
        const count = (branchReads.get(ref) ?? 0) + 1;
        branchReads.set(ref, count);
        return githubReadJson({ name: ref, commit: { sha: count === 1 ? GITHUB_PR_HEAD_SHA : "c".repeat(40) } });
      }
      return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, default_branch: "main", private: false, fork: false });
    });
    const approved = await reviewedGitHubPullRequestCreate(args, changingBranch);
    await expect(invokeGitHubWrite(args, approved)).rejects.toThrow(/target changed after review.*outcome=stale/);
    expect(writes).toBe(0);

    await expect(invokeGitHubWrite(
      { ...args, head: "gatchimuchio:feature/pr-creation" },
      writeOptions,
    )).rejects.toThrow(/head is not a valid GitHub branch name/);
  });

  it("github.write pr.create binds an allowlisted fork head to the base repository network and exact POST", async () => {
    const args = { operation: "pr.create", owner: "gatchimuchio", repo: "blue-tanuki",
      title: "Add the feature", body: "Exact PR body", head: "feature/pr-creation",
      head_repository: "contributor/blue-tanuki", base: "main", draft: true, maintainer_can_modify: false };
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const read: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path === "/repos/gatchimuchio/blue-tanuki/branches/main") {
        return githubReadJson({ name: "main", commit: { sha: GITHUB_PR_BASE_SHA } });
      }
      if (target.path === "/repos/contributor/blue-tanuki/branches/feature/pr-creation") {
        return githubReadJson({ name: "feature/pr-creation", commit: { sha: GITHUB_PR_HEAD_SHA } });
      }
      if (target.path === "/repos/gatchimuchio/blue-tanuki") {
        return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
          owner: { login: "gatchimuchio" }, default_branch: "main", private: false, fork: false });
      }
      if (target.path === "/repos/contributor/blue-tanuki") {
        return githubReadJson({ id: 456, name: "blue-tanuki", full_name: "contributor/blue-tanuki",
          owner: { login: "contributor" }, default_branch: "main", private: true, fork: true,
          source: { id: 123, full_name: "gatchimuchio/blue-tanuki" } });
      }
      throw new Error("unexpected synthetic GitHub read " + target.path);
    };
    const request: NonNullable<GitHubWriteOptions["request"]> = async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body ?? {} });
      return { status: 201, ok: true, content_type: "application/json", truncated: false,
        rate_limit_remaining: "57", request_id: "CROSS-PR-REQ", body: JSON.stringify({
          id: 987, number: 42, title: "Add the feature", body: "Exact PR body", state: "open", draft: true,
          maintainer_can_modify: false,
          head: { ref: "feature/pr-creation", sha: GITHUB_PR_HEAD_SHA,
            repo: { id: 456, full_name: "contributor/blue-tanuki" } },
          base: { ref: "main", sha: GITHUB_PR_BASE_SHA,
            repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
        }) };
    };
    const options = await reviewedGitHubPullRequestCreate(args, fakeGitHubPullRequestCreate(request, read, {
      GITHUB_TOKEN: "ghp_dummy",
      BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki contributor/blue-tanuki",
    }));
    const review = await inspectGitHubPullRequestCreateContentReview(args, options);
    expect(review).toMatchObject({ canonical_full_name: "gatchimuchio/blue-tanuki", repository_id: 123,
      repository_visibility: "public", head_repository_id: 456, head_canonical_full_name: "contributor/blue-tanuki",
      head_repository_visibility: "private", repository_network_root_id: 123,
      head_repository_network_root_id: 123, head_repository_is_fork: true });
    expect(seen).toEqual([]);
    const result = await invokeGitHubWrite(args, options);
    expect(result).toMatchObject({ mutation_status: "provider_accepted", result: {
      head_repository_id: 456, head_canonical_full_name: "contributor/blue-tanuki",
      head_ref: "feature/pr-creation", base_ref: "main" } });
    expect(seen).toEqual([{ method: "POST", path: "/repos/gatchimuchio/blue-tanuki/pulls", body: {
      title: "Add the feature", head: "contributor:feature/pr-creation", head_repo: "blue-tanuki",
      base: "main", draft: true, body: "Exact PR body", maintainer_can_modify: false,
    } }]);

    let unsafeWrites = 0;
    const unrelatedNetworkRead: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      const response = await read(target);
      if (target.path === "/repos/contributor/blue-tanuki") {
        return githubReadJson({ id: 456, name: "blue-tanuki", full_name: "contributor/blue-tanuki",
          owner: { login: "contributor" }, default_branch: "main", private: true, fork: true,
          source: { id: 999, full_name: "unrelated/root" } });
      }
      return response;
    };
    const unsafeOptions = fakeGitHubPullRequestCreate(async () => {
      unsafeWrites += 1;
      throw new Error("an unrelated fork network must not receive a POST");
    }, unrelatedNetworkRead, { GITHUB_TOKEN: "ghp_dummy",
      BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki contributor/blue-tanuki" });
    await expect(inspectGitHubPullRequestCreateTargetVersion(args, { ...unsafeOptions,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/head repository must be a fork.*status=BUILD_GAP/);
    expect(unsafeWrites).toBe(0);

    const missingAllowlist = fakeGitHubPullRequestCreate(request, read, {
      GITHUB_TOKEN: "ghp_dummy", BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki",
    });
    await expect(inspectGitHubPullRequestCreateTargetVersion(args, { ...missingAllowlist,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/denied repository contributor\/blue-tanuki/);
  });

  it("github.write pr.create distinguishes provider rejection from unknown response without retry", async () => {
    const args = { operation: "pr.create", owner: "gatchimuchio", repo: "blue-tanuki",
      title: "Add the feature", body: "Exact PR body", head: "feature/pr-creation", base: "main", draft: true };
    let rejectedPosts = 0;
    const rejectedOptions = await reviewedGitHubPullRequestCreate(args, fakeGitHubPullRequestCreate(async () => {
      rejectedPosts += 1;
      return { status: 422, ok: false, content_type: "application/json", body: "{}", truncated: false,
        rate_limit_remaining: "59", request_id: "PR-REJECTED" };
    }));
    const rejected = await invokeGitHubWrite(args, rejectedOptions);
    expect(rejected).toMatchObject({ operation: "pr.create", mutation_status: "provider_rejected", retry_permitted: false });
    expect(rejectedPosts).toBe(1);

    let uncertainPosts = 0;
    const uncertainOptions = await reviewedGitHubPullRequestCreate(args, fakeGitHubPullRequestCreate(async () => {
      uncertainPosts += 1;
      return { status: 201, ok: true, content_type: "application/json", truncated: false,
        rate_limit_remaining: "58", body: JSON.stringify({
          id: 987, number: 42, title: "Add the feature", body: "Exact PR body", state: "open", draft: true,
          head: { ref: "feature/pr-creation", sha: "c".repeat(40), repo: { id: 123 } },
          base: { ref: "main", sha: GITHUB_PR_BASE_SHA, repo: { id: 123 } },
        }) };
    }));
    await expect(invokeGitHubWrite(args, uncertainOptions))
      .rejects.toThrow(/response did not confirm the reviewed pull request and branch tips; outcome_unknown/);
    expect(uncertainPosts).toBe(1);
  });

  it("github.write fails closed before network request when token or repo allowlist is missing", async () => {
    let called = false;
    const opts = fakeGitHubWrite(async () => {
      called = true;
      throw new Error("should not call network");
    }, {});

    await expect(
      invokeGitHubWrite(
        {
          operation: "issue.create",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          title: "blocked",
        },
        opts,
      ),
    ).rejects.toThrow(/BLUE_TANUKI_GITHUB_REPOS.*mutation_sent=false/);

    await expect(
      invokeGitHubWrite(
        {
          operation: "issue.create",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          title: "blocked",
        },
        fakeGitHubWrite(async () => {
          called = true;
          throw new Error("should not call network");
        }, { GITHUB_TOKEN: "ghp_dummy", BLUE_TANUKI_GITHUB_REPOS: "other/repo" }),
      ),
    ).rejects.toThrow(/denied repository.*mutation_sent=false/);

    await expect(
      invokeGitHubWrite(
        {
          operation: "issue.create",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          title: "blocked",
        },
        fakeGitHubWrite(async () => {
          called = true;
          throw new Error("should not call network");
        }, { BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki" }),
      ),
    ).rejects.toThrow(/GITHUB_TOKEN.*mutation_sent=false/);

    expect(called).toBe(false);
  });

  it("github.write preserves explicit provider rejection without retrying", async () => {
    const args = {
      operation: "issue.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      title: "bad",
    };
    const options = await reviewedGitHubIssue(args, fakeGitHubWrite(async () => ({
          status: 422,
          ok: false,
          content_type: "application/json",
          body: JSON.stringify({ message: "Validation Failed" }),
          truncated: false,
          rate_limit_remaining: "56",
          request_id: "ERR",
        })));
    const result = await invokeGitHubWrite(args, options) as Record<string, unknown>;
    expect(result).toMatchObject({
      schema_version: "blue-tanuki.github-write-result.v1",
      operation: "issue.create",
      status: 422,
      mutation_status: "provider_rejected",
      retry_permitted: false,
      used_for_authority: false,
      may_execute: false,
    });
  });

  it("browser.read extracts bounded readable text and links through http.fetch", async () => {
    const seen: string[] = [];
    const result = (await invokeBrowserRead(
      { url: "https://example.test/docs", max_chars: 80, max_bytes: 4096 },
      fakeHttp(
        {
          "example.test": { address: "93.184.216.34", family: 4 },
        },
        async (target) => {
          seen.push(target.url.href);
          return {
            status: 200,
            ok: true,
            content_type: "text/html; charset=utf-8",
            location: null,
            body:
              "<html><head><title>Alpha &amp; Beta</title><style>.x{}</style></head>" +
              "<body><script>ignore()</script><h1>Hello</h1><p>Readable text</p>" +
              "<a href=\"/next\">Next</a><a href=\"javascript:bad()\">Bad</a></body></html>",
            truncated: false,
          };
        },
      ),
    )) as {
      url: string;
      title: string;
      text: string;
      links: string[];
    };

    expect(seen).toEqual(["https://example.test/docs"]);
    expect(result.title).toBe("Alpha & Beta");
    expect(result.text).toContain("Hello Readable text");
    expect(result.text).not.toContain("ignore");
    expect(result.links).toEqual(["https://example.test/next"]);
  });

  it("browser.read inherits http.fetch SSRF enforcement", async () => {
    await expect(
      invokeBrowserRead(
        { url: "http://metadata.test/" },
        fakeHttp({
          "metadata.test": { address: "169.254.169.254", family: 4 },
        }),
      ),
    ).rejects.toThrow(/non-public address/);
  });

  it("browser.snapshot is disabled by default", async () => {
    await expect(
      invokeBrowserSnapshot(
        { url: "https://example.test/docs" },
        fakeBrowserAutomation({ env: {} }),
      ),
    ).rejects.toThrow(/BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW=1/);
  });

  it("browser.snapshot enforces network policy and returns bounded preview metadata", async () => {
    const seen: string[] = [];
    const result = (await invokeBrowserSnapshot(
      { url: "https://example.test/docs", max_chars: 12, timeout_ms: 5_000 },
      fakeBrowserAutomation({
        env: { BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW: "1" },
        async runner(request) {
          seen.push(`${request.action}:${request.url}:${request.target.hostname}`);
          return {
            engine: "fake-headless",
            final_url: request.url,
            title: "Preview",
            text: "alpha beta gamma delta",
            truncated: false,
          };
        },
      }),
    )) as {
      action: string;
      engine: string;
      text: string;
      truncated: boolean;
      sandbox: { credential_reuse: boolean };
      network_policy: { ssrf_guard: string };
    };

    expect(seen).toEqual(["snapshot:https://example.test/docs:example.test"]);
    expect(result.action).toBe("snapshot");
    expect(result.engine).toBe("fake-headless");
    expect(result.text).toBe("alpha bet...");
    expect(result.truncated).toBe(true);
    expect(result.sandbox.credential_reuse).toBe(false);
    expect(result.network_policy.ssrf_guard).toBe("public_address_required");
  });

  it("browser.snapshot inherits SSRF enforcement before the runner starts", async () => {
    let called = false;
    await expect(
      invokeBrowserSnapshot(
        { url: "http://metadata.test/" },
        fakeBrowserAutomation({
          env: { BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW: "1" },
          records: { "metadata.test": { address: "169.254.169.254", family: 4 } },
          async runner() {
            called = true;
            throw new Error("runner should not start");
          },
        }),
      ),
    ).rejects.toThrow(/non-public address/);
    expect(called).toBe(false);
  });

  it("browser.automation has a disabled smoke skip path", async () => {
    const result = (await invokeBrowserAutomation(
      { action: "smoke" },
      fakeBrowserAutomation({ env: {} }),
    )) as {
      status: string;
      enabled: boolean;
      safe_to_ignore: boolean;
    };

    expect(result.status).toBe("skipped");
    expect(result.enabled).toBe(false);
    expect(result.safe_to_ignore).toBe(true);
  });

  it("browser.automation denies credential use and quarantines side-effect actions", async () => {
    await expect(
      invokeBrowserAutomation(
        { action: "navigate", url: "https://example.test/", use_credentials: true },
        fakeBrowserAutomation({ env: { BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW: "1" } }),
      ),
    ).rejects.toThrow(/credential_usage=denied/);

    await expect(
      invokeBrowserAutomation(
        { action: "click", url: "https://example.test/", selector: "#buy" },
        fakeBrowserAutomation({ env: { BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW: "1" } }),
      ),
    ).rejects.toThrow(/preview-quarantined.*mutation_sent=false/);
  });

  it("shell.exec does not start a host process when the native provider is missing", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-provider-missing-"));
    const root = path.join(parent, "root");
    await fs.mkdir(root);
    const marker = path.join(parent, "host-process-ran.txt");
    try {
      await expect(
        invokeShellExec(
          {
            cmd: "cmd.exe",
            args: ["/c", `echo executed>${marker}`],
            cwd: ".",
          },
          {
            env: shellTestEnv(root),
            nativeProviderPath: path.join(root, "missing-provider.exe"),
          },
        ),
      ).rejects.toThrow(/(?:[Ww]indows|[Ll]inux) isolation provider is not installed.*no process was started/);
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("shell.exec requires an explicit root before resolving a cwd", async () => {
    await expect(
      invokeShellExec({ cmd: "node", args: ["-v"] }, { env: {} }),
    ).rejects.toThrow(/BLUE_TANUKI_SHELL_ROOT is required/);
    await expect(
      invokeShellExec({ cmd: "node", args: ["-v"], cwd: "../outside" }, { env: {} }),
    ).rejects.toThrow(/BLUE_TANUKI_SHELL_ROOT is required/);
  });

  it("shell.exec resolves only the fixed development-only synthetic test profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-synthetic-profile-"));
    const env = shellTestEnv(root, {
      BLUE_TANUKI_FILE_ROOT: root,
      BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND: "true",
      NODE_ENV: "test",
    });
    const args = {
      execution_profile: SYNTHETIC_FILE_EDIT_TEST_FAILURE_PROFILE,
      cwd: ".",
      timeout_ms: 15_000,
      max_bytes: 64_000,
      same_workspace_as_file_root: true,
      summary_only: true,
    };
    try {
      const observation = await inspectShellExecTargetVersion(args, {
        env,
        command_digest: "f".repeat(64),
      });
      expect(observation).toMatchObject({
        schema_version: "blue-tanuki.shell-exec-target-version.v1",
        used_for_authority: false,
        may_execute: false,
      });
      await expect(inspectShellExecTargetVersion(args, {
        env: { ...env, BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND: "false" },
        command_digest: "f".repeat(64),
      })).rejects.toThrow(/disabled outside its development opt-in/);
      await expect(inspectShellExecTargetVersion({ ...args, execution_profile: "unrecognized" }, {
        env,
        command_digest: "f".repeat(64),
      })).rejects.toThrow(/execution profile is unsupported/);
      await expect(inspectShellExecTargetVersion({ ...args, cmd: "node" }, {
        env,
        command_digest: "f".repeat(64),
      })).rejects.toThrow(/cannot be combined with raw command fields/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "shell.exec runs the fixed synthetic failure through Windows isolation and returns only a summary",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-synthetic-failure-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const env = shellTestEnv(root, {
        BLUE_TANUKI_FILE_ROOT: root,
        BLUE_TANUKI_ENABLE_SYNTHETIC_PLAN_BACKEND: "true",
        NODE_ENV: "test",
      });
      const args = {
        execution_profile: SYNTHETIC_FILE_EDIT_TEST_FAILURE_PROFILE,
        cwd: ".",
        timeout_ms: 15_000,
        max_bytes: 64_000,
        same_workspace_as_file_root: true,
        summary_only: true,
      };
      try {
        const targetVersionObservation = await inspectShellExecTargetVersion(args, {
          env,
          command_digest: "e".repeat(64),
        });
        const result = await invokeShellExec(args, {
          env,
          nativeProviderPath: providerPath,
          targetVersionObservation,
        }) as Record<string, unknown>;
        expect(result).toMatchObject({
          exit_code: 23,
          signal: null,
          timed_out: false,
          output_included: false,
          process_tree_empty: true,
        });
        expect(result).not.toHaveProperty("stdout");
        expect(result).not.toHaveProperty("stderr");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("shell.exec binds an explicitly requested same-workspace command to the file sandbox", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-same-workspace-"));
    const shellRoot = path.join(parent, "shell");
    const fileRoot = path.join(parent, "files");
    await fs.mkdir(shellRoot);
    await fs.mkdir(fileRoot);
    const mismatchedEnv = { ...shellTestEnv(shellRoot), BLUE_TANUKI_FILE_ROOT: fileRoot };
    const sameRootEnv = { ...shellTestEnv(shellRoot), BLUE_TANUKI_FILE_ROOT: shellRoot };
    const args = { cmd: "node", args: ["--version"], same_workspace_as_file_root: true, summary_only: true };
    try {
      await expect(inspectShellExecTargetVersion(args, {
        env: mismatchedEnv,
        command_digest: "a".repeat(64),
      })).rejects.toThrow(/resolve to the same directory/);
      await expect(invokeShellExec(args, {
        env: mismatchedEnv,
        nativeProviderPath: path.join(parent, "missing-provider.exe"),
      })).rejects.toThrow(/resolve to the same directory/);
      await expect(inspectShellExecTargetVersion({ ...args, summary_only: false }, {
        env: sameRootEnv,
        command_digest: "d".repeat(64),
      })).rejects.toThrow(/requires summary_only=true/);
      await expect(inspectShellExecTargetVersion({
        cmd: args.cmd,
        args: args.args,
        same_workspace_as_file_root: true,
      }, {
        env: sameRootEnv,
        command_digest: "e".repeat(64),
      })).rejects.toThrow(/requires summary_only=true/);

      const observation = await inspectShellExecTargetVersion(args, {
        env: sameRootEnv,
        command_digest: "b".repeat(64),
      });
      expect(observation).toMatchObject({
        schema_version: "blue-tanuki.shell-exec-target-version.v1",
        used_for_authority: false,
        may_execute: false,
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "shell.exec can verify a same-workspace file while returning only a digest summary",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-workspace-test-"));
      const filePath = path.join(root, "reviewed.txt");
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const env = shellTestEnv(root, { BLUE_TANUKI_FILE_ROOT: root });
      await fs.writeFile(filePath, "after\r\n", "utf8");
      const args = {
        cmd: "findstr.exe",
        args: ["/x", "/c:after", "reviewed.txt"],
        same_workspace_as_file_root: true,
        summary_only: true,
      };
      try {
        const targetVersionObservation = await inspectShellExecTargetVersion(args, {
          env,
          command_digest: "c".repeat(64),
        });
        const result = await invokeShellExec(args, {
          env,
          targetVersionObservation,
          nativeProviderPath: providerPath,
        }) as Record<string, unknown>;
        expect(result).toMatchObject({
          exit_code: 0,
          signal: null,
          timed_out: false,
          output_included: false,
          process_tree_empty: true,
        });
        expect(result.stdout_text_bytes).toBeGreaterThan(0);
        expect(result.stdout_text_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(result).not.toHaveProperty("stdout");
        expect(result).not.toHaveProperty("stderr");
        expect(JSON.stringify(result)).not.toContain("after");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("shell.exec requires a reviewed sandbox identity and refuses a replaced cwd before process creation", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-target-version-"));
    const root = path.join(parent, "root");
    const cwd = path.join(root, "work");
    const retiredCwd = path.join(root, "work-reviewed");
    const marker = path.join(parent, "process-started.txt");
    await fs.mkdir(cwd, { recursive: true });
    const env = shellTestEnv(root);
    const priorRoot = process.env.BLUE_TANUKI_SHELL_ROOT;
    process.env.BLUE_TANUKI_SHELL_ROOT = root;
    const shell = new ToolRegistry();
    registerBuiltinTools(shell);
    const tool = shell.get("shell.exec");
    const args = { cmd: "node", args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], cwd: "work" };
    try {
      if (!tool?.inspect_target_version) throw new Error("built-in shell target resolver was not registered");
      const observation = await tool.inspect_target_version(args, { env, command_digest: "a".repeat(64) });
      expect(observation).toMatchObject({
        schema_version: "blue-tanuki.shell-exec-target-version.v1",
        operation_plan_binding_digest: null,
        used_for_authority: false,
        may_execute: false,
      });
      const invocation = { command_id: "cmd-shell-target", upstream_commit_hash: "a".repeat(64) };
      await expect(tool.invoke(args, invocation)).rejects.toThrow(/requires Broker target version evidence/);

      await fs.rename(cwd, retiredCwd);
      await fs.mkdir(cwd);
      await expect(tool.invoke(args, { ...invocation, target_version_observation: observation }))
        .rejects.toThrow(/sandbox root or cwd changed after owner review/);
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      if (priorRoot === undefined) delete process.env.BLUE_TANUKI_SHELL_ROOT;
      else process.env.BLUE_TANUKI_SHELL_ROOT = priorRoot;
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("shell.exec rejects absolute commands and destructive command shapes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-policy-"));
    try {
      const env = shellTestEnv(dir);
      await expect(
        invokeShellExec({ cmd: process.execPath, args: ["-v"] }, { env }),
      ).rejects.toThrow(/command name on PATH/);
      await expect(
        invokeShellExec({ cmd: "rm", args: ["-rf", "/"] }, { env }),
      ).rejects.toThrow(/destructive-command policy/);
      await expect(
        invokeShellExec({ cmd: "node", args: ["../escape"] }, { env }),
      ).rejects.toThrow(/destructive-argument policy/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "shell.exec writes only inside its AppContainer root and restores the root ACL",
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-appcontainer-"));
      const root = path.join(parent, "root");
      const outside = path.join(parent, "outside.txt");
      await fs.mkdir(root);
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      const aclBefore = execFileSync(icacls, [root], { encoding: "utf8" });
      const env = shellTestEnv(root);
      try {
        const inside = await invokeShellExec(
          { cmd: "cmd.exe", args: ["/c", "echo inside>inside.txt"] },
          { env, nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(inside.exit_code).toBe(0);
        expect(inside.process_tree_empty).toBe(true);
        expect(await fs.readFile(path.join(root, "inside.txt"), "utf8")).toContain("inside");

        const denied = await invokeShellExec(
          { cmd: "cmd.exe", args: ["/c", `echo outside>${outside}`] },
          { env, nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(denied.exit_code).not.toBe(0);
        await expect(fs.access(outside)).rejects.toThrow();
        expect(execFileSync(icacls, [root], { encoding: "utf8" })).toBe(aclBefore);
        const fileAcl = execFileSync(icacls, [path.join(root, "inside.txt")], { encoding: "utf8" });
        expect(fileAcl).not.toMatch(/S-1-15-2-/);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "shell.exec does not pass credential-like parent environment values to the child",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-environment-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      try {
        const result = await invokeShellExec(
          { cmd: "cmd.exe", args: ["/c", "set"] },
          {
            env: shellTestEnv(root, {
              OPENAI_API_KEY: "synthetic-never-forward-this",
              BLUE_TANUKI_TEST_SECRET: "synthetic-never-forward-this-either",
            }),
            nativeProviderPath: providerPath,
          },
        ) as Record<string, unknown>;
        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain(`TEMP=${root}`);
        expect(result.stdout).not.toContain("OPENAI_API_KEY");
        expect(result.stdout).not.toContain("BLUE_TANUKI_TEST_SECRET");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "shell.exec cannot connect to a local loopback listener without network capabilities",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-network-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const server = createServer((socket) => socket.end("unexpected connection"));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("loopback test server did not bind");
        const result = await invokeShellExec(
          {
            cmd: "curl.exe",
            args: ["--max-time", "2", `http://127.0.0.1:${address.port}/`],
            timeout_ms: 5_000,
          },
          { env: shellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(result.exit_code).not.toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "shell.exec terminates a direct child process when its parent exits",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-process-tree-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const fixturePath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/process-tree-fixture.exe", import.meta.url),
      );
      try {
        await fs.copyFile(fixturePath, path.join(root, "process-tree-fixture.exe"));
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const env = shellTestEnv(root, {
          PATH: `${root};${path.join(systemRoot, "System32")}`,
        });
        const result = await invokeShellExec(
          { cmd: "process-tree-fixture.exe", args: ["parent"], timeout_ms: 5_000 },
          { env, nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(result.exit_code).toBe(0);
        expect(result.process_tree_empty).toBe(true);
        expect(result.descendants_terminated).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 4_200));
        await expect(fs.access(path.join(root, "late-child.txt"))).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "shell.exec cancellation and timeout empty the process job before returning",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-cancel-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const lateMarker = path.join(root, "late.txt");
      const windowsPowerShell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
      );
      const env = shellTestEnv(root, {
        PATH: `${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")};${windowsPowerShell}`,
      });
      let cancelTimer: NodeJS.Timeout | undefined;
      try {
        const controller = new AbortController();
        const lifecycle: Array<{ state: string }> = [];
        cancelTimer = setTimeout(() => controller.abort(), 400);
        const result = await invokeShellExec(
          {
            cmd: "powershell.exe",
            args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 15; Set-Content -Path late.txt -Value late"],
            timeout_ms: 30_000,
          },
          { env, nativeProviderPath: providerPath, signal: controller.signal,
            onExecutionLifecycle: (event) => lifecycle.push(event) },
        ) as Record<string, unknown>;
        expect(result.signal).toBe("aborted");
        expect(result.process_tree_empty).toBe(true);
        expect(lifecycle.map((event) => event.state)).toEqual(expect.arrayContaining([
          "worker_started", "cancel_requested", "worker_exit_observed", "process_tree_empty_confirmed",
        ]));
        expect(lifecycle.map((event) => event.state)).not.toContain("provider_state_unknown");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(fs.access(lateMarker)).rejects.toThrow();

        const timedOut = await invokeShellExec(
          {
            cmd: "powershell.exe",
            args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 15; Set-Content -Path late.txt -Value late"],
            timeout_ms: 400,
          },
          { env, nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(timedOut.signal).toBe("timeout");
        expect(timedOut.process_tree_empty).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(fs.access(lateMarker)).rejects.toThrow();
      } finally {
        if (cancelTimer) clearTimeout(cancelTimer);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "shell.exec refuses roots containing secret-like files before creating a process",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-secret-root-"));
      const providerPath = fileURLToPath(
        new URL("../native/windows-isolation/target/release/blue-tanuki-windows-isolation.exe", import.meta.url),
      );
      const marker = path.join(root, "must-not-run.txt");
      await fs.mkdir(path.join(root, ".env"));
      try {
        await expect(
          invokeShellExec(
            { cmd: "cmd.exe", args: ["/c", `echo ran>${marker}`] },
            { env: shellTestEnv(root), nativeProviderPath: providerPath },
          ),
        ).rejects.toThrow(/isolation failed before a verified result/);
        await expect(fs.access(marker)).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec rejects a hard-linked root entry before starting a process",
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-hard-link-"));
      const root = path.join(parent, "root");
      const outside = path.join(parent, "outside.txt");
      const marker = path.join(root, "must-not-run.txt");
      await fs.mkdir(root);
      await fs.writeFile(outside, "outside remains unchanged", "utf8");
      await fs.link(outside, path.join(root, "workspace-copy.txt"));
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      try {
        await expect(
          invokeShellExec(
            { cmd: "sh", args: ["-c", `printf ran > '${marker}'`] },
            { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
          ),
        ).rejects.toThrow(/hard.link/);
        await expect(fs.access(marker)).rejects.toThrow();
        expect(await fs.readFile(outside, "utf8")).toBe("outside remains unchanged");
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec uses Linux namespaces and writes only inside its dedicated root",
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-root-"));
      const root = path.join(parent, "root");
      const outside = path.join(parent, "outside.txt");
      await fs.mkdir(root);
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      try {
        const result = await invokeShellExec(
          {
            cmd: "sh",
            args: ["-c", `printf inside > inside.txt; printf outside > '${outside}' || true`],
          },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(result.exit_code).toBe(0);
        expect(result.process_tree_empty).toBe(true);
        expect(await fs.readFile(path.join(root, "inside.txt"), "utf8")).toBe("inside");
        await expect(fs.access(outside)).rejects.toThrow();
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec enforces the per-file size limit",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-file-size-"));
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      const oversizedFile = path.join(root, "oversized.bin");
      try {
        const result = await invokeShellExec(
          { cmd: "sh", args: ["-c", "truncate -s 67108865 oversized.bin"] },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/File (?:too large|size limit exceeded)/iu);
        expect(result.process_tree_empty).toBe(true);
        const fileSize = await fs.stat(oversizedFile).then((stat) => stat.size).catch(() => 0);
        expect(fileSize).toBeLessThanOrEqual(64 * 1024 * 1024);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec clears inherited credential-like environment values and denies network access",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-boundary-"));
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      const server = createServer((socket) => socket.end("unexpected connection"));
      try {
        const environment = linuxShellTestEnv(root, {
          OPENAI_API_KEY: "synthetic-never-forward-this",
          BLUE_TANUKI_TEST_SECRET: "synthetic-never-forward-this-either",
        });
        const envResult = await invokeShellExec(
          { cmd: "env", args: [] },
          { env: environment, nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(envResult.exit_code).toBe(0);
        expect(envResult.stdout).not.toContain("OPENAI_API_KEY");
        expect(envResult.stdout).not.toContain("BLUE_TANUKI_TEST_SECRET");
        expect(envResult.stdout).not.toContain("synthetic-never-forward-this");

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("loopback test server did not bind");
        const networkResult = await invokeShellExec(
          { cmd: "curl", args: ["--connect-timeout", "1", "--max-time", "2", `http://127.0.0.1:${address.port}/`] },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(networkResult.exit_code).not.toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec terminates sandbox descendants before returning",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-process-tree-"));
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      try {
        const result = await invokeShellExec(
          { cmd: "sh", args: ["-c", "(sleep 2; printf late > late.marker) & exit 0"] },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(result.exit_code).toBe(0);
        expect(result.descendants_terminated).toBe(true);
        expect(result.process_tree_empty).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        await expect(fs.access(path.join(root, "late.marker"))).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "linux")(
    "shell.exec reports timeout and cancellation only after the service cgroup is empty",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-shell-linux-stop-"));
      const providerPath = fileURLToPath(
        new URL("../native/linux-isolation/target/release/blue-tanuki-linux-isolation", import.meta.url),
      );
      let cancelTimer: NodeJS.Timeout | undefined;
      try {
        const timedOut = await invokeShellExec(
          { cmd: "sleep", args: ["10"], timeout_ms: 500 },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath },
        ) as Record<string, unknown>;
        expect(timedOut.signal).toBe("timeout");
        expect(timedOut.process_tree_empty).toBe(true);

        const controller = new AbortController();
        cancelTimer = setTimeout(() => controller.abort(), 700);
        const aborted = await invokeShellExec(
          { cmd: "sleep", args: ["10"], timeout_ms: 20_000 },
          { env: linuxShellTestEnv(root), nativeProviderPath: providerPath, signal: controller.signal },
        ) as Record<string, unknown>;
        expect(aborted.signal).toBe("aborted");
        expect(aborted.process_tree_empty).toBe(true);
      } finally {
        if (cancelTimer) clearTimeout(cancelTimer);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("github.write code.push binds one new file and commits only at the exact reviewed branch head", async () => {
    const args = { operation: "code.push", owner: "gatchimuchio", repo: "blue-tanuki",
      branch: "feature/code-push", expected_head_sha: "a".repeat(40), path: "docs/new-note.txt",
      content: "reviewed file\n", commit_message: "Add reviewed note" };
    const commandDigest = "c".repeat(64);
    const planDigest = "d".repeat(64);
    const nextCommit = "b".repeat(40);
    let mutationSent = false;
    let mutations = 0;
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path === "/repos/gatchimuchio/blue-tanuki/branches/feature/code-push") {
        return githubReadJson({ name: "feature/code-push", commit: { sha: mutationSent ? nextCommit : args.expected_head_sha } });
      }
      if (target.path === "/repos/gatchimuchio/blue-tanuki/contents/docs/new-note.txt?ref=feature%2Fcode-push") {
        return { status: 404, ok: false, content_type: "application/json", body: JSON.stringify({ message: "Not Found" }),
          truncated: false, rate_limit_remaining: "60" };
      }
      if (target.path === "/repos/gatchimuchio/blue-tanuki") {
        return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
          owner: { login: "gatchimuchio" }, default_branch: "main", private: false });
      }
      throw new Error("unexpected synthetic GitHub read " + target.path);
    };
    const request: NonNullable<GitHubWriteOptions["request"]> = async (target) => {
      mutations += 1;
      seen.push({ method: target.method, path: target.path, body: target.body ?? {} });
      mutationSent = true;
      const envelope = target.body;
      const variables = envelope.variables as { input: Record<string, unknown> };
      const input = variables.input;
      expect(input.expectedHeadOid).toBe(args.expected_head_sha);
      expect(input.branch).toEqual({ repositoryNameWithOwner: "gatchimuchio/blue-tanuki",
        branchName: "feature/code-push" });
      expect(input.fileChanges).toEqual({ additions: [{ path: args.path,
        contents: Buffer.from(args.content, "utf8").toString("base64") }] });
      expect(input.message).toEqual({ headline: args.commit_message });
      return { status: 200, ok: true, content_type: "application/json", truncated: false,
        rate_limit_remaining: "59", request_id: "CODE-PUSH-REQ", body: JSON.stringify({
          data: { createCommitOnBranch: { commit: { oid: nextCommit, parents: { nodes: [{ oid: args.expected_head_sha }] } },
            ref: { name: "refs/heads/feature/code-push", target: { oid: nextCommit } } } },
        }) };
    };
    const options = fakeGitHubWrite(request, undefined, read_request);
    const target = await inspectGitHubCodePushTargetVersion(args, { ...options, command_digest: commandDigest,
      operation_plan_binding_digest: planDigest });
    const review = await inspectGitHubCodePushContentReview(args, { ...options, command_digest: commandDigest,
      operation_plan_binding_digest: planDigest });
    expect(review).toMatchObject({ kind: "github_code_push", operation: "github.write.code.push",
      branch: args.branch, expected_head_sha: args.expected_head_sha, path: args.path, content: args.content,
      content_sha256: createHash("sha256").update(args.content, "utf8").digest("hex"),
      publication_effect: "visible_to_repository_audience", branch_update_is_conditional: true,
      notification_effect: "github_api_may_trigger_notifications", used_for_authority: false, may_execute: false });
    const result = await invokeGitHubWrite(args, { ...options, command_digest: commandDigest,
      operation_plan_binding_digest: planDigest, expected_target_version_observation: target });
    expect(result).toMatchObject({ operation: "code.push", method: "POST", path: "/graphql", status: 200,
      mutation_status: "provider_accepted", result: { branch: args.branch, commit_sha: nextCommit,
        parent_sha: args.expected_head_sha, path: args.path } });
    expect(mutations).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/graphql" });
    expect(JSON.stringify(result)).not.toContain(args.content);
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write release.draft.create binds an existing annotated tag and verifies an unpublished draft", async () => {
    const args = { operation: "release.draft.create", owner: "gatchimuchio", repo: "blue-tanuki",
      tag_name: "v1.0/review", target_commit_sha: "a".repeat(40), name: "Reviewed draft", body: "Draft body" };
    const commandDigest = "c".repeat(64);
    const planDigest = "d".repeat(64);
    const tagObjectSha = "b".repeat(40);
    const tagRefPath = "/repos/gatchimuchio/blue-tanuki/git/ref/tags/v1.0%2Freview";
    const annotatedTagPath = `/repos/gatchimuchio/blue-tanuki/git/tags/${tagObjectSha}`;
    const releasePath = "/repos/gatchimuchio/blue-tanuki/releases/tags/v1.0%2Freview";
    let created: Record<string, unknown> | undefined;
    let writes = 0;
    const read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path === "/repos/gatchimuchio/blue-tanuki") {
        return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
          owner: { login: "gatchimuchio" }, private: false });
      }
      if (target.path === tagRefPath) return githubReadJson({ object: { sha: tagObjectSha, type: "tag" } });
      if (target.path === annotatedTagPath) return githubReadJson({ object: { sha: args.target_commit_sha, type: "commit" } });
      if (target.path === releasePath) return created ? githubReadJson(created)
        : { status: 404, ok: false, content_type: "application/json", body: JSON.stringify({ message: "Not Found" }),
          truncated: false, rate_limit_remaining: "60" };
      throw new Error("unexpected synthetic GitHub read " + target.path);
    };
    const request: NonNullable<GitHubWriteOptions["request"]> = async (target) => {
      writes += 1;
      expect(target.method).toBe("POST");
      expect(target.path).toBe("/repos/gatchimuchio/blue-tanuki/releases");
      expect(target.body).toEqual({ tag_name: args.tag_name, target_commitish: args.target_commit_sha,
        name: args.name, body: args.body, draft: true, prerelease: false, generate_release_notes: false });
      created = { id: 987, tag_name: args.tag_name, name: args.name, body: args.body,
        draft: true, prerelease: false, assets: [] };
      return { status: 201, ok: true, content_type: "application/json", body: JSON.stringify(created),
        truncated: false, rate_limit_remaining: "59", request_id: "DRAFT-REQ" };
    };
    const options = fakeGitHubWrite(request, undefined, read_request);
    const target = await inspectGitHubReleaseDraftCreateTargetVersion(args, { ...options,
      command_digest: commandDigest, operation_plan_binding_digest: planDigest });
    expect(target).toMatchObject({ operation: "release.draft.create", tag_name: args.tag_name,
      tag_ref_sha: tagObjectSha, tag_ref_type: "tag", target_commit_sha: args.target_commit_sha,
      release_absent: true, mutation_sent: false, used_for_authority: false, may_execute: false });
    const review = await inspectGitHubReleaseDraftCreateContentReview(args, { ...options,
      command_digest: commandDigest, operation_plan_binding_digest: planDigest });
    expect(review).toMatchObject({ kind: "github_release_draft_create", operation: "github.write.release.draft.create",
      release_name: args.name, body: args.body, draft: true, prerelease: false, assets_added: false,
      release_published: false, provider_observation_is_atomic: false, used_for_authority: false, may_execute: false });
    const result = await invokeGitHubWrite(args, { ...options, command_digest: commandDigest,
      operation_plan_binding_digest: planDigest, expected_target_version_observation: target });
    expect(result).toMatchObject({ operation: "release.draft.create", method: "POST",
      path: "/repos/gatchimuchio/blue-tanuki/releases", status: 201, mutation_status: "provider_accepted",
      result: { id: 987, tag_name: args.tag_name, target_commit_sha: args.target_commit_sha,
        name: args.name, draft: true, prerelease: false } });
    expect(writes).toBe(1);
    expect(JSON.stringify(result)).not.toContain(args.body);
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write release.draft.create rejects existing releases and stale tags before mutation", async () => {
    const args = { operation: "release.draft.create", owner: "gatchimuchio", repo: "blue-tanuki",
      tag_name: "v1.0", target_commit_sha: "a".repeat(40), name: "Reviewed draft" };
    let tagCommit = args.target_commit_sha;
    let releaseExists = true;
    const options = fakeGitHubWrite(async () => { throw new Error("mutation must not be sent"); }, undefined,
      async (target) => {
        if (target.path === "/repos/gatchimuchio/blue-tanuki") return githubReadJson({ id: 123, name: "blue-tanuki",
          full_name: "gatchimuchio/blue-tanuki", owner: { login: "gatchimuchio" }, private: false });
        if (target.path === "/repos/gatchimuchio/blue-tanuki/git/ref/tags/v1.0") {
          return githubReadJson({ object: { sha: tagCommit, type: "commit" } });
        }
        if (target.path === "/repos/gatchimuchio/blue-tanuki/releases/tags/v1.0") {
          return releaseExists ? githubReadJson({ id: 1 })
            : { status: 404, ok: false, content_type: "application/json", body: JSON.stringify({ message: "Not Found" }),
              truncated: false, rate_limit_remaining: "60" };
        }
        throw new Error("unexpected synthetic GitHub read " + target.path);
      });
    await expect(inspectGitHubReleaseDraftCreateTargetVersion(args, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/requires the exact tag to have no existing release/);
    releaseExists = false;
    tagCommit = "b".repeat(40);
    await expect(inspectGitHubReleaseDraftCreateTargetVersion(args, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/does not match the exact tag target/);
  });

  it("github.write release.draft.create reports a no-retry receipt for explicit provider rejection", async () => {
    const args = { operation: "release.draft.create", owner: "gatchimuchio", repo: "blue-tanuki",
      tag_name: "v1.0", target_commit_sha: "a".repeat(40), name: "Reviewed draft" };
    let writes = 0;
    const read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path === "/repos/gatchimuchio/blue-tanuki") return githubReadJson({ id: 123, name: "blue-tanuki",
        full_name: "gatchimuchio/blue-tanuki", owner: { login: "gatchimuchio" }, private: false });
      if (target.path === "/repos/gatchimuchio/blue-tanuki/git/ref/tags/v1.0") {
        return githubReadJson({ object: { sha: args.target_commit_sha, type: "commit" } });
      }
      if (target.path === "/repos/gatchimuchio/blue-tanuki/releases/tags/v1.0") return { status: 404, ok: false,
        content_type: "application/json", body: JSON.stringify({ message: "Not Found" }), truncated: false,
        rate_limit_remaining: "60" };
      throw new Error("unexpected synthetic GitHub read " + target.path);
    };
    const options = fakeGitHubWrite(async () => {
      writes += 1;
      return { status: 422, ok: false, content_type: "application/json", body: JSON.stringify({ message: "Validation failed" }),
        truncated: false, rate_limit_remaining: "59", request_id: "DRAFT-REJECT" };
    }, undefined, read_request);
    const target = await inspectGitHubReleaseDraftCreateTargetVersion(args, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) });
    const result = await invokeGitHubWrite(args, { ...options, command_digest: "c".repeat(64),
      operation_plan_binding_digest: "d".repeat(64), expected_target_version_observation: target }) as Record<string, unknown>;
    expect(result).toMatchObject({ operation: "release.draft.create", status: 422, mutation_status: "provider_rejected",
      retry_permitted: false, used_for_authority: false, may_execute: false });
    expect(writes).toBe(1);
  });

  it("github.write release.draft.create does not retry when provider readback is uncertain", async () => {
    const args = { operation: "release.draft.create", owner: "gatchimuchio", repo: "blue-tanuki",
      tag_name: "v1.0", target_commit_sha: "a".repeat(40), name: "Reviewed draft" };
    let writes = 0;
    const read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path === "/repos/gatchimuchio/blue-tanuki") return githubReadJson({ id: 123, name: "blue-tanuki",
        full_name: "gatchimuchio/blue-tanuki", owner: { login: "gatchimuchio" }, private: false });
      if (target.path === "/repos/gatchimuchio/blue-tanuki/git/ref/tags/v1.0") {
        return githubReadJson({ object: { sha: args.target_commit_sha, type: "commit" } });
      }
      if (target.path === "/repos/gatchimuchio/blue-tanuki/releases/tags/v1.0") return { status: 404, ok: false,
        content_type: "application/json", body: JSON.stringify({ message: "Not Found" }), truncated: false,
        rate_limit_remaining: "60" };
      throw new Error("unexpected synthetic GitHub read " + target.path);
    };
    const options = fakeGitHubWrite(async () => {
      writes += 1;
      return { status: 201, ok: true, content_type: "application/json", body: JSON.stringify({ id: 987,
        tag_name: args.tag_name, name: args.name, draft: true, prerelease: false, assets: [] }),
        truncated: false, rate_limit_remaining: "59", request_id: "DRAFT-UNCERTAIN" };
    }, undefined, read_request);
    const target = await inspectGitHubReleaseDraftCreateTargetVersion(args, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) });
    await expect(invokeGitHubWrite(args, { ...options, command_digest: "c".repeat(64),
      operation_plan_binding_digest: "d".repeat(64), expected_target_version_observation: target }))
      .rejects.toThrow(/readback could not confirm.*outcome_unknown.*do not retry automatically/);
    expect(writes).toBe(1);
  });

  it("github.write code.push refuses default branches, existing files, and a stale expected HEAD before mutation", async () => {
    const baseArgs = { operation: "code.push", owner: "gatchimuchio", repo: "blue-tanuki",
      branch: "feature/code-push", expected_head_sha: "a".repeat(40), path: "docs/new-note.txt",
      content: "reviewed file\n", commit_message: "Add reviewed note" };
    let branchReads = 0;
    let writes = 0;
    let existingFile = true;
    const read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
      if (target.path.includes("/branches/")) {
        branchReads += 1;
        const sha = branchReads > 1 ? "b".repeat(40) : baseArgs.expected_head_sha;
        const branch = target.path.slice(target.path.lastIndexOf("/branches/") + "/branches/".length);
        return githubReadJson({ name: branch, commit: { sha } });
      }
      if (target.path.includes("/contents/")) return existingFile
        ? { status: 200, ok: true, content_type: "application/json", body: JSON.stringify({ name: "new-note.txt" }),
            truncated: false, rate_limit_remaining: "60" }
        : { status: 404, ok: false, content_type: "application/json", body: JSON.stringify({ message: "Not Found" }),
            truncated: false, rate_limit_remaining: "60" };
      return githubReadJson({ id: 123, name: "blue-tanuki", full_name: "gatchimuchio/blue-tanuki",
        owner: { login: "gatchimuchio" }, default_branch: "main", private: false });
    };
    const options = fakeGitHubWrite(async () => { writes += 1; throw new Error("mutation must not be sent"); },
      undefined, read_request);
    await expect(inspectGitHubCodePushTargetVersion({ ...baseArgs, branch: "main" }, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/non-default branch/);
    await expect(inspectGitHubCodePushTargetVersion(baseArgs, { ...options,
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64) }))
      .rejects.toThrow(/only creates a file that is absent/);
    existingFile = false;
    branchReads = 0;
    const target = await inspectGitHubCodePushTargetVersion(baseArgs, { ...options, command_digest: "c".repeat(64),
      operation_plan_binding_digest: "d".repeat(64) });
    await expect(invokeGitHubWrite(baseArgs, { ...options, command_digest: "c".repeat(64),
      operation_plan_binding_digest: "d".repeat(64), expected_target_version_observation: target }))
      .rejects.toThrow(/expected branch HEAD is stale.*mutation_sent=false/);
    expect(writes).toBe(0);
  });
});

function shellTestEnv(root: string, additional: Record<string, string> = {}): Record<string, string> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return {
    BLUE_TANUKI_SHELL_ROOT: root,
    PATH: path.join(systemRoot, "System32"),
    SystemRoot: systemRoot,
    ...additional,
  };
}

function linuxShellTestEnv(root: string, additional: Record<string, string> = {}): Record<string, string> {
  return {
    BLUE_TANUKI_SHELL_ROOT: root,
    PATH: "/usr/bin:/bin",
    ...additional,
  };
}

function fakeHttp(
  records: Record<string, { address: string; family: 4 | 6 }>,
  request: HttpFetchOptions["request"] = async () => ({
    status: 200,
    ok: true,
    content_type: "text/plain",
    location: null,
    body: "ok",
    truncated: false,
  }),
): HttpFetchOptions {
  return {
    env: {},
    async resolveHost(hostname) {
      const record = records[hostname];
      if (!record) return [];
      return [record];
    },
    request,
  };
}

function fileSearchEnv(root: string): FileSearchOptions {
  return {
    env: {
      BLUE_TANUKI_FILE_ROOT: root,
    },
  };
}

function fakeGitHub(
  request: NonNullable<GitHubReadOptions["request"]> = async () => ({
    status: 200,
    ok: true,
    content_type: "application/json",
    body: "{}",
    truncated: false,
    rate_limit_remaining: "60",
  }),
): GitHubReadOptions {
  return { request };
}

function fakeGitHubWrite(
  request: NonNullable<GitHubWriteOptions["request"]> = async () => ({
    status: 201,
    ok: true,
    content_type: "application/json",
    body: "{}",
    truncated: false,
    rate_limit_remaining: "60",
    request_id: "REQ",
  }),
  env: Record<string, string | undefined> = {
    GITHUB_TOKEN: "ghp_dummy",
    BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki",
  },
  read_request: NonNullable<GitHubWriteOptions["read_request"]> = async () => ({
    status: 200,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({
      id: 123,
      name: "blue-tanuki",
      full_name: "gatchimuchio/blue-tanuki",
      owner: { login: "gatchimuchio" },
      default_branch: "main",
      private: false,
    }),
    truncated: false,
    rate_limit_remaining: "60",
  }),
): GitHubWriteOptions {
  return { request, env, read_request };
}

async function reviewedGitHubIssue(args: Record<string, unknown>, options: GitHubWriteOptions = fakeGitHubWrite())
  : Promise<GitHubWriteOptions> {
  const command_digest = "c".repeat(64);
  const operation_plan_binding_digest = "d".repeat(64);
  const target = await inspectGitHubIssueCreateTargetVersion(args, {
    ...options, command_digest, operation_plan_binding_digest,
  });
  return { ...options, command_digest, operation_plan_binding_digest,
    expected_target_version_observation: target };
}

function githubReadJson(body: unknown) {
  return {
    status: 200,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify(body),
    truncated: false,
    rate_limit_remaining: "60",
  };
}

function fakeGitHubIssueUpdate(
  request: NonNullable<GitHubWriteOptions["request"]> = async () => ({
    status: 200,
    ok: true,
    content_type: "application/json",
    body: "{}",
    truncated: false,
    rate_limit_remaining: "60",
    request_id: "UPDATE-REQ",
  }),
  read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => target.path.endsWith("/issues/7")
    ? githubReadJson({
      id: 456,
      number: 7,
      state: "open",
      locked: false,
      updated_at: "2026-11-07T12:00:00Z",
      title: "Original title",
      body: "Original body",
    })
    : githubReadJson({
      id: 123,
      name: "blue-tanuki",
      full_name: "gatchimuchio/blue-tanuki",
      owner: { login: "gatchimuchio" },
      private: false,
    }),
): GitHubWriteOptions {
  return fakeGitHubWrite(request, undefined, read_request);
}

function fakeGitHubIssueCommentCreate(
  request: NonNullable<GitHubWriteOptions["request"]> = async () => ({
    status: 201,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({ id: 789, body: "Synthetic comment" }),
    truncated: false,
    rate_limit_remaining: "60",
    request_id: "COMMENT-REQ",
  }),
  read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => target.path.endsWith("/issues/7")
    ? githubReadJson({
      id: 456,
      number: 7,
      state: "open",
      locked: false,
      updated_at: "2026-11-07T12:00:00Z",
      title: "Original title",
      body: "Original issue body",
    })
    : githubReadJson({
      id: 123,
      name: "blue-tanuki",
      full_name: "gatchimuchio/blue-tanuki",
      owner: { login: "gatchimuchio" },
      private: false,
    }),
): GitHubWriteOptions {
  return fakeGitHubWrite(request, undefined, read_request);
}

function fakeGitHubPullRequestCommentCreate(
  request: NonNullable<GitHubWriteOptions["request"]> = async (target) => target.path.endsWith("/pulls/7/comments")
    ? ({
      status: 201,
      ok: true,
      content_type: "application/json",
      body: JSON.stringify({ id: 791, body: String(target.body.body), path: target.body.path,
        ...(target.body.start_line === undefined ? {} : { start_line: target.body.start_line,
          start_side: target.body.start_side }), line: target.body.line, side: target.body.side, commit_id: target.body.commit_id,
        pull_request_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" }),
      truncated: false,
      rate_limit_remaining: "60",
      request_id: "PR-INLINE-COMMENT-REQ",
    })
    : ({
      status: 201,
      ok: true,
      content_type: "application/json",
      body: JSON.stringify({ id: 790, body: String(target.body.body),
        issue_url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/issues/7" }),
      truncated: false,
      rate_limit_remaining: "60",
      request_id: "PR-COMMENT-REQ",
    }),
  read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => target.path.endsWith("/issues/7")
    ? githubReadJson({
      id: 456,
      number: 7,
      state: "open",
      locked: false,
      updated_at: "2026-11-07T12:00:00Z",
      title: "Original pull request title",
      body: "Original pull request body",
      pull_request: { url: "https://api.github.com/repos/gatchimuchio/blue-tanuki/pulls/7" },
    })
    : target.path.includes("/pulls/7/files?")
      ? githubReadJson([{ filename: "src/a.ts", status: "modified", sha: "e".repeat(40),
        patch: "@@ -9,2 +9,3 @@\n context line\n-old line\n+new line\n+extra line" }])
      : target.path.endsWith("/pulls/7")
        ? githubReadJson({ id: 456, number: 7, state: "open",
          head: { sha: "c".repeat(40) }, base: { sha: "d".repeat(40) } })
    : githubReadJson({
      id: 123,
      name: "blue-tanuki",
      full_name: "gatchimuchio/blue-tanuki",
      owner: { login: "gatchimuchio" },
      private: false,
    }),
): GitHubWriteOptions {
  return fakeGitHubWrite(request, undefined, read_request);
}

const GITHUB_PR_HEAD_SHA = "a".repeat(40);
const GITHUB_PR_BASE_SHA = "b".repeat(40);

function fakeGitHubPullRequestCreate(
  request: NonNullable<GitHubWriteOptions["request"]> = async () => ({
    status: 201,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({
      id: 987,
      number: 42,
      title: "Add the feature",
      body: "Exact PR body",
      state: "open",
      draft: true,
      maintainer_can_modify: false,
      head: { ref: "feature/pr-creation", sha: GITHUB_PR_HEAD_SHA,
        repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
      base: { ref: "main", sha: GITHUB_PR_BASE_SHA,
        repo: { id: 123, full_name: "gatchimuchio/blue-tanuki" } },
    }),
    truncated: false,
    rate_limit_remaining: "60",
    request_id: "PR-CREATE-REQ",
  }),
  read_request: NonNullable<GitHubWriteOptions["read_request"]> = async (target) => {
    const branchPrefix = "/branches/";
    const branchIndex = target.path.indexOf(branchPrefix);
    if (branchIndex >= 0) {
      const ref = target.path.slice(branchIndex + branchPrefix.length);
      return githubReadJson({
        name: ref,
        commit: { sha: ref === "main" ? GITHUB_PR_BASE_SHA : GITHUB_PR_HEAD_SHA },
      });
    }
    return githubReadJson({
      id: 123,
      name: "blue-tanuki",
      full_name: "gatchimuchio/blue-tanuki",
      owner: { login: "gatchimuchio" },
      default_branch: "main",
      private: false,
      fork: false,
    });
  },
  env: Record<string, string | undefined> = {
    GITHUB_TOKEN: "ghp_dummy",
    BLUE_TANUKI_GITHUB_REPOS: "gatchimuchio/blue-tanuki",
  },
): GitHubWriteOptions {
  return fakeGitHubWrite(request, env, read_request);
}

async function reviewedGitHubIssueCommentCreate(args: Record<string, unknown>,
  options: GitHubWriteOptions = fakeGitHubIssueCommentCreate()): Promise<GitHubWriteOptions> {
  const command_digest = "c".repeat(64);
  const operation_plan_binding_digest = "d".repeat(64);
  const target = await inspectGitHubIssueCommentCreateTargetVersion(args, {
    ...options, command_digest, operation_plan_binding_digest,
  });
  return { ...options, command_digest, operation_plan_binding_digest,
    expected_target_version_observation: target };
}

async function reviewedGitHubPullRequestCommentCreate(args: Record<string, unknown>,
  options: GitHubWriteOptions = fakeGitHubPullRequestCommentCreate()): Promise<GitHubWriteOptions> {
  const command_digest = "c".repeat(64);
  const operation_plan_binding_digest = "d".repeat(64);
  const target = await inspectGitHubPullRequestCommentCreateTargetVersion(args, {
    ...options, command_digest, operation_plan_binding_digest,
  });
  return { ...options, command_digest, operation_plan_binding_digest,
    expected_target_version_observation: target };
}

async function reviewedGitHubIssueUpdate(args: Record<string, unknown>,
  options: GitHubWriteOptions = fakeGitHubIssueUpdate()): Promise<GitHubWriteOptions> {
  const command_digest = "c".repeat(64);
  const operation_plan_binding_digest = "d".repeat(64);
  const target = await inspectGitHubIssueUpdateTargetVersion(args, {
    ...options, command_digest, operation_plan_binding_digest,
  });
  return { ...options, command_digest, operation_plan_binding_digest,
    expected_target_version_observation: target };
}

async function reviewedGitHubPullRequestCreate(args: Record<string, unknown>,
  options: GitHubWriteOptions = fakeGitHubPullRequestCreate()): Promise<GitHubWriteOptions> {
  const command_digest = "c".repeat(64);
  const operation_plan_binding_digest = "d".repeat(64);
  const target = await inspectGitHubPullRequestCreateTargetVersion(args, {
    ...options, command_digest, operation_plan_binding_digest,
  });
  return { ...options, command_digest, operation_plan_binding_digest,
    expected_target_version_observation: target };
}

function googleJson(body: unknown): Awaited<ReturnType<NonNullable<GoogleReadOptions["request"]>>> {
  return {
    status: 200,
    ok: true,
    content_type: "application/json",
    body: JSON.stringify(body),
    truncated: false,
    request_id: "GOOGLE-REQ",
  };
}

function fakeGoogle(
  request: NonNullable<GoogleReadOptions["request"]> = async () => googleJson({}),
  env: Record<string, string | undefined> = {
    GOOGLE_ACCESS_TOKEN: "google-token",
  },
): GoogleReadOptions {
  return {
    env,
    now: () => new Date("2026-05-12T00:00:00Z"),
    request,
  };
}

function googleWriteJson(
  body: unknown,
  status = 200,
): Awaited<ReturnType<NonNullable<GoogleWriteOptions["request"]>>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    content_type: "application/json",
    body: JSON.stringify(body),
    truncated: false,
    request_id: "GOOGLE-WRITE-REQ",
  };
}

function fakeGoogleWrite(
  request: NonNullable<GoogleWriteOptions["request"]> = async () => googleWriteJson({}),
  env: Record<string, string | undefined> = {
    GOOGLE_ACCESS_TOKEN: "google-write-token",
  },
): GoogleWriteOptions {
  return {
    env,
    request,
  };
}

async function observedCalendarAvailability(): Promise<Record<string, unknown>> {
  return await invokeGoogleCalendarRead({ calendar_id: "primary", view: "freebusy",
    time_min: "2026-05-12T09:00:00Z", time_max: "2026-05-12T09:15:00Z" }, fakeGoogle(async () => googleJson({
    timeMin: "2026-05-12T09:00:00Z", timeMax: "2026-05-12T09:15:00Z",
    calendars: { primary: { busy: [] } },
  }))) as Record<string, unknown>;
}

function syntheticDriveCreateRead(
  target: Parameters<NonNullable<GoogleWriteOptions["request"]>>[0],
): Awaited<ReturnType<NonNullable<GoogleWriteOptions["request"]>>> {
  if (target.path.startsWith("/drive/v3/files/parent-1/permissions?")) {
    return googleWriteJson({ permissions: [{ id: "owner-permission", type: "user",
      emailAddress: "owner@example.test", role: "owner", deleted: false }] });
  }
  if (target.path.startsWith("/drive/v3/files/parent-1?")) {
    return googleWriteJson({ id: "parent-1", name: "Parent", mimeType: "application/vnd.google-apps.folder",
      modifiedTime: "2026-05-12T08:00:00Z", parents: ["root"], version: "1", shared: false, trashed: false,
      inheritedPermissionsDisabled: false });
  }
  if (target.path.startsWith("/drive/v3/files?")) return googleWriteJson({ files: [] });
  if (target.path.startsWith("/upload/drive/v3/files?uploadType=multipart")) {
    return googleWriteJson({ id: "file-1", name: "notes.txt", mimeType: "text/plain",
      webViewLink: "https://drive.google.com/file/d/file-1/view" }, 200);
  }
  if (target.path.startsWith("/drive/v3/files/file-1?alt=media")) {
    return { status: 200, ok: true, content_type: "text/plain", body: "hello", truncated: false,
      request_id: "GOOGLE-WRITE-REQ" };
  }
  if (target.path.startsWith("/drive/v3/files/file-1?")) {
    return googleWriteJson({ id: "file-1", name: "notes.txt", mimeType: "text/plain",
      modifiedTime: "2026-05-12T08:01:00Z", parents: ["parent-1"], version: "2", headRevisionId: "rev-1",
      shared: false, trashed: false });
  }
  throw new Error(`unexpected synthetic Drive path: ${target.path}`);
}

function fakeBrowserAutomation(opts: {
  env?: Record<string, string | undefined>;
  records?: Record<string, { address: string; family: 4 | 6 }>;
  runner?: BrowserAutomationOptions["runner"];
}): BrowserAutomationOptions {
  const records = opts.records ?? {
    "example.test": { address: "93.184.216.34", family: 4 },
  };
  return {
    env: opts.env,
    async resolveHost(hostname) {
      const record = records[hostname];
      if (!record) return [];
      return [record];
    },
    runner:
      opts.runner ??
      (async (request) => ({
        engine: "fake-headless",
        final_url: request.url,
        title: "Preview",
        text: "ok",
        truncated: false,
      })),
  };
}

function nextRedirectHost(hostname: string): string {
  const next: Record<string, string> = {
    "a.test": "b.test",
    "b.test": "c.test",
    "c.test": "d.test",
    "d.test": "a.test",
  };
  return next[hostname] ?? "a.test";
}
