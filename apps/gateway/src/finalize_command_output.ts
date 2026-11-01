import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";
import { createLogger } from "@blue-tanuki/core";
import { HDSUpperController, type OutputTargetSurface } from "@blue-tanuki/hds-brain";
import { renderCommandOutput } from "./result_render.js";
import type { DevelopmentHandoffStore } from "./development_handoff_store.js";

const developmentHandoffLog = createLogger({ scope: "gateway.development-handoff" });

export interface FinalizedCommandOutput {
  reviewed_feedback: ExecuteFeedback;
  rendered_output: string | null;
  output_audit: ReturnType<HDSUpperController["onOutputAudit"]>;
}

/**
 * Shared gateway release path. HDS reviews citations before feedback closes
 * the in-flight trace; only the reviewed projection is rendered, while the
 * audit retains a digest of the original executor result.
 */
export function finalizeCommandOutput(input: {
  hds: HDSUpperController;
  command: ExecuteCommand;
  feedback: ExecuteFeedback;
  target_surface: OutputTargetSurface;
  request_id: string | null;
  /** Safe fixed projection for commands whose raw result is consumed internally. */
  rendered_output_override?: string;
  development_handoff_store?: DevelopmentHandoffStore;
}): FinalizedCommandOutput {
  const reviewed_feedback = input.hds.reviewMemoryCitations(input.command, input.feedback);
  const rendered_output = input.rendered_output_override ?? renderCommandOutput(input.command, reviewed_feedback);
  deliverDevelopmentHandoff(input.hds.onFeedback(input.feedback), input.development_handoff_store);
  const output_audit = input.hds.onOutputAudit({
    command: input.command,
    feedback: input.feedback,
    rendered_output,
    target_surface: input.target_surface,
    request_id: input.request_id,
  });
  return { reviewed_feedback, rendered_output, output_audit };
}

/** Audit and return a fixed status when a durable Operation Plan result is not ready for release. */
export function finalizeCommandStatusOutput(input: {
  hds: HDSUpperController;
  command: ExecuteCommand;
  feedback: ExecuteFeedback;
  status_message: string;
  target_surface: OutputTargetSurface;
  request_id: string | null;
  development_handoff_store?: DevelopmentHandoffStore;
}): FinalizedCommandOutput {
  const reviewed_feedback = input.hds.reviewMemoryCitations(input.command, input.feedback);
  deliverDevelopmentHandoff(input.hds.onFeedback(input.feedback), input.development_handoff_store);
  const rendered_output = input.status_message;
  const output_audit = input.hds.onOutputAudit({
    command: input.command,
    feedback: input.feedback,
    rendered_output,
    target_surface: input.target_surface,
    request_id: input.request_id,
  });
  return { reviewed_feedback, rendered_output, output_audit };
}

function deliverDevelopmentHandoff(
  handoff: ReturnType<HDSUpperController["onFeedback"]>,
  store?: DevelopmentHandoffStore,
): void {
  if (!handoff) return;
  if (!store) {
    developmentHandoffLog.warn("learning candidate has no development inbox consumer", {
      handoff_id_digest: handoff.handoff_id.slice(0, 16),
    });
    return;
  }
  const result = store.receive(handoff);
  if (result.status === "stored" || result.status === "replayed") {
    developmentHandoffLog.info("learning candidate delivered to development inbox", {
      handoff_id_digest: handoff.handoff_id.slice(0, 16),
      status: result.status,
    });
  } else {
    developmentHandoffLog.warn("learning candidate was not delivered to development inbox", {
      handoff_id_digest: handoff.handoff_id.slice(0, 16),
      status: result.status,
    });
  }
}
