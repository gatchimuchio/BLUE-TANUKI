import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptForLlmCredential } from "../src/llm_credential_prompt.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const spawnFixture = vi.mocked(spawn);

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(() => true) });
  spawnFixture.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe("native LLM credential prompt", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("BLUE_TANUKI_POWERSHELL", "untrusted-helper.exe");
    vi.stubEnv("ANTHROPIC_API_KEY", "inherited-credential-must-stay-private");
    spawnFixture.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("runs a masked purpose-only modal and returns validated bytes without inheriting credentials", async () => {
    const child = fakeChild();
    const request = promptForLlmCredential("anthropic", new AbortController().signal);
    const [command, args, options] = spawnFixture.mock.calls[0]!;
    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NoLogo", "-NonInteractive", "-STA", "-EncodedCommand", expect.any(String)]);
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    expect(JSON.stringify(options)).not.toContain("inherited-credential-must-stay-private");
    expect(JSON.stringify(options)).not.toContain("untrusted-helper.exe");
    const script = Buffer.from((args as string[]).at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("$password.UseSystemPasswordChar = $true");
    expect(script).toContain("$form.ShowDialog()");
    expect(script).toContain("Anthropic の API キー");
    expect(script).not.toContain("OpenAI");
    expect(script).not.toContain("ReadLine");
    expect(script).not.toContain("fixture-secret");
    const first = Buffer.from("fixture-");
    const second = Buffer.from("secret");
    child.stdout.emit("data", first);
    child.stdout.emit("data", second);
    child.emit("close", 0);
    const result = await request;
    expect(result).toEqual(Buffer.from("fixture-secret"));
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(second.every((byte) => byte === 0)).toBe(true);
    result?.fill(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("distinguishes a cancelled modal from a native timeout", async () => {
    for (const code of [2, 3]) {
      const child = fakeChild();
      const result = promptForLlmCredential("openai", new AbortController().signal);
      child.emit("close", code);
      if (code === 2) await expect(result).resolves.toBeNull();
      else await expect(result).rejects.toThrow("llm_credential_prompt_timeout");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("stops on abort and discards later output from the child", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const request = promptForLlmCredential("openrouter", controller.signal);
    const data = Buffer.from("fixture-secret");
    child.stdout.emit("data", data);
    controller.abort();
    await expect(request).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(data.every((byte) => byte === 0)).toBe(true);
    const trailing = Buffer.from("unexpected data");
    child.stdout.emit("data", trailing);
    child.emit("close", 0);
    expect(trailing.every((byte) => byte === 0)).toBe(true);
    await expect(promptForLlmCredential("openrouter", controller.signal)).resolves.toBeNull();
    expect(spawnFixture).toHaveBeenCalledOnce();
  });

  it("terminates an unresponsive child at a finite deadline", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const request = promptForLlmCredential("openai", new AbortController().signal);
    const failure = expect(request).rejects.toThrow("llm_credential_prompt_timeout");
    await vi.advanceTimersByTimeAsync(125_000);
    await failure;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([Buffer.alloc(4_097, 0x61), Buffer.from("invalid newline\n"), Buffer.alloc(0)])(
    "fails closed when the child supplies an invalid key buffer", async (sample) => {
      const child = fakeChild();
      const request = promptForLlmCredential("anthropic", new AbortController().signal);
      const data = Buffer.from(sample);
      child.stdout.emit("data", data);
      child.emit("close", 0);
      await expect(request).rejects.toThrow("llm_credential_prompt_invalid");
      expect(data.every((byte) => byte === 0)).toBe(true);
    },
  );

  it("supplies only a fixed public error for a process failure and stays unavailable off Windows", async () => {
    const child = fakeChild();
    const request = promptForLlmCredential("openai", new AbortController().signal);
    child.emit("error", new Error("fixture-child-secret"));
    await expect(request).rejects.toThrow(/^llm_credential_prompt_unavailable$/u);
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(promptForLlmCredential("openai", new AbortController().signal))
      .rejects.toThrow("llm_credential_prompt_unsupported");
    expect(spawnFixture).toHaveBeenCalledOnce();
  });
});
