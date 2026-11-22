import { z } from "zod";
import { OperationEffectSchema } from "./operation_core.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Reviewed, non-authoritative mapping from one action/schema version to effects. */
export const ComposioActionEffectRegistryBindingSchema = z.object({
  schema_version: z.literal("blue-tanuki.composio-action-effect-registry-binding.v1"),
  status: z.literal("reviewed"),
  registry_version: z.string().min(1).max(80),
  registry_entry_id: z.string().min(1).max(160),
  registry_entry_sha256: DigestSchema,
  binding_sha256: DigestSchema,
  toolkit: z.string().min(1).max(120),
  tool: z.string().min(1).max(160),
  input_schema_sha256: DigestSchema,
  output_schema_sha256: DigestSchema,
  action_definition_sha256: DigestSchema,
  effects: z.array(OperationEffectSchema).min(1).max(20),
}).strict();

export type ComposioActionEffectRegistryBinding =
  z.infer<typeof ComposioActionEffectRegistryBindingSchema>;

/** Non-authority binding for the current Composio action, account identity, schema and HDS plan. */
export const ComposioActionTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.composio-action-target-version.v1"),
  toolkit: z.string().min(1).max(120),
  tool: z.string().min(1).max(160),
  connected_account_id_sha256: DigestSchema,
  user_id_sha256: DigestSchema,
  account_state_sha256: DigestSchema,
  input_schema_sha256: DigestSchema,
  output_schema_sha256: DigestSchema,
  action_definition_sha256: DigestSchema,
  action_effect_registry: ComposioActionEffectRegistryBindingSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("available"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type ComposioActionTargetVersionObservation =
  z.infer<typeof ComposioActionTargetVersionObservationSchema>;

/** Exact no-store owner review for one live Composio action and its provider schema. */
export const ComposioActionContentReviewSchema = z.object({
  kind: z.literal("composio_execute"),
  operation: z.literal("composio.execute"),
  command_digest: DigestSchema,
  review_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  target_version_digest: DigestSchema,
  target_version_observation: ComposioActionTargetVersionObservationSchema,
  operation_plan_binding_digest: DigestSchema,
  toolkit: z.string().min(1).max(120),
  tool: z.string().min(1).max(160),
  action_name: z.string().min(1).max(240),
  description: z.string().max(2_000),
  version: z.string().max(80).nullable(),
  no_auth: z.boolean().nullable(),
  is_deprecated: z.literal(false),
  scopes: z.array(z.string().max(200)).max(100),
  input_parameters: z.record(z.unknown()),
  output_parameters: z.record(z.unknown()),
  arguments: z.record(z.unknown()),
  input_schema_sha256: DigestSchema,
  output_schema_sha256: DigestSchema,
  action_definition_sha256: DigestSchema,
  action_effect_registry: ComposioActionEffectRegistryBindingSchema,
  connected_account_id: z.string().min(1).max(200),
  connected_account_id_sha256: DigestSchema,
  user_id_sha256: DigestSchema,
  account_type: z.literal("PRIVATE"),
  account_status: z.literal("ACTIVE"),
  account_disabled: z.literal(false),
  auth_scheme: z.string().nullable(),
  provider_region: z.string().nullable(),
  intent: z.enum(["read", "write", "send", "delete", "unknown"]),
  potential_effects: z.array(z.string().min(1).max(100)).max(20),
  no_store: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
  provider_metadata_used_for_authority: z.literal(false),
}).strict();

export type ComposioActionContentReview = z.infer<typeof ComposioActionContentReviewSchema>;

/** Non-authority binding for one connected account revoke request and current owner account state. */
export const ComposioDisconnectTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.composio-disconnect-target-version.v1"),
  toolkit: z.string().min(1).max(120),
  connected_account_id_sha256: DigestSchema,
  user_id_sha256: DigestSchema,
  account_state_sha256: DigestSchema,
  request_payload_digest: DigestSchema,
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  target_state: z.literal("available"),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type ComposioDisconnectTargetVersionObservation =
  z.infer<typeof ComposioDisconnectTargetVersionObservationSchema>;

/** Exact no-store owner review for revoking one active PRIVATE connected account. */
export const ComposioDisconnectContentReviewSchema = z.object({
  kind: z.literal("composio_disconnect"),
  operation: z.literal("composio.disconnect"),
  command_digest: DigestSchema,
  review_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  target_version_digest: DigestSchema,
  target_version_observation: ComposioDisconnectTargetVersionObservationSchema,
  operation_plan_binding_digest: DigestSchema,
  toolkit: z.string().min(1).max(120),
  connected_account_id: z.string().min(1).max(256),
  connected_account_id_sha256: DigestSchema,
  user_id_sha256: DigestSchema,
  account_type: z.literal("PRIVATE"),
  account_status: z.literal("ACTIVE"),
  account_disabled: z.literal(false),
  auth_scheme: z.string().max(80),
  provider_region: z.enum(["us", "eu", "unknown"]).nullable(),
  effect: z.literal("revoke_upstream_tokens_and_mark_account_REVOKED"),
  upstream_revocation: z.literal("best_effort"),
  account_deletion: z.literal(false),
  no_store: z.literal(true),
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
  provider_metadata_used_for_authority: z.literal(false),
}).strict();

export type ComposioDisconnectContentReview = z.infer<typeof ComposioDisconnectContentReviewSchema>;
