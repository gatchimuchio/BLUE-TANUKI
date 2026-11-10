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
  return (platform, key) => {
    const id = `${platform}:${key}`;
    return {
      setPassword: (plaintext) => { secrets.set(id, plaintext); },
      getPassword: () => secrets.get(id) ?? null,
    };
  };
}

describe("LLM secret store", () => {
  it("resolves only the requested secret without mutating the environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-scoped-secret-store-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const keyringFactory = createFakeKeyringFactory();
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
      expect(stored.ref).toBe("os-keyring:v1:linux:OPENROUTER_API_KEY");
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
      const stored = storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-secret", {
        envFilePath: path.join(root, "blue-tanuki.env"),
        platform: "win32",
        protector: fakeProtector,
      });
      const resolved = resolveLLMSecretRefs(
        { [secretRefKey("OPENROUTER_API_KEY")]: stored.ref },
        { platform: "win32", protector: fakeProtector },
      );
      expect(stored.storage).toBe("win32_dpapi_current_user");
      expect(resolved.OPENROUTER_API_KEY).toBe("openrouter-secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a DPAPI ref is used on an unsupported platform", () => {
    expect(() =>
      resolveLLMSecretRefs(
        { OPENROUTER_API_KEY_REF: "win32-dpapi-current-user:file:abc" },
        { platform: "linux" },
      ),
    ).toThrow(/requires Windows DPAPI/);
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
