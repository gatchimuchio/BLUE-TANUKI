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
    adapter_version: "1.0.0-rc.1",
    description: "Request an HDS L3 no-replay disposition for one exact unsettled Cron event; a missed occurrence may only be skipped, never replayed.",
    required_capabilities: requireToolOperationDescriptor("schedule.resolve_event").required_capabilities,
    async invoke(args, ctx) {
      const event_id = args.event_id;
      const payload_digest = args.payload_digest;
      const disposition = args.disposition;
      if (Object.keys(args).length !== 3 ||
          (disposition !== "acknowledge_no_replay" && disposition !== "skip_missed_occurrence") ||
          typeof event_id !== "string" || !/^cron-[a-f0-9]{64}$/.test(event_id) ||
          typeof payload_digest !== "string" || !DIGEST.test(payload_digest) ||
          typeof ctx.command_id !== "string" || ctx.command_id.trim().length === 0) {
        throw new Error("schedule.resolve_event requires exact event_id, payload_digest, and a disposition valid for the event state");
      }
      const current = eventStore.unresolvedEvent(event_id, payload_digest);
      if (!current) throw new Error("schedule.resolve_event rejected: event identity is stale or not unresolved");
      const missedOccurrence = current.delivery_state === "held_catch_up_policy";
      if (missedOccurrence && disposition !== "skip_missed_occurrence") {
        throw new Error("schedule.resolve_event rejected: a missed occurrence was never dispatched and requires the explicit skip disposition");
      }
      if (!missedOccurrence && disposition !== "acknowledge_no_replay") {
        throw new Error("schedule.resolve_event rejected: skip disposition applies only to an undispatched missed occurrence");
      }
      if (current.resolution_state === "verification_unavailable" ||
          (!missedOccurrence && current.resolution_state !== "unacknowledged")) {
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
        disposition,
        external_outcome: missedOccurrence ? "not_dispatched" : "unknown",
      };
    },
  };
}
