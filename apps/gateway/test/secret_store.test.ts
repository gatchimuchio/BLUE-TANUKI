import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  llmSecretStorageStatus,
  connectorSecretStorageStatus,
  resolveAllSecretRefs,
  resolveLLMSecretRefs,
  secretRefKey,
  storeBlueTanukiSecret,
  storeLlmApiKeySecret,
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

describe("LLM secret store", () => {
  it("stores LLM API keys as secret refs and resolves them without authority flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btnk-secret-store-"));
    try {
      const envFilePath = path.join(root, "blue-tanuki.env");
      const stored = storeLlmApiKeySecret("OPENROUTER_API_KEY", "openrouter-secret", {
        envFilePath,
        platform: "linux",
        protector: fakeProtector,
      });

      expect(stored).toMatchObject({
        key: "OPENROUTER_API_KEY",
        ref_key: "OPENROUTER_API_KEY_REF",
        os_protected: true,
        used_for_authority: false,
      });
      expect(stored.ref).not.toContain("openrouter-secret");

      const resolved = resolveLLMSecretRefs(
        { [secretRefKey("OPENROUTER_API_KEY")]: stored.ref },
        { platform: "linux", protector: fakeProtector },
      );
      expect(resolved.OPENROUTER_API_KEY).toBe("openrouter-secret");
      expect(resolved.OPENROUTER_API_KEY_REF).toBe(stored.ref);
      expect(llmSecretStorageStatus(resolved, "openrouter", "win32")).toMatchObject({
        configured_key: "OPENROUTER_API_KEY",
        raw_env_present: true,
        secret_ref_present: true,
        os_protected: true,
        used_for_authority: false,
      });
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
      const composio = storeBlueTanukiSecret("COMPOSIO_API_KEY", "composio-secret", {
        envFilePath,
        platform: "linux",
        protector: fakeProtector,
      });
      const google = storeBlueTanukiSecret("GOOGLE_ACCESS_TOKEN", "google-secret", {
        envFilePath,
        platform: "linux",
        protector: fakeProtector,
      });

      const resolved = resolveAllSecretRefs(
        {
          [secretRefKey("COMPOSIO_API_KEY")]: composio.ref,
          [secretRefKey("GOOGLE_ACCESS_TOKEN")]: google.ref,
        },
        { platform: "linux", protector: fakeProtector },
      );

      expect(resolved.COMPOSIO_API_KEY).toBe("composio-secret");
      expect(resolved.GOOGLE_ACCESS_TOKEN).toBe("google-secret");
      expect(connectorSecretStorageStatus(resolved, "COMPOSIO_API_KEY", "win32")).toMatchObject({
        configured_key: "COMPOSIO_API_KEY",
        raw_env_present: true,
        secret_ref_present: true,
        os_protected: true,
        used_for_authority: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
