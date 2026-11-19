import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { SETTINGS_WRITE_NATIVE_CREDENTIAL_ENTRY_WINDOW_MS, type SettingsWriteActivation,
  type SettingsWriteGoogleReadCredentialScope } from "@blue-tanuki/protocol";
import { windowsSystemChildEnvironment, windowsSystemPowerShellCommand } from "./child_process_environment.js";

const PROVIDER_LABELS: Record<SettingsWriteActivation["provider"], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};
const GOOGLE_READ_LABELS: Readonly<Record<SettingsWriteGoogleReadCredentialScope, string>> = {
  gmail: "Gmail 読み取り用アクセストークン",
  calendar: "Google カレンダー読み取り用アクセストークン",
  drive: "Google ドライブ読み取り用アクセストークン",
  shared: "Gmail・Google カレンダー・Google ドライブ共通の読み取り用アクセストークン",
};
const NATIVE_PROMPT_TIMEOUT_MS = SETTINGS_WRITE_NATIVE_CREDENTIAL_ENTRY_WINDOW_MS;
const CHILD_TIMEOUT_MS = NATIVE_PROMPT_TIMEOUT_MS + 5_000;
const MAX_CREDENTIAL_BYTES = 4_096;
const DIALOG_TITLE = "BLUE-TANUKI - 資格情報の入力";
const MAC_SUCCESS = Buffer.from("OK:");
const MAC_CANCEL = Buffer.from("CANCEL");
const MAC_TIMEOUT = Buffer.from("TIMEOUT");

