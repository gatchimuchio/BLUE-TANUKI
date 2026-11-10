import { describe, expect, it } from "vitest";
import { macOsHostIdentityChildEnvironment, windowsSystemChildEnvironment } from "../src/child_process_environment.js";

describe("Gateway child-process environments", () => {
  it("keeps Windows OS helpers on a fixed allowlist", () => {
    const environment = windowsSystemChildEnvironment({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      OPENAI_API_KEY: "never-copy-this",
      OPENAI_API_KEY_REF: "never-copy-this-reference",
      TELEGRAM_BOT_TOKEN: "never-copy-this-either",
      BLUE_TANUKI_POWERSHELL: "C:\\tools\\powershell.exe",
      NODE_OPTIONS: "--require unexpected.js",
    });

    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    });
  });

  it("gives macOS identity queries a fixed non-owner environment", () => {
    expect(macOsHostIdentityChildEnvironment()).toEqual({ PATH: "/usr/bin:/bin", LANG: "C" });
  });
});
