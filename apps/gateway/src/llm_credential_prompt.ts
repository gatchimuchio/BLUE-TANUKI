import { spawn, type ChildProcessByStdio } from "node:child_process";
import { win32 } from "node:path";
import type { Readable } from "node:stream";
import { SETTINGS_WRITE_NATIVE_CREDENTIAL_ENTRY_WINDOW_MS, type SettingsWriteActivation } from "@blue-tanuki/protocol";
import { windowsSystemChildEnvironment } from "./child_process_environment.js";

const PROVIDER_LABELS: Record<SettingsWriteActivation["provider"], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};
const NATIVE_PROMPT_TIMEOUT_MS = SETTINGS_WRITE_NATIVE_CREDENTIAL_ENTRY_WINDOW_MS;
const CHILD_TIMEOUT_MS = NATIVE_PROMPT_TIMEOUT_MS + 5_000;
const MAX_CREDENTIAL_BYTES = 4_096;

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
  $form.Text = 'BLUE-TANUKI - 資格情報の入力'
  $form.ClientSize = New-Object System.Drawing.Size(460, 138)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true

  $description = New-Object System.Windows.Forms.Label
  $description.SetBounds(16, 14, 428, 42)
  $description.Text = '${label} の API キーを入力してください。'
  $password = New-Object System.Windows.Forms.TextBox
  $password.SetBounds(16, 56, 428, 22)
  $password.UseSystemPasswordChar = $true
  $password.MaxLength = ${MAX_CREDENTIAL_BYTES}
  $password.AccessibleName = '${label} API キー'
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

/** The caller owns the successful buffer and clears it after the approved storage attempt. */
export async function promptForLlmCredential(
  provider: SettingsWriteActivation["provider"],
  signal: AbortSignal,
): Promise<Buffer | null> {
  if (signal.aborted) return null;
  if (process.platform !== "win32") throw new Error("llm_credential_prompt_unsupported");
  if (!Object.hasOwn(PROVIDER_LABELS, provider)) throw new Error("llm_credential_prompt_invalid");
  const env = windowsSystemChildEnvironment();
  const windowsDirectory = env.SystemRoot;
  if (!windowsDirectory || !/^[a-z]:\\/iu.test(windowsDirectory)) {
    throw new Error("llm_credential_prompt_unavailable");
  }
  const command = win32.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedScript = Buffer.from(promptScript(PROVIDER_LABELS[provider]), "utf16le").toString("base64");
  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn(command, ["-NoProfile", "-NoLogo", "-NonInteractive", "-STA", "-EncodedCommand", encodedScript], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error("llm_credential_prompt_unavailable");
  }

  return new Promise((resolve, reject) => {
    const received = Buffer.alloc(MAX_CREDENTIAL_BYTES);
    let length = 0;
    let complete = false;

    const finish = (result: Buffer | null | Error, stop: boolean): void => {
      if (complete) return;
      complete = true;
      received.fill(0);
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (stop) {
        try { child.kill(); } catch { /* Its own prompt timer also stops the child. */ }
      }
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () => finish(null, true);
    const unavailable = () => finish(new Error("llm_credential_prompt_unavailable"), true);
    const timeout = setTimeout(() => finish(new Error("llm_credential_prompt_timeout"), true), CHILD_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (complete) {
        chunk.fill(0);
        return;
      }
      if (chunk.length > received.length - length) {
        chunk.fill(0);
        finish(new Error("llm_credential_prompt_invalid"), true);
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
      if (code === 2 && length === 0) return finish(null, false);
      if (code === 3 && length === 0) return finish(new Error("llm_credential_prompt_timeout"), false);
      if (code === 4) return finish(new Error("llm_credential_prompt_invalid"), false);
      if (code !== 0) return finish(new Error("llm_credential_prompt_unavailable"), false);

      const value = received.subarray(0, length);
      if (value.length === 0 || value.some((byte) => byte < 0x21 || byte > 0x7e)) {
        return finish(new Error("llm_credential_prompt_invalid"), false);
      }
      finish(Buffer.from(value), false);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
