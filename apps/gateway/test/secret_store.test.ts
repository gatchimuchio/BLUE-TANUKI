import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  llmSecretStorageStatus,
  connectorSecretStorageStatus,
  resolveAllSecretRefs,
  resolveLLMSecretRefs,
  resolveSecretMaterial,
  secretRefKey,
  storeBlueTanukiSecret,
  storeLlmApiKeySecret,
  type SecretKeyringFactory,
  type SecretProtector,
} from "../src/secret_store.js";

const fakeProtector: SecretProtector = {
  protect: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8").toString("base64url"),
  unprotect: (protectedValue) => {
    const decoded = Buffer.from(protectedValue, "base64url").toString("utf8");
    if (!decoded.startsWith("protected:")) throw new Error("bad test secret");
    return decoded.slice("protected:".length);
  },
};

function createFakeKeyringFactory(): SecretKeyringFactory {
  const secrets = new Map<string, string>();
  return (platform, key, entryId) => {
    const id = `${platform}:${key}:${entryId ?? "legacy"}`;
    return {
      setPassword: (plaintext) => { secrets.set(id, plaintext); },
      getPassword: () => secrets.get(id) ?? null,
      deletePassword: () => secrets.delete(id),
    };
  };
}

function pathFromDpapiRef(ref: string): string {
  const prefix = "win32-dpapi-current-user:file:";
  if (!ref.startsWith(prefix)) throw new Error("not a Windows DPAPI file ref");
  const secretPath = Buffer.from(ref.slice(prefix.length), "base64url").toString("utf8");
  if (!path.isAbsolute(secretPath)) throw new Error("DPAPI ref path is not absolute");
  return path.resolve(secretPath);
}

