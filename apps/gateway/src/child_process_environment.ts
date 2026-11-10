/**
 * Explicit environment allowlists for Gateway-owned OS helper processes.
 * Resolved provider credentials must never be inherited from process.env.
 */
export function windowsSystemChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const systemRoot = envValue(source, "SystemRoot", "SYSTEMROOT", "WINDIR") ?? "C:\\Windows";
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: `${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const systemDrive = envValue(source, "SystemDrive");
  const temp = envValue(source, "TEMP");
  const tmp = envValue(source, "TMP");
  if (systemDrive) environment.SystemDrive = systemDrive;
  if (temp) environment.TEMP = temp;
  if (tmp) environment.TMP = tmp;
  return environment;
}

/** ioreg is invoked by absolute path and needs no inherited owner environment. */
export function macOsHostIdentityChildEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", LANG: "C" };
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(env).find(([name]) => expected.has(name.toLowerCase()))?.[1];
}
