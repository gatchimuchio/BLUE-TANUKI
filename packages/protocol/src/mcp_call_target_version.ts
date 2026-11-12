import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Plan-bound observation of one loopback MCP server and its exact tool schema. */
export const McpCallTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.mcp-call-target-version.v1"),
  connection_digest: DigestSchema,
  catalog_digest: DigestSchema,
  tool_name: z.string().min(1).max(200),
  input_schema_sha256: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("available"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type McpCallTargetVersionObservation =
  z.infer<typeof McpCallTargetVersionObservationSchema>;
