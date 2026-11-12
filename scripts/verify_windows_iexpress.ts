import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { windowsArtifactDir } from "./windows_artifact_dir.js";
import { verifyAndExtractWindowsIExpressCommand } from "./windows_iexpress.js";

interface PackageJson { version?: string }

function main(): void {
  if (process.platform !== "win32") throw new Error("The Windows .exe installer verifier must run on Windows");

  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
  const version = pkg.version;
  if (!version || !/^[0-9A-Za-z.+-]+$/u.test(version)) throw new Error("package.json version is missing or invalid");
  const releaseDir = windowsArtifactDir(root);
  const installer = path.join(releaseDir, `BlueTanukiSetup-${version}-windows-x64.exe`);
  const payload = path.join(releaseDir, `blue-tanuki-${version}-windows-x64-installer.zip`);

  for (const filepath of [installer, `${installer}.sha256`, `${installer}.manifest.json`, payload, `${payload}.sha256`]) {
    if (!existsSync(filepath)) throw new Error(`required Windows .exe verification input is missing: ${filepath}`);
  }

  const verifyRoot = mkdtempSync(path.join(tmpdir(), "blue-tanuki-iexpress-verify-"));
  let stageRetained = true;
  try {
    const verified = verifyAndExtractWindowsIExpressCommand(
      installer,
      payload,
      path.join(verifyRoot, "extracted"),
      version,
    );
    console.log(`windows_product_installer_verified=${installer}`);
    console.log(`installer_sha256=${verified.installerSha256}`);
    console.log(`payload_sha256=${verified.payloadSha256}`);
    console.log(`bootstrapper_sha256=${verified.bootstrapperSha256}`);
    console.log("single_file_extraction=PASS");
    console.log("setup_execution=NOT_RUN");
    console.log("signature=unsigned");
    console.log("public_distribution=HOLD_owner_GO_and_signing_required");
    rmSync(verifyRoot, { recursive: true, force: true });
    stageRetained = false;
  } catch (error) {
    console.error(`IExpress verifier staging retained for diagnosis: ${verifyRoot}`);
    throw error;
  } finally {
    if (!stageRetained && existsSync(verifyRoot)) rmSync(verifyRoot, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (invoked) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
