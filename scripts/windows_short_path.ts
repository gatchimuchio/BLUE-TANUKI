import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

/** Return the filesystem's short alias so legacy IExpress SED paths contain no spaces. */
export function windowsShortPath(inputPath: string): string {
  if (process.platform !== "win32") throw new Error("Windows short paths are available only on Windows");

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(powershell)) throw new Error("Windows PowerShell 5.1 is required to resolve the IExpress staging path");

  const encodedPath = Buffer.from(path.resolve(inputPath), "utf8").toString("base64");
  const script = `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class BlueTanukiShortPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetShortPathName(string path, StringBuilder shortPath, uint bufferLength);
}
'@
$inputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$buffer = New-Object Text.StringBuilder 32768
$length = [BlueTanukiShortPath]::GetShortPathName($inputPath, $buffer, [uint32]$buffer.Capacity)
if ($length -eq 0) { exit 2 }
$buffer.ToString()`;
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not resolve a short Windows path: ${result.stderr || result.error?.message || result.status}`);
  }

  const resolved = result.stdout.trim();
  if (!resolved || /[\s\u0080-\uFFFF]/u.test(resolved)) {
    throw new Error("IExpress requires an ASCII staging path without spaces; Windows short-path resolution did not provide one");
  }
  return resolved;
}
