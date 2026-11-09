import * as path from "node:path";
import {
  CompleteHistoryStore,
  FailureMemoryStore,
  runPeriodicFailureMemoryVerification,
  type PeriodicVerificationReport,
  type PeriodicVerificationTrigger,
} from "@blue-tanuki/hds-brain";
import { resolveFailureMemoryFilePath } from "./failure_memory_paths.js";

export interface FailureMemoryVerifyOptions {
  env?: NodeJS.ProcessEnv;
  trigger?: PeriodicVerificationTrigger;
}

export function runFailureMemoryVerify(opts: FailureMemoryVerifyOptions = {}): PeriodicVerificationReport {
  const env = opts.env ?? process.env;
  const history = env.BLUE_TANUKI_COMPLETE_HISTORY_FILE
    ? new CompleteHistoryStore({ filepath: path.resolve(env.BLUE_TANUKI_COMPLETE_HISTORY_FILE) })
    : new CompleteHistoryStore();
  const memory = failureMemoryStoreFromEnv(env);
  return runPeriodicFailureMemoryVerification({
    entries: history.all(),
    existing_rules: memory.list(),
    trigger: opts.trigger ?? "manual",
  });
}

export function formatFailureMemoryVerifyJson(report: PeriodicVerificationReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatFailureMemoryVerifyText(report: PeriodicVerificationReport): string {
  const status = report.unresolved_risks.length > 0 || report.requires_human_review.length > 0 ? "WARN" : "OK";
  return [
    `blue-tanuki failure-memory-verify - ${status} (${report.completed_at})`,
    `  scanned: ${report.scanned_log_range.from}..${report.scanned_log_range.to}`,
    `  detected_failures: ${report.detected_failures.length}`,
    `  repeated_failures: ${report.repeated_failures.length}`,
    `  recommended_rules: ${report.recommended_rules.length}`,
    `  stale_rules: ${report.stale_rules.length}`,
    `  requires_human_review: ${report.requires_human_review.length}`,
    report.unresolved_risks.length > 0 ? `  unresolved_risks: ${report.unresolved_risks.join("; ")}` : null,
    report.notes ? `  notes: ${report.notes}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function failureMemoryStoreFromEnv(env: NodeJS.ProcessEnv): FailureMemoryStore {
  const filepath = resolveFailureMemoryFilePath(env);
  return filepath ? new FailureMemoryStore({ filepath }) : new FailureMemoryStore();
}