describe("LLM secret store", () => {
  it("resolves only the requested secret without mutating the environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-scoped-secret-store-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const keyringFactory = createFakeKeyringFactory();
      keyringFactory("linux", "TELEGRAM_BOT_TOKEN").setPassword("telegram-secret");
      const google = storeBlueTanukiSecret("GOOGLE_ACCESS_TOKEN", "google-secret", {
        envFilePath,
        platform: "linux",
        keyringFactory,
      });
      storeBlueTanukiSecret("TELEGRAM_BOT_TOKEN", "telegram-secret", {
        envFilePath,
        platform: "linux",
        keyringFactory,
      });
      const env = {
        [secretRefKey("GOOGLE_ACCESS_TOKEN")]: google.ref,
        [secretRefKey("TELEGRAM_BOT_TOKEN")]: "os-keyring:v1:linux:TELEGRAM_BOT_TOKEN",
      };

      expect(resolveSecretMaterial(env, "GOOGLE_ACCESS_TOKEN", { platform: "linux", keyringFactory }))
        .toBe("google-secret");
      expect(resolveSecretMaterial(env, "TELEGRAM_BOT_TOKEN", { platform: "linux", keyringFactory }))
        .toBe("telegram-secret");
      expect(env).toEqual({
        [secretRefKey("GOOGLE_ACCESS_TOKEN")]: google.ref,
        [secretRefKey("TELEGRAM_BOT_TOKEN")]: "os-keyring:v1:linux:TELEGRAM_BOT_TOKEN",
      });
      expect(env.GOOGLE_ACCESS_TOKEN).toBeUndefined();
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stores Linux LLM API keys in the persistent Secret Service ref and resolves them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-secret-store-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const keyringFactory = createFakeKeyringFactory();
      const stored = storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-secret", {
        envFilePath,
        platform: "linux",
        keyringFactory,
      });

      expect(stored).toMatchObject({
        key: "OPENROUTER_API_KEY",
        ref_key: "OPENROUTER_API_KEY_REF",
        os_protected: true,
        used_for_authority: false,
      });
      expect(stored.ref).not.toContain("openrouter-secret");
      expect(stored.ref).toMatch(/^os-keyring:v2:linux:OPENROUTER_API_KEY:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(stored.storage).toBe("os_keyring_current_user");

      const resolved = resolveLLMSecretRefs(
        { [secretRefKey("OPENROUTER_API_KEY")]: stored.ref },
        { platform: "linux", keyringFactory },
      );
      expect(resolved.OPENROUTER_API_KEY).toBe("openrouter-secret");
      expect(resolved.OPENROUTER_API_KEY_REF).toBe(stored.ref);
      expect(llmSecretStorageStatus(
        { [secretRefKey("OPENROUTER_API_KEY")]: stored.ref },
        "openrouter",
        "linux",
      )).toMatchObject({
        configured_key: "OPENROUTER_API_KEY",
        raw_env_present: false,
        secret_ref_present: true,
        os_protected: true,
        storage: "os_keyring_current_user",
        used_for_authority: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Windows DPAPI refs working", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-secret-store-dpapi-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const first = storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-old-secret", {
        envFilePath,
        platform: "win32",
        protector: fakeProtector,
      });
      const second = storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-new-secret", {
        envFilePath,
        platform: "win32",
        protector: fakeProtector,
      });
      const oldResolved = resolveLLMSecretRefs(
        { [secretRefKey("OPENROUTER_API_KEY")]: first.ref },
        { platform: "win32", protector: fakeProtector },
      );
      const newResolved = resolveLLMSecretRefs(
        { [secretRefKey("OPENROUTER_API_KEY")]: second.ref },
        { platform: "win32", protector: fakeProtector },
      );
      expect(first.ref).not.toBe(second.ref);
      expect(first.storage).toBe("win32_dpapi_current_user");
      expect(llmSecretStorageStatus(
        { [secretRefKey("OPENROUTER_API_KEY")]: first.ref },
        "openrouter",
        "win32",
      )).toMatchObject({
        os_protected: true,
        storage: "win32_dpapi_current_user",
      });
      expect(oldResolved.OPENROUTER_API_KEY).toBe("openrouter-old-secret");
      expect(newResolved.OPENROUTER_API_KEY).toBe("openrouter-new-secret");
      expect(await fs.readFile(pathFromDpapiRef(first.ref), "utf8")).not.toContain("openrouter-old-secret");
      expect(await fs.readFile(pathFromDpapiRef(second.ref), "utf8")).not.toContain("openrouter-new-secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses versioned refs so credential rotation preserves older backups", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `btnk-secret-rotation-${platform}-`));
      try {
        const keyringFactory = createFakeKeyringFactory();
        const first = storeLlmApiKeySecret("OPENROUTER_API_KEY", "old-secret", {
          envFilePath: path.join(root, "blue-tanuki.env"),
          platform,
          keyringFactory,
        });
        const second = storeLlmApiKeySecret("OPENROUTER_API_KEY", "new-secret", {
          envFilePath: path.join(root, "blue-tanuki.env"),
          platform,
          keyringFactory,
        });

        expect(second.ref).not.toBe(first.ref);
        expect(resolveSecretMaterial(
          { OPENROUTER_API_KEY_REF: first.ref },
          "OPENROUTER_API_KEY",
          { platform, keyringFactory },
        )).toBe("old-secret");
        expect(resolveSecretMaterial(
          { OPENROUTER_API_KEY_REF: second.ref },
          "OPENROUTER_API_KEY",
          { platform, keyringFactory },
        )).toBe("new-secret");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("removes a staged Windows secret when readback verification fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-secret-readback-"));
    try {
      const badProtector: SecretProtector = {
        protect: fakeProtector.protect,
        unprotect: () => "different-secret",
      };
      expect(() => storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-secret", {
        envFilePath: path.join(root, "blue-tanuki.env"),
        platform: "win32",
        protector: badProtector,
      })).toThrow(/readback did not match/);
      await expect(fs.readdir(path.join(root, "secrets"))).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes an OS keyring entry when readback verification fails", () => {
    const entries = new Map<string, string>();
    const keyringFactory: SecretKeyringFactory = (platform, key, entryId) => {
      const id = `${platform}:${key}:${entryId}`;
      return {
        setPassword: (plaintext) => { entries.set(id, plaintext); },
        getPassword: () => entries.has(id) ? "mismatched-readback" : null,
        deletePassword: () => entries.delete(id),
      };
    };

    expect(() => storeBlueTanukiSecret("GOOGLE_ACCESS_TOKEN", "google-secret", {
      envFilePath: path.join(os.tmpdir(), "blue-tanuki.env"),
      platform: "linux",
      keyringFactory,
    })).toThrow(/readback did not match/);
    expect(entries.size).toBe(0);
  });

  it("fails closed when a DPAPI ref is used on an unsupported platform", () => {
    expect(() =>
      resolveLLMSecretRefs(
        { OPENROUTER_API_KEY_REF: "win32-dpapi-current-user:file:abc" },
        { platform: "linux" },
      ),
    ).toThrow(/requires Windows DPAPI/);
  });

  it("does not report malformed Windows DPAPI refs as protected storage", () => {
    const invalidRef = `win32-dpapi-current-user:file:${Buffer.from("relative/secret.dpapi", "utf8").toString("base64url")}`;
    expect(llmSecretStorageStatus(
      { OPENROUTER_API_KEY_REF: invalidRef },
      "openrouter",
      "win32",
    )).toMatchObject({
      secret_ref_present: true,
      os_protected: false,
      storage: "unknown",
    });
    expect(connectorSecretStorageStatus(
      { GITHUB_TOKEN_REF: invalidRef },
      "GITHUB_TOKEN",
      "win32",
    )).toMatchObject({
      secret_ref_present: true,
      os_protected: false,
      storage: "unknown",
    });
  });

  it("stores connector credentials as secret refs and resolves them with LLM refs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-connector-secret-store-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const keyringFactory = createFakeKeyringFactory();
      const composio = storeBlueTanukiSecret("COMPOSIO_API_KEY", "composio-secret", {
        envFilePath,
        platform: "linux",
        keyringFactory,
      });
      const google = storeBlueTanukiSecret("GOOGLE_ACCESS_TOKEN", "google-secret", {
        envFilePath,
        platform: "linux",
        keyringFactory,
      });

      const resolved = resolveAllSecretRefs(
        {
          [secretRefKey("COMPOSIO_API_KEY")]: composio.ref,
          [secretRefKey("GOOGLE_ACCESS_TOKEN")]: google.ref,
        },
        { platform: "linux", keyringFactory },
      );

      expect(resolved.COMPOSIO_API_KEY).toBe("composio-secret");
      expect(resolved.GOOGLE_ACCESS_TOKEN).toBe("google-secret");
      expect(connectorSecretStorageStatus(
        { [secretRefKey("COMPOSIO_API_KEY")]: composio.ref },
        "COMPOSIO_API_KEY",
        "linux",
      )).toMatchObject({
        configured_key: "COMPOSIO_API_KEY",
        raw_env_present: false,
        secret_ref_present: true,
        os_protected: true,
        storage: "os_keyring_current_user",
        used_for_authority: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not report protected storage when raw environment material takes precedence", () => {
    const llmEnv = {
      OPENROUTER_API_KEY: "fixture-raw-llm-key",
      OPENROUTER_API_KEY_REF: "os-keyring:v2:linux:OPENROUTER_API_KEY:00000000-0000-0000-0000-000000000001",
    };
    expect(resolveLLMSecretRefs(llmEnv, { platform: "linux" }).OPENROUTER_API_KEY)
      .toBe("fixture-raw-llm-key");
    expect(llmSecretStorageStatus(llmEnv, "openrouter", "linux")).toMatchObject({
      raw_env_present: true,
      secret_ref_present: true,
      os_protected: false,
      storage: "env_file",
    });

    expect(connectorSecretStorageStatus({
      GITHUB_TOKEN: "fixture-raw-connector-token",
      GITHUB_TOKEN_REF: "os-keyring:v2:linux:GITHUB_TOKEN:00000000-0000-0000-0000-000000000002",
    }, "GITHUB_TOKEN", "linux")).toMatchObject({
      raw_env_present: true,
      secret_ref_present: true,
      os_protected: false,
      storage: "env_file",
    });
  });

  it("rejects OS keyring refs bound to a different platform or key", () => {
    expect(() => resolveLLMSecretRefs(
      { OPENROUTER_API_KEY_REF: "os-keyring:v1:darwin:OPENROUTER_API_KEY" },
      { platform: "linux", keyringFactory: createFakeKeyringFactory() },
    )).toThrow(/does not match this platform or secret key/);
    expect(() => resolveLLMSecretRefs(
      { OPENROUTER_API_KEY_REF: "os-keyring:v1:linux:ANTHROPIC_API_KEY" },
      { platform: "linux", keyringFactory: createFakeKeyringFactory() },
    )).toThrow(/does not match this platform or secret key/);
  });
});