interface NativePrompt {
  kind: "windows" | "zenity" | "kdialog" | "macos";
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function promptScript(label: string): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exitCode = 1
$form = $null
$password = $null
$timer = $null
$bytes = $null
try {
  if (-not [Environment]::UserInteractive) { exit 1 }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object System.Windows.Forms.Form
  $form.Text = '${DIALOG_TITLE}'
  $form.ClientSize = New-Object System.Drawing.Size(460, 138)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true

  $description = New-Object System.Windows.Forms.Label
  $description.SetBounds(16, 14, 428, 42)
  $description.Text = '${label}を入力してください。'
  $password = New-Object System.Windows.Forms.TextBox
  $password.SetBounds(16, 56, 428, 22)
  $password.UseSystemPasswordChar = $true
  $password.MaxLength = ${MAX_CREDENTIAL_BYTES}
  $password.AccessibleName = '${label}'
  $submit = New-Object System.Windows.Forms.Button
  $submit.SetBounds(258, 98, 88, 28)
  $submit.Text = '入力'
  $submit.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $submit.Enabled = $false
  $password.add_TextChanged({ $submit.Enabled = $password.TextLength -gt 0 })
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.SetBounds(356, 98, 88, 28)
  $cancel.Text = 'キャンセル'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.AddRange([System.Windows.Forms.Control[]]@($description, $password, $submit, $cancel))
  $form.AcceptButton = $submit
  $form.CancelButton = $cancel
  $form.ActiveControl = $password
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = ${NATIVE_PROMPT_TIMEOUT_MS}
  $timer.add_Tick({ $form.DialogResult = [System.Windows.Forms.DialogResult]::Abort })
  $timer.Start()

  $selection = $form.ShowDialog()
  if ($selection -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($password.Text)
    if ($bytes.Length -eq 0 -or $bytes.Length -gt ${MAX_CREDENTIAL_BYTES}) { exit 4 }
    $output = [Console]::OpenStandardOutput()
    $output.Write($bytes, 0, $bytes.Length)
    $output.Flush()
    $exitCode = 0
  } elseif ($selection -eq [System.Windows.Forms.DialogResult]::Abort) {
    $exitCode = 3
  } else {
    $exitCode = 2
  }
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($null -ne $password) { $password.Clear() }
  if ($null -ne $timer) { $timer.Dispose() }
  if ($null -ne $form) { $form.Dispose() }
}
exit $exitCode
`;
}

function macPromptScript(label: string): string {
  return `try
    set answer to display dialog "${label}を入力してください。" with title "${DIALOG_TITLE}" default answer "" with hidden answer giving up after ${NATIVE_PROMPT_TIMEOUT_MS / 1_000}
    if gave up of answer then return "TIMEOUT"
    return "OK:" & text returned of answer
on error number -128
    return "CANCEL"
end try`;
}

function trustedSystemExecutable(path: string): boolean {
  const file = statSync(path, { throwIfNoEntry: false });
  return file?.isFile() === true && file.uid === 0 && (file.mode & 0o111) !== 0 && (file.mode & 0o022) === 0;
}

function linuxRuntimeDirectory(source: NodeJS.ProcessEnv, uid: number): string | undefined {
  const directory = source.XDG_RUNTIME_DIR;
  if (!directory || !/^\/[A-Za-z0-9_./-]+$/u.test(directory) || posix.normalize(directory) !== directory) return undefined;
  const observed = lstatSync(directory, { throwIfNoEntry: false });
  if (observed?.isDirectory() && observed.uid === uid && (observed.mode & 0o077) === 0) return directory;
  return undefined;
}

function linuxSessionBus(source: NodeJS.ProcessEnv, uid: number): string | undefined {
  const address = source.DBUS_SESSION_BUS_ADDRESS;
  const socketPath = address && /^unix:path=(\/[A-Za-z0-9_./-]+)(?:,guid=[0-9a-f]{32})?$/u.exec(address)?.[1];
  if (!socketPath || posix.normalize(socketPath) !== socketPath) return undefined;
  const socket = lstatSync(socketPath, { throwIfNoEntry: false });
  return socket?.isSocket() && socket.uid === uid ? address : undefined;
}

function currentUnixUser(source: NodeJS.ProcessEnv): number | undefined {
  const uid = process.geteuid?.();
  if (uid === undefined || uid === 0 || process.getuid?.() !== uid ||
      source.SSH_CONNECTION || source.SSH_CLIENT || source.SSH_TTY) return undefined;
  return uid;
}

/** Verifies the socket used by local Linux credential registration before contacting Secret Service. */
export function nativeLinuxCredentialSessionBus(source: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== "linux") return undefined;
  const uid = currentUnixUser(source);
  if (uid === undefined) return undefined;
  try { return linuxSessionBus(source, uid); }
  catch { return undefined; }
}

function linuxPrompt(label: string, uid: number, source: NodeJS.ProcessEnv): NativePrompt | undefined {
  const runtime = linuxRuntimeDirectory(source, uid);
  const bus = linuxSessionBus(source, uid);
  if (!bus) return undefined;
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DBUS_SESSION_BUS_ADDRESS: bus };
  const wayland = source.WAYLAND_DISPLAY;
  const display = /^:(\d{1,6})(?:\.\d{1,3})?$/u.exec(source.DISPLAY ?? "");
  if (runtime && wayland) {
    const socketName = posix.isAbsolute(wayland) ? posix.relative(runtime, wayland) : wayland;
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(socketName)) {
      const socket = lstatSync(posix.join(runtime, socketName), { throwIfNoEntry: false });
      if (socket?.isSocket() && socket.uid === uid) env.WAYLAND_DISPLAY = socketName;
    }
  }
  if (runtime) env.XDG_RUNTIME_DIR = runtime;
  if (display) {
    const socket = lstatSync(`/tmp/.X11-unix/X${display[1]}`, { throwIfNoEntry: false });
    if (socket?.isSocket() && (socket.uid === uid || socket.uid === 0)) {
      const xauthority = source.XAUTHORITY;
      const cookie = xauthority && posix.isAbsolute(xauthority) ? lstatSync(xauthority, { throwIfNoEntry: false }) : undefined;
      if (!xauthority || (cookie?.isFile() && cookie.uid === uid && (cookie.mode & 0o022) === 0)) {
        env.DISPLAY = display[0];
        if (xauthority) env.XAUTHORITY = xauthority;
      }
    }
  }
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return undefined;

  const text = `${label}を入力してください。`;
  if (trustedSystemExecutable("/usr/bin/zenity")) {
    env.GDK_BACKEND = env.WAYLAND_DISPLAY ? (env.DISPLAY ? "wayland,x11" : "wayland") : "x11";
    return { kind: "zenity", command: "/usr/bin/zenity", env, args: ["--entry", "--hide-text", `--title=${DIALOG_TITLE}`,
      `--text=${text}`, `--timeout=${NATIVE_PROMPT_TIMEOUT_MS / 1_000}`] };
  }
  if (trustedSystemExecutable("/usr/bin/kdialog")) {
    env.QT_QPA_PLATFORM = env.WAYLAND_DISPLAY ? (env.DISPLAY ? "wayland;xcb" : "wayland") : "xcb";
    return { kind: "kdialog", command: "/usr/bin/kdialog", env, args: ["--title", DIALOG_TITLE, "--password", text] };
  }
  return undefined;
}

function resolveNativePrompt(label: string, source: NodeJS.ProcessEnv): NativePrompt | undefined {
  if (process.platform === "win32") {
    const env = windowsSystemChildEnvironment(source);
    const command = windowsSystemPowerShellCommand(env);
    if (!command) return undefined;
    const script = Buffer.from(promptScript(label), "utf16le").toString("base64");
    return { kind: "windows", command, env, args: ["-NoProfile", "-NoLogo", "-NonInteractive", "-STA", "-EncodedCommand", script] };
  }
  const uid = currentUnixUser(source);
  if (uid === undefined) return undefined;
  if (process.platform === "linux") return linuxPrompt(label, uid, source);
  if (process.platform === "darwin") {
    const console = statSync("/dev/console", { throwIfNoEntry: false });
    if (!console?.isCharacterDevice() || console.uid !== uid || !trustedSystemExecutable("/usr/bin/osascript")) return undefined;
    return { kind: "macos", command: "/usr/bin/osascript", args: ["-e", macPromptScript(label)],
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } };
  }
  return undefined;
}

/** Whether the current Gateway has a supported path to local desktop input, without opening a dialog. */
export function nativeLlmCredentialPromptAvailable(source: NodeJS.ProcessEnv = process.env): boolean {
  try { return resolveNativePrompt("BLUE-TANUKI", source) !== undefined; }
  catch { return false; }
}

/** The caller owns the successful buffer and clears it after the approved storage attempt. */
export async function promptForLlmCredential(
  provider: SettingsWriteActivation["provider"],
  signal: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  if (signal.aborted) return null;
  if (!Object.hasOwn(PROVIDER_LABELS, provider)) throw new Error("llm_credential_prompt_invalid");
  return promptForNativeCredential(`${PROVIDER_LABELS[provider]} の API キー`, "llm_credential_prompt", signal, source);
}

export async function promptForGoogleReadCredential(
  scope: SettingsWriteGoogleReadCredentialScope,
  signal: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  if (signal.aborted) return null;
  if (!Object.hasOwn(GOOGLE_READ_LABELS, scope)) throw new Error("google_read_credential_prompt_invalid");
  return promptForNativeCredential(GOOGLE_READ_LABELS[scope], "google_read_credential_prompt", signal, source);
}

export function promptForGitHubWriteCredential(
  signal: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  return promptForNativeCredential("GitHub 書き込み用アクセストークン", "github_write_credential_prompt", signal, source);
}

export function promptForTelegramBotCredential(
  signal: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  return promptForNativeCredential("Telegram Bot トークン", "telegram_bot_credential_prompt", signal, source);
}

async function promptForNativeCredential(label: string, errorPrefix: string, signal: AbortSignal,
  source: NodeJS.ProcessEnv): Promise<Buffer | null> {
  if (signal.aborted) return null;
  if (!["win32", "linux", "darwin"].includes(process.platform)) throw new Error(`${errorPrefix}_unsupported`);
  let prompt: NativePrompt | undefined;
  try { prompt = resolveNativePrompt(label, source); }
  catch { throw new Error(`${errorPrefix}_unavailable`); }
  if (!prompt) throw new Error(`${errorPrefix}_unavailable`);
  const { kind, command, args, env } = prompt;
  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error(`${errorPrefix}_unavailable`);
  }

  return new Promise((resolve, reject) => {
    const framingBytes = kind === "windows" ? 0 : kind === "macos" ? MAC_SUCCESS.length + 1 : 1;
    const received = Buffer.alloc(MAX_CREDENTIAL_BYTES + framingBytes);
    let length = 0;
    let complete = false;

    const finish = (result: Buffer | null | Error, stop: boolean): void => {
      if (complete) return;
      complete = true;
      received.fill(0);
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (stop) {
        try { kind === "windows" ? child.kill() : child.kill("SIGKILL"); } catch { /* Child may already have exited. */ }
      }
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () => finish(null, true);
    const unavailable = () => finish(new Error(`${errorPrefix}_unavailable`), true);
    const timeout = setTimeout(() => finish(new Error(`${errorPrefix}_timeout`), true),
      kind === "kdialog" ? NATIVE_PROMPT_TIMEOUT_MS : CHILD_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (complete) {
        chunk.fill(0);
        return;
      }
      if (chunk.length > received.length - length) {
        chunk.fill(0);
        finish(new Error(`${errorPrefix}_invalid`), true);
        return;
      }
      chunk.copy(received, length);
      length += chunk.length;
      chunk.fill(0);
    });
    child.stdout.on("error", unavailable);
    child.on("error", unavailable);
    child.once("close", (code) => {
      if (complete) return;
      if (signal.aborted) return finish(null, false);
      if (kind === "windows") {
        if (code === 2 && length === 0) return finish(null, false);
        if (code === 3 && length === 0) return finish(new Error(`${errorPrefix}_timeout`), false);
        if (code === 4) return finish(new Error(`${errorPrefix}_invalid`), false);
      } else if (kind === "zenity" || kind === "kdialog") {
        if (code === 1 && length === 0) return finish(null, false);
        if (kind === "zenity" && code === 5 && length === 0) return finish(new Error(`${errorPrefix}_timeout`), false);
      }
      if (code !== 0) return finish(new Error(`${errorPrefix}_unavailable`), false);

      let value = received.subarray(0, length);
      if (kind !== "windows") {
        if (value.at(-1) !== 0x0a) return finish(new Error(`${errorPrefix}_invalid`), false);
        value = value.subarray(0, -1);
        if (kind === "macos") {
          if (value.equals(MAC_CANCEL)) return finish(null, false);
          if (value.equals(MAC_TIMEOUT)) return finish(new Error(`${errorPrefix}_timeout`), false);
          if (!value.subarray(0, MAC_SUCCESS.length).equals(MAC_SUCCESS)) {
            return finish(new Error(`${errorPrefix}_invalid`), false);
          }
          value = value.subarray(MAC_SUCCESS.length);
        }
      }
      if (value.length === 0 || value.some((byte) => byte < 0x21 || byte > 0x7e)) {
        return finish(new Error(`${errorPrefix}_invalid`), false);
      }
      finish(Buffer.from(value), false);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
