import { spawn } from "node:child_process";
import { lstatSync, statSync, type Stats } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeLinuxCredentialSessionBus, nativeLlmCredentialPromptAvailable, promptForLlmCredential } from "../src/llm_credential_prompt.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (load) => ({
  ...await load<typeof import("node:fs")>(),
  statSync: vi.fn(),
  lstatSync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const spawnFixture = vi.mocked(spawn);
const statFixture = vi.mocked(statSync);
const lstatFixture = vi.mocked(lstatSync);
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const geteuidDescriptor = Object.getOwnPropertyDescriptor(process, "geteuid");

function unixFixture(platform: "linux" | "darwin", uid = 1001) {
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true });
  Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true });
}

function hostFile(kind: "file" | "directory" | "socket" | "console", uid: number, mode: number): Stats {
  return { uid, mode, isFile: () => kind === "file", isDirectory: () => kind === "directory",
    isSocket: () => kind === "socket", isCharacterDevice: () => kind === "console" } as Stats;
}

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
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
      vi.stubEnv(key, undefined);
    }
    spawnFixture.mockReset();
    statFixture.mockReset();
    lstatFixture.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
    if (geteuidDescriptor) Object.defineProperty(process, "geteuid", geteuidDescriptor);
    else Reflect.deleteProperty(process, "geteuid");
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

  it("supplies only a fixed public error for a process failure and rejects unsupported platforms", async () => {
    const child = fakeChild();
    const request = promptForLlmCredential("openai", new AbortController().signal);
    child.emit("error", new Error("fixture-child-secret"));
    await expect(request).rejects.toThrow(/^llm_credential_prompt_unavailable$/u);
    Object.defineProperty(process, "platform", { value: "freebsd" });
    await expect(promptForLlmCredential("openai", new AbortController().signal))
      .rejects.toThrow("llm_credential_prompt_unsupported");
    expect(spawnFixture).toHaveBeenCalledOnce();
  });

  it("uses a verified Wayland socket and an absolute masked Linux helper without forwarding inherited secrets", async () => {
    unixFixture("linux");
    const session = { XDG_RUNTIME_DIR: "/run/user/1001", WAYLAND_DISPLAY: "/run/user/1001/wayland-0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus", DISPLAY: "fixture.invalid:0" };
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "tcp:host=fixture.invalid");
    vi.stubEnv("GTK_MODULES", "fixture-untrusted-module");
    lstatFixture.mockImplementation((path) => new Map([
      ["/run/user/1001", hostFile("directory", 1001, 0o700)],
      ["/run/user/1001/wayland-0", hostFile("socket", 1001, 0o600)],
      ["/run/user/1001/bus", hostFile("socket", 1001, 0o600)],
    ]).get(String(path)));
    statFixture.mockImplementation((path) => path === "/usr/bin/zenity" ? hostFile("file", 0, 0o755) : undefined);
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    expect(nativeLlmCredentialPromptAvailable(session)).toBe(true);
    expect(nativeLinuxCredentialSessionBus(session)).toBe(session.DBUS_SESSION_BUS_ADDRESS);
    expect(spawnFixture).not.toHaveBeenCalled();

    const child = fakeChild();
    const request = promptForLlmCredential("openrouter", new AbortController().signal, session);
    const [command, args, options] = spawnFixture.mock.calls[0]!;
    expect(command).toBe("/usr/bin/zenity");
    expect(args).toEqual(expect.arrayContaining(["--entry", "--hide-text", "--timeout=120", expect.stringContaining("OpenRouter")]));
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "ignore"] });
    expect((options as { env: NodeJS.ProcessEnv }).env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1001", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
      GDK_BACKEND: "wayland" });
    const output = Buffer.concat([Buffer.alloc(4_096, 0x61), Buffer.from("\n")]);
    child.stdout.emit("data", output);
    child.emit("close", 0);
    const result = await request;
    expect(result).toEqual(Buffer.alloc(4_096, 0x61));
    expect(output.every((byte) => byte === 0)).toBe(true);
    result?.fill(0);
  });

  it.each([false, true])("uses verified KDE display backends and handles cancellation (Wayland: %s)", async (wayland) => {
    unixFixture("linux");
    vi.stubEnv("DISPLAY", ":0.0");
    const sessionBus = "unix:path=/tmp/dbus-fixture,guid=0123456789abcdef0123456789abcdef";
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", sessionBus);
    if (wayland) {
      vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1001");
      vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    }
    lstatFixture.mockImplementation((path) => new Map([
      ["/tmp/.X11-unix/X0", hostFile("socket", 0, 0o777)],
      ["/tmp/dbus-fixture", hostFile("socket", 1001, 0o600)],
      ["/run/user/1001", hostFile("directory", 1001, 0o700)],
      ["/run/user/1001/wayland-0", hostFile("socket", 1001, 0o600)],
    ]).get(String(path)));
    statFixture.mockImplementation((path) => path === "/usr/bin/kdialog" ? hostFile("file", 0, 0o755) : undefined);
    expect(nativeLinuxCredentialSessionBus()).toBe(sessionBus);
    const child = fakeChild();
    const request = promptForLlmCredential("openai", new AbortController().signal);
    expect(spawnFixture).toHaveBeenCalledWith("/usr/bin/kdialog", ["--title", expect.stringContaining("BLUE-TANUKI"),
      "--password", expect.stringContaining("OpenAI")], expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ":0.0",
      QT_QPA_PLATFORM: wayland ? "wayland;xcb" : "xcb" }) }));
    child.emit("close", 1);
    await expect(request).resolves.toBeNull();
  });

  it("rejects a forwarded or foreign Linux display and a replaceable GUI helper before spawning", async () => {
    unixFixture("linux");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1001/bus");
    statFixture.mockReturnValue(hostFile("file", 0, 0o755));
    const busFixture = hostFile("socket", 1001, 0o600);
    lstatFixture.mockImplementation((path) => path === "/run/user/1001/bus" ? busFixture : undefined);
    vi.stubEnv("DISPLAY", "localhost:10.0");
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    await expect(promptForLlmCredential("openai", new AbortController().signal)).rejects.toThrow("llm_credential_prompt_unavailable");

    vi.stubEnv("DISPLAY", ":0");
    vi.stubEnv("SSH_TTY", "/dev/pts/0");
    lstatFixture.mockImplementation((path) => path === "/run/user/1001/bus" ? busFixture : hostFile("socket", 0, 0o777));
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    vi.stubEnv("SSH_TTY", undefined);
    lstatFixture.mockImplementation((path) => path === "/run/user/1001/bus" ? busFixture : hostFile("socket", 1002, 0o777));
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    lstatFixture.mockImplementation((path) => path === "/run/user/1001/bus" ? busFixture : hostFile("socket", 1001, 0o777));
    statFixture.mockReturnValue(hostFile("file", 1001, 0o755));
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    statFixture.mockReturnValue(hostFile("file", 0, 0o775));
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    expect(spawnFixture).not.toHaveBeenCalled();
  });

  it("requires an explicit same-user local Linux bus even when a runtime socket exists", () => {
    unixFixture("linux");
    lstatFixture.mockReturnValue(hostFile("socket", 1001, 0o600));
    expect(nativeLinuxCredentialSessionBus({ XDG_RUNTIME_DIR: "/run/user/1001" })).toBeUndefined();
    for (const address of ["tcp:host=fixture.invalid", "unix:abstract=/tmp/dbus-fixture",
      "unix:path=/tmp/dbus-fixture;tcp:host=fixture.invalid", "unix:path=/tmp/../tmp/dbus-fixture"]) {
      expect(nativeLinuxCredentialSessionBus({ DBUS_SESSION_BUS_ADDRESS: address })).toBeUndefined();
    }
    lstatFixture.mockReturnValue(hostFile("socket", 1002, 0o600));
    expect(nativeLinuxCredentialSessionBus({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-fixture" })).toBeUndefined();
  });

  it("uses the active macOS console and a hidden Standard Additions dialog, then clears piped bytes", async () => {
    unixFixture("darwin");
    vi.stubEnv("DYLD_INSERT_LIBRARIES", "fixture-untrusted-library");
    statFixture.mockImplementation((path) => path === "/dev/console" ? hostFile("console", 1001, 0o600) : hostFile("file", 0, 0o755));
    expect(nativeLlmCredentialPromptAvailable()).toBe(true);
    const child = fakeChild();
    const request = promptForLlmCredential("anthropic", new AbortController().signal);
    const [command, args, options] = spawnFixture.mock.calls[0]!;
    const script = (args as string[])[1];
    expect(command).toBe("/usr/bin/osascript");
    expect((args as string[])[0]).toBe("-e");
    expect(script).toContain("display dialog");
    expect(script).toContain("with hidden answer giving up after 120");
    expect(script).toContain("Anthropic");
    expect(script).not.toContain("System Events");
    expect(options).toMatchObject({ env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["ignore", "pipe", "ignore"] });
    expect(JSON.stringify(options)).not.toMatch(/DYLD_INSERT_LIBRARIES|ANTHROPIC_API_KEY/u);
    const output = Buffer.from("OK:fixture-macos\n");
    child.stdout.emit("data", output);
    child.emit("close", 0);
    const result = await request;
    expect(result).toEqual(Buffer.from("fixture-macos"));
    expect(output.every((byte) => byte === 0)).toBe(true);
    result?.fill(0);
  });

  it.each([["CANCEL\n", undefined], ["TIMEOUT\n", "llm_credential_prompt_timeout"],
    ["OK:bad\nrecord\n", "llm_credential_prompt_invalid"], ["bad-framing\n", "llm_credential_prompt_invalid"]] as const)(
    "accepts only a framed macOS response or a fixed native status (%s)", async (text, error) => {
      unixFixture("darwin");
      statFixture.mockImplementation((path) => path === "/dev/console" ? hostFile("console", 1001, 0o600) : hostFile("file", 0, 0o755));
      const child = fakeChild();
      const request = promptForLlmCredential("anthropic", new AbortController().signal);
      child.stdout.emit("data", Buffer.from(text));
      child.emit("close", 0);
      if (error) await expect(request).rejects.toThrow(error);
      else await expect(request).resolves.toBeNull();
    },
  );

  it("does not open a prompt for another macOS console user", async () => {
    unixFixture("darwin");
    statFixture.mockReturnValue(hostFile("console", 1002, 0o600));
    expect(nativeLlmCredentialPromptAvailable()).toBe(false);
    await expect(promptForLlmCredential("anthropic", new AbortController().signal)).rejects.toThrow("llm_credential_prompt_unavailable");
    expect(spawnFixture).not.toHaveBeenCalled();
  });
});
