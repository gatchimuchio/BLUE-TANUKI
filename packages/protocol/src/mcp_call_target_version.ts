import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const McpRequestKindSchema = z.enum(["tool_call", "resource_read", "prompt_get"]);
export type McpRequestKind = z.infer<typeof McpRequestKindSchema>;

/** Plan-bound observation of one loopback MCP server and its exact tool schema. */
export const McpCallTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.mcp-call-target-version.v1"),
  connection_digest: DigestSchema,
  catalog_digest: DigestSchema,
  /** Missing is accepted only for previously persisted tool-call plans. */
  request_kind: McpRequestKindSchema.optional(),
  tool_name: z.string().min(1).max(200),
  input_schema_sha256: DigestSchema,
  resource_uri_sha256: DigestSchema.optional(),
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("available"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict().superRefine((observation, context) => {
  const requestKind = observation.request_kind ?? "tool_call";
  if (requestKind === "resource_read") {
    if (!observation.resource_uri_sha256 || observation.tool_name !== `resource:${observation.resource_uri_sha256}`) {
      context.addIssue({ code: "custom", message: "mcp_resource_target_binding_invalid" });
    }
  } else if (observation.resource_uri_sha256 !== undefined) {
    context.addIssue({ code: "custom", message: "mcp_resource_target_binding_invalid" });
  }
});

export type McpCallTargetVersionObservation =
  z.infer<typeof McpCallTargetVersionObservationSchema>;
