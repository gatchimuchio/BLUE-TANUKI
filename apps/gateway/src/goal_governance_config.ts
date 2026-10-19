import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseGoalGovernanceAtBoundary, type GoalGovernanceConfig } from "@blue-tanuki/protocol";

const GOAL_GOVERNANCE_FILENAME = "goal-governance.json";
const MAX_GOAL_GOVERNANCE_BYTES = 1024 * 1024;

/**
 * Load the optional, non-authority GoalGovernance projection source from private
 * state. The file contains bounded references and digests only; raw purpose text
 * and approval payloads are rejected by the Protocol boundary.
 */
export function goalGovernanceConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoalGovernanceConfig | undefined {
  const stateRoot = resolve(env.BLUE_TANUKI_STATE_ROOT ?? ".blue-tanuki");
  const candidatePath = join(stateRoot, "private-state", GOAL_GOVERNANCE_FILENAME);
  if (!existsSync(candidatePath)) return undefined;

  const stateRootPath = realpathSync(stateRoot);
  const privateRootPath = join(stateRootPath, "private-state");
  if (lstatSync(privateRootPath).isSymbolicLink()) {
    throw new Error("goal_governance_private_state_directory_must_not_be_symlink");
  }
  const privateRoot = realpathSync(privateRootPath);
  if (!isWithin(stateRootPath, privateRoot)) {
    throw new Error("goal_governance_private_state_path_invalid");
  }

  const candidate = lstatSync(candidatePath);
  if (candidate.isSymbolicLink() || !candidate.isFile()) {
    throw new Error("goal_governance_config_must_be_regular_file");
  }
  if (candidate.size > MAX_GOAL_GOVERNANCE_BYTES) {
    throw new Error("goal_governance_config_too_large");
  }
  const configPath = realpathSync(candidatePath);
  if (!isWithin(privateRoot, configPath)) {
    throw new Error("goal_governance_config_path_invalid");
  }
  if (process.platform !== "win32") chmodSync(configPath, 0o600);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("goal_governance_config_invalid_json");
  }
  const parsed = parseGoalGovernanceAtBoundary(raw);
  if (!parsed.ok) throw new Error("goal_governance_config_invalid");
  return parsed.config;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
