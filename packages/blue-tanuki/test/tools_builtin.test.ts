import { describe, expect, it } from "vitest";
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
  invokeFileWrite,
  inspectFileDeleteTargetVersion,
  invokeFileDelete,
  invokeFileEdit,
  invokeHttpFetch,
  invokeWebSearch,
  invokeGitHubRead,
  invokeGitHubWrite,
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
    expect(registry.get("composio.execute")).toBeDefined();
    expect(registry.listCapabilities()).toEqual([
      "browser:act",
      "browser:snapshot",
      "email:send",
      "external:send",
      "fs:delete",
      "fs:read",
      "fs:write",
      "github:comment.write",
      "github:issue.write",
      "github:pr.write",
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
      "tool:composio.execute",
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
      const edited = await invokeFileEdit(
        {
          path: "a.txt",
          search: "one",
          replace: "blue",
          expected_replacements: 2,
        },
        fileSearchEnv(dir),
      );
      expect(edited).toMatchObject({
        path: "a.txt",
        replacements: 2,
      });
      expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe(
        "blue fish\nblue bird\n",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("file.edit refuses replacement-count mismatch and binary-looking files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-tool-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "one one\n", "utf8");
      await expect(
        invokeFileEdit(
          { path: "a.txt", search: "one", replace: "two" },
          fileSearchEnv(dir),
        ),
      ).rejects.toThrow(/expected 1 replacement/);

      await fs.writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 2]));
      await expect(
        invokeFileEdit(
          { path: "b.bin", search: "x", replace: "y" },
          fileSearchEnv(dir),
        ),
      ).rejects.toThrow(/binary/);
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
    expect(calendar.events).toEqual([{ id: "event-1", status: "confirmed", summary: "Standup", start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z", html_link: "https://calendar.google.com/event?eid=event-1" }]);
    expect(drive.files).toEqual([{ id: "file-1", name: "Spec notes", mime_type: "application/vnd.google-apps.document", modified_time: "2026-05-12T08:00:00Z", web_view_link: "https://drive.google.com/file/d/file-1/view" }]);
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
      if (target.path.startsWith("/upload/drive/v3/files?uploadType=multipart")) {
        return googleWriteJson({
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          webViewLink: "https://drive.google.com/file/d/file-1/view",
        }, 200);
      }
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
    const calendar = (await invokeGoogleCalendarWrite(
      {
        operation: "event.create",
        calendar_id: "primary",
        summary: "Standup",
        start: "2026-05-12T09:00:00Z",
        end: "2026-05-12T09:15:00Z",
        max_bytes: 4096,
      },
      opts,
    )) as { result: Record<string, unknown> };
    const drive = (await invokeGoogleDriveWrite(
      {
        operation: "file.create",
        name: "notes.txt",
        content: "hello",
        mime_type: "text/plain",
        max_bytes: 4096,
      },
      opts,
    )) as { result: Record<string, unknown> };

    expect(gmail).toMatchObject({
      mutation_sent: true,
      mutation_status: "confirmed",
      result: { id: "draft-1", message_id: "msg-1", message_thread_id: "thread-1" },
    });
    expect(calendar.result).toMatchObject({ id: "event-1", status: "confirmed", summary: "Standup" });
    expect(drive.result).toMatchObject({ id: "file-1", name: "notes.txt", mimeType: "text/plain" });
    expect(seen.map((item) => [item.service, item.hostname, item.method])).toEqual([
      ["gmail", "gmail.googleapis.com", "POST"],
      ["calendar", "www.googleapis.com", "POST"],
      ["drive", "www.googleapis.com", "POST"],
    ]);
    expect(seen[0]!.body).toContain("raw");
    expect(seen[1]!.path).toContain("sendUpdates=none");
    expect(seen[1]!.body).not.toContain("attendees");
    expect(seen[2]!.contentType).toContain("multipart/related");
    expect(JSON.stringify({ gmail, calendar, drive })).not.toContain("google-write-token");
  });

  it("Google write tools fail closed before network when tokens or required args are missing", async () => {
    let called = false;
    const opts = fakeGoogleWrite(async () => {
      called = true;
      throw new Error("should not call network");
    }, {});

    await expect(
      invokeGmailWrite({ operation: "message.send", to: "owner@example.test", subject: "hi", body_text: "hello" }, opts),
    ).rejects.toThrow(/GMAIL_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleCalendarWrite({ operation: "event.create", summary: "Standup", start: "2026-05-12T09:00:00Z", end: "2026-05-12T09:15:00Z" }, opts),
    ).rejects.toThrow(/GOOGLE_CALENDAR_ACCESS_TOKEN.*GOOGLE_ACCESS_TOKEN.*request_sent=false.*mutation_sent=false/);
    await expect(
      invokeGoogleDriveWrite({ operation: "file.create", name: "notes.txt", content: "hello" }, opts),
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
    const result = (await invokeGitHubWrite(
      {
        operation: "issue.create",
        owner: "gatchimuchio",
        repo: "blue-tanuki",
        title: "Phase smoke",
        body: "created by test",
        max_bytes: 4096,
      },
      fakeGitHubWrite(async (target) => {
        seen.push(target);
        return {
          status: 201,
          ok: true,
          content_type: "application/json",
          body: JSON.stringify({
            id: 123,
            number: 7,
            title: "Phase smoke",
            html_url: "https://github.com/gatchimuchio/blue-tanuki/issues/7",
          }),
          truncated: false,
          rate_limit_remaining: "58",
          request_id: "ABC123",
        };
      }),
    )) as {
      operation: string;
      api_host: string;
      repo: string;
      method: string;
      path: string;
      status: number;
      github_request_id: string;
      result_digest: string;
      result: { number: number; title: string; html_url: string };
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
        number: 7,
        title: "Phase smoke",
        html_url: "https://github.com/gatchimuchio/blue-tanuki/issues/7",
      },
    });
    expect(result.result_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("ghp_dummy");
  });

  it("github.write supports PR creation and comment/update paths", async () => {
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const opts = fakeGitHubWrite(async (target) => {
      seen.push({ method: target.method, path: target.path, body: target.body });
      return {
        status: target.method === "PATCH" ? 200 : 201,
        ok: true,
        content_type: "application/json",
        body: JSON.stringify({ number: 42, html_url: "https://github.test/42" }),
        truncated: false,
        rate_limit_remaining: "57",
        request_id: "REQ",
      };
    });

    await invokeGitHubWrite(
      {
        operation: "pr.create",
        owner: "gatchimuchio",
        repo: "blue-tanuki",
        title: "Add feature",
        head: "feature",
        base: "main",
        draft: "true",
      },
      opts,
    );
    await invokeGitHubWrite(
      {
        operation: "pr.comment.create",
        owner: "gatchimuchio",
        repo: "blue-tanuki",
        number: 42,
        body: "review note",
      },
      opts,
    );
    await invokeGitHubWrite(
      {
        operation: "issue.update",
        owner: "gatchimuchio",
        repo: "blue-tanuki",
        number: 7,
        title: "Updated issue",
      },
      opts,
    );

    expect(seen).toEqual([
      {
        method: "POST",
        path: "/repos/gatchimuchio/blue-tanuki/pulls",
        body: { title: "Add feature", head: "feature", base: "main", draft: true },
      },
      {
        method: "POST",
        path: "/repos/gatchimuchio/blue-tanuki/issues/42/comments",
        body: { body: "review note" },
      },
      {
        method: "PATCH",
        path: "/repos/gatchimuchio/blue-tanuki/issues/7",
        body: { title: "Updated issue" },
      },
    ]);
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

  it("github.write reports safe retry state on GitHub API errors", async () => {
    await expect(
      invokeGitHubWrite(
        {
          operation: "issue.create",
          owner: "gatchimuchio",
          repo: "blue-tanuki",
          title: "bad",
        },
        fakeGitHubWrite(async () => ({
          status: 422,
          ok: false,
          content_type: "application/json",
          body: JSON.stringify({ message: "Validation Failed" }),
          truncated: false,
          rate_limit_remaining: "56",
          request_id: "ERR",
        })),
      ),
    ).rejects.toThrow(/mutation_status=not_confirmed.*check GitHub\/audit/);
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
        cancelTimer = setTimeout(() => controller.abort(), 400);
        const result = await invokeShellExec(
          {
            cmd: "powershell.exe",
            args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 15; Set-Content -Path late.txt -Value late"],
            timeout_ms: 30_000,
          },
          { env, nativeProviderPath: providerPath, signal: controller.signal },
        ) as Record<string, unknown>;
        expect(result.signal).toBe("aborted");
        expect(result.process_tree_empty).toBe(true);
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
        expect(result.stderr).toMatch(/File too large/u);
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
): GitHubWriteOptions {
  return { request, env };
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
