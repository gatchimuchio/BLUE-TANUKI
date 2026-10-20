import { z } from "zod";
import { OperationCommandExecutionResultSchema, OperationJsonValueSchema } from "./operation_core.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.number().int().positive().safe();
/** Executorで発行された同一性を、作用前にJの私有bindingへ結合する。権限ではない。 */
export const ExecutionAdmissionSchema = z.object({
  ticket_id: z.string().uuid(), command_key: Digest, command_digest: Digest, proof_digest: Digest,
  task_identity_digest: Digest.optional(),
  execution_epoch: z.string().uuid(), issued_at_ms: Time, expires_at_ms: Time,
}).strict().refine((v) => v.expires_at_ms > v.issued_at_ms && v.expires_at_ms - v.issued_at_ms <= 600_000);
export type ExecutionAdmission = z.infer<typeof ExecutionAdmissionSchema>;

const SearchOutput = z.object({
  root: z.string().min(1).max(4096), sandbox_root: z.string().min(1).max(4096),
  query: z.string().max(4096), visited_files: z.number().int().min(0).max(1000),
  matches: z.array(z.object({
    path: z.string().min(1).max(4096).refine((s) => !s.startsWith("/") && !s.startsWith("\\") &&
      !/^[a-z]:/i.test(s) && !s.split(/[\\/]/).includes("..")),
    line_number: z.number().int().positive().safe(), line: z.string().max(240),
  }).strict()).max(100),
}).strict();

const DeliveryFeedback = z.object({
  command_id: z.string().min(1).max(200), status: z.enum(["success", "failed", "suspended"]),
  metrics: z.object({ duration_ms: z.number().finite().nonnegative() }).strict(),
  operation_core_result: OperationCommandExecutionResultSchema,
}).strict();

/** file.searchの保存済み実結果だけ。計算候補・記憶更新・raw errorは配送しない。 */
const FileSearchExecutionResultDeliverySchema = z.object({
  profile: z.literal("file-search-result-delivery.v1"), admission: ExecutionAdmissionSchema,
  feedback: DeliveryFeedback.extend({ result: SearchOutput.optional() }),
}).strict();

/** 審査済みtool adapterの最小実行結果。J bindingがexact commandと対応付ける。 */
const ToolAdapterExecutionResultDeliverySchema = z.object({
  profile: z.literal("tool-adapter-result-delivery.v1"), admission: ExecutionAdmissionSchema,
  feedback: DeliveryFeedback.extend({ result: OperationJsonValueSchema.optional() }),
}).strict();

export const ExecutionResultDeliverySchema = z.discriminatedUnion("profile", [
  FileSearchExecutionResultDeliverySchema,
  ToolAdapterExecutionResultDeliverySchema,
]);
export type ExecutionResultDelivery = z.infer<typeof ExecutionResultDeliverySchema>;

/** parseによるキー順変更は既存output_digestを壊すので、検査後も元JSON順を保つ。 */
export function inspectExecutionResultDelivery(value: unknown): ExecutionResultDelivery {
  let nodes = 0;
  const inspect = (v: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 12) throw new Error("execution_delivery_structure_invalid");
    if (v === null || typeof v === "string" || typeof v === "boolean" || v === undefined) return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) throw new Error("execution_delivery_json_invalid");
    for (const [key, child] of Object.entries(v)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("execution_delivery_key_invalid");
      inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).byteLength > 262_144) throw new Error("execution_delivery_capacity_invalid");
  const copy: unknown = JSON.parse(json);
  ExecutionResultDeliverySchema.parse(copy);
  return copy as ExecutionResultDelivery;
}
