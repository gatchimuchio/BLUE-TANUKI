import type { Tool } from "@blue-tanuki/core";
import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { CronSchedulerChannel } from "./cron_channel.js";
import type { GatewayCronEventStore } from "./cron_event_store.js";

const DIGEST = /^[a-f0-9]{64}$/;

/**
 * A bounded request for HDS to record an owner-approved no-replay disposition.
 * This adapter is read-only: the HDS audit record owns the disposition, and
 * the Cron cursor consults that verified record before advancing.
 */
export function createCronEventResolutionTool(
  eventStore: GatewayCronEventStore,
  scheduler: Pick<CronSchedulerChannel, "isEventInFlight">,
): Tool {
  return {
    name: "schedule.resolve_event",
    description: "Request an HDS L3 no-replay disposition for one exact unsettled Cron event.",
    required_capabilities: requireToolOperationDescriptor("schedule.resolve_event").required_capabilities,
    async invoke(args, ctx) {
      const event_id = args.event_id;
      const payload_digest = args.payload_digest;
      if (Object.keys(args).length !== 3 || args.disposition !== "acknowledge_no_replay" ||
          typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
          typeof payload_digest !== "string" || !DIGEST.test(payload_digest) ||
          typeof ctx.command_id !== "string" || ctx.command_id.trim().length === 0) {
        throw new Error("schedule.resolve_event requires exact event_id, payload_digest, and acknowledge_no_replay disposition");
      }
      const current = eventStore.unresolvedEvent(event_id, payload_digest);
      if (!current) throw new Error("schedule.resolve_event rejected: event identity is stale or not unresolved");
      if (current.resolution_state !== "unacknowledged") {
        throw new Error("schedule.resolve_event rejected: existing disposition is present or cannot be verified");
      }
      if (scheduler.isEventInFlight(event_id)) {
        throw new Error("schedule.resolve_event rejected: the Cron event is still in flight");
      }
      return {
        status: "validated_for_hds_disposition",
        event_id,
        payload_digest,
        original_delivery_state: current.delivery_state,
        disposition: "acknowledge_no_replay",
        external_outcome: "unknown",
      };
    },
  };
}
