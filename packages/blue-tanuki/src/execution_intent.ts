import type { ExecutionResultDelivery } from "@blue-tanuki/protocol";
/** Executor所有の消費・開始意思。Jの採否や環境Permissionを代替しない。 */
export interface ExecutionIntentTicket {
  ticket_id: string;
  command_key: string;
  command_digest: string;
  proof_digest: string;
  execution_epoch: string;
  issued_at_ms: number;
  expires_at_ms: number;
}

export type ExecutionInvocationBoundary = "tool_adapter" | "channel_adapter" | "llm_adapter" | "console_preview";
export type ExecutionReceiptState = "issued" | "intent_committed" | "invocation_attempted" |
  "adapter_returned" | "not_attempted" | "outcome_unknown";

/** 親が専用IPCと実child.pidへ結合して観測する。PIDだけでは同一性にならない。 */
export interface ExecutionWorkerIdentity {
  worker_id: string;
  worker_pid: number;
  worker_platform: string;
  worker_started_at_ms: number;
}

export interface ExecutionIntentReceipt extends ExecutionIntentTicket {
  state: ExecutionReceiptState;
  invocation_boundary?: ExecutionInvocationBoundary;
  feedback_status?: "success" | "failed" | "suspended";
  output_digest?: string;
  error_digest?: string;
  consumed_at_ms?: number;
  observed_at_ms?: number;
  worker_id?: string;
  worker_pid?: number;
  worker_platform?: string;
  worker_started_at_ms?: number;
  worker_exit_observed_at_ms?: number;
  used_for_authority: false;
  result_delivery_digest?: string;
  result_delivery_acknowledged?: boolean;
}

/** 同期port。consumeの保存失敗では下流を起動せず、消費を復活させない。 */
export interface ExecutionIntentStore {
  issue(ticket: Readonly<ExecutionIntentTicket>): void;
  consume(ticket: Readonly<ExecutionIntentTicket>, now_ms: number): void;
  markInvocation(ticket: Readonly<ExecutionIntentTicket>, boundary: ExecutionInvocationBoundary, now_ms: number): void;
  bindWorker?(ticket: Readonly<ExecutionIntentTicket>, worker: Readonly<ExecutionWorkerIdentity>, now_ms: number): void;
  observeWorkerExit?(ticket: Readonly<ExecutionIntentTicket>, worker: Readonly<ExecutionWorkerIdentity>, now_ms: number): void;
  complete(ticket: Readonly<ExecutionIntentTicket>, result: Pick<ExecutionIntentReceipt,
    "state" | "feedback_status" | "output_digest" | "error_digest" | "observed_at_ms">,
    delivery?: ExecutionResultDelivery): void;
  lookup(ticket_id: string): ExecutionIntentReceipt | null;
}

export interface ExecutorApprovalClock {
  wallNow(): number;
  monotonicNow(): number;
}

export interface ExecutorApprovalOptions {
  /** Gatewayでは私有SQLiteを必須注入する。省略時はprocess内の開発用経路。 */
  execution_store?: ExecutionIntentStore;
  /** Gateway起動時に永続化したowner世代。省略時はprocess内のUUIDを発行する。 */
  execution_epoch?: string;
  /** Persisted intentを書き込むGateway所有権を、発行・作用境界・結果保存で同期確認する。 */
  assert_execution_owner?: () => void;
  clock?: ExecutorApprovalClock;
  /** 発行から実adapter呼出しまでの上限。実行中timeoutとは別。 */
  ticket_ttl_ms?: number;
}
