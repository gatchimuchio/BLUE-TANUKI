import type { ExecuteCommand, ExecuteFeedback } from "@blue-tanuki/protocol";
import { HDSUpperController, type OutputTargetSurface } from "@blue-tanuki/hds-brain";
import { renderCommandOutput } from "./result_render.js";

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
}): FinalizedCommandOutput {
  const reviewed_feedback = input.hds.reviewMemoryCitations(input.command, input.feedback);
  const rendered_output = renderCommandOutput(input.command, reviewed_feedback);
  input.hds.onFeedback(input.feedback);
  const output_audit = input.hds.onOutputAudit({
    command: input.command,
    feedback: input.feedback,
    rendered_output,
    target_surface: input.target_surface,
    request_id: input.request_id,
  });
  return { reviewed_feedback, rendered_output, output_audit };
}
