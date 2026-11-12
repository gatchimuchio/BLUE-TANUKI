import * as path from "node:path";

const ENV_NAME = "BLUE_TANUKI_WINDOWS_ARTIFACT_DIR";

function isOneDrivePath(value: string): boolean {
  return path.resolve(value).split(path.sep).some((segment) => /^OneDrive(?:\s+-\s+.*)?$/iu.test(segment));
}

export function windowsArtifactDir(repositoryRoot: string): string {
  const configured = process.env[ENV_NAME];
  if (configured?.trim()) {
    const resolved = path.resolve(configured);
    if (isOneDrivePath(resolved)) {
      throw new Error(`${ENV_NAME} must point to a local, non-OneDrive directory`);
    }
    return resolved;
  }

  const defaultDir = path.resolve(repositoryRoot, "release", "windows");
  if (isOneDrivePath(defaultDir)) {
    throw new Error(
      `${ENV_NAME} must be set to a local, non-OneDrive directory before building Windows artifacts from a OneDrive checkout`,
    );
  }
  return defaultDir;
}
