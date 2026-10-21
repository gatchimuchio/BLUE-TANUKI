import { createGatewayInternalInboundRequest, type OperationPlanWaitState, type InboundRequest } from "@blue-tanuki/protocol";

const MAX_RECHECK_DELAY_MS = 60_000;

/** Wall-clock deadlines wake J once; this timer never calls C while a wait remains pending. */
export class OperationPlanWaitDeadlineScheduler {
  private started = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly attempted = new Set<string>();

  constructor(private readonly options: {
    readonly list_waits: () => readonly OperationPlanWaitState[];
    readonly wait_context: (wait_id: string) => { readonly goal: string; readonly owner: string; readonly channel: string } | null;
    readonly dispatch: (request: InboundRequest) => Promise<void>;
    readonly log?: (message: string, wait_id: string) => void;
    readonly now?: () => number;
  }) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  refresh(): void {
    if (!this.started) return;
    const active = new Map(this.options.list_waits()
      .filter((wait) => wait.state === "waiting")
      .map((wait) => [wait.wait_id, wait] as const));
    for (const [waitId, timer] of this.timers) {
      if (!active.has(waitId)) {
        clearTimeout(timer);
        this.timers.delete(waitId);
        this.attempted.delete(waitId);
      }
    }
    for (const wait of active.values()) {
      if (!this.timers.has(wait.wait_id) && !this.attempted.has(wait.wait_id)) this.arm(wait);
    }
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempted.clear();
  }

  private arm(wait: OperationPlanWaitState): void {
    const remaining = Math.max(0, wait.deadline_at_ms - this.now());
    const delay = Math.min(remaining, MAX_RECHECK_DELAY_MS);
    const timer = setTimeout(() => {
      this.timers.delete(wait.wait_id);
      if (!this.started) return;
      const current = this.options.list_waits().find((candidate) => candidate.wait_id === wait.wait_id &&
        candidate.state === "waiting");
      if (!current) {
        this.attempted.delete(wait.wait_id);
        return;
      }
      if (current.deadline_at_ms !== wait.deadline_at_ms || current.deadline_at_ms > this.now()) {
        this.arm(current);
        return;
      }
      const context = this.options.wait_context(wait.wait_id);
      if (!context) {
        this.options.log?.("operation plan wait deadline has no current J context", wait.wait_id);
        return;
      }
      this.attempted.add(wait.wait_id);
      const request = createGatewayInternalInboundRequest({
        id: `plan-wait-deadline-${wait.wait_id}`,
        channel: context.channel,
        user: context.owner,
        content: "Persistent operation-plan wait deadline event",
        timestamp: this.now(),
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.actor_kind": "system",
          "blue_tanuki.trust_level": "trusted",
          "blue_tanuki.process_kind": "cron",
          "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.operation_plan.wait_deadline_id": wait.wait_id,
        },
      });
      void this.options.dispatch(request).then(() => this.refresh()).catch(() => {
        this.options.log?.("operation plan wait deadline handler failed; retry will occur after restart", wait.wait_id);
      });
    }, delay);
    this.timers.set(wait.wait_id, timer);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
