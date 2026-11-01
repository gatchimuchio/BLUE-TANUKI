import { createHash } from "node:crypto";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Operation Plan-bound, non-authority preflight evidence for one Google Drive file.create. */
export const GoogleDriveWriteTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.google-drive-write-target-version.v1"),
  operation: z.literal("file.create"),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  parent_folder_id: z.string().min(1).max(512),
  parent_folder_state_digest: DigestSchema,
  parent_access_scope_digest: DigestSchema,
  parent_access_scope_complete: z.literal(true),
  parent_access_scope_entry_count: z.number().int().min(1).max(500),
  target_name_absent: z.literal(true),
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type GoogleDriveWriteTargetVersionObservation =
  z.infer<typeof GoogleDriveWriteTargetVersionObservationSchema>;

/** Operation Plan-bound, non-authority preflight evidence for replacing one text/plain blob file. */
export const GoogleDriveUpdateTargetVersionObservationSchema = z.object({
  schema_version: z.literal("blue-tanuki.google-drive-update-target-version.v1"),
  operation: z.literal("file.update"),
  target_identity_digest: DigestSchema,
  request_payload_digest: DigestSchema,
  file_id: z.string().min(1).max(512),
  file_state_digest: DigestSchema,
  current_content_digest: DigestSchema,
  current_content_bytes: z.number().int().min(0).max(512_000),
  target_mime_type: z.literal("text/plain"),
  target_access_scope_digest: DigestSchema,
  target_access_scope_complete: z.literal(true),
  target_access_scope_entry_count: z.number().int().min(1).max(500),
  command_digest: DigestSchema,
  operation_plan_binding_digest: DigestSchema,
  used_for_authority: z.literal(false),
  may_execute: z.literal(false),
}).strict();

export type GoogleDriveUpdateTargetVersionObservation =
  z.infer<typeof GoogleDriveUpdateTargetVersionObservationSchema>;

export function googleDriveWriteTargetIdentityDigest(parentFolderId: string, name: string): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.google-drive-file-create-target.v1",
    parentFolderId,
    name,
  ]), "utf8").digest("hex");
}

export function googleDriveWriteRequestPayloadDigest(input: {
  parent_id: string;
  name: string;
  mime_type: string;
  content: string;
  max_bytes: number;
  max_content_bytes: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.google-drive-file-create-payload.v1",
    input.parent_id,
    input.name,
    input.mime_type,
    createHash("sha256").update(input.content, "utf8").digest("hex"),
    input.max_bytes,
    input.max_content_bytes,
  ]), "utf8").digest("hex");
}

export function googleDriveUpdateTargetIdentityDigest(fileId: string): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.google-drive-file-update-target.v1",
    fileId,
  ]), "utf8").digest("hex");
}

export function googleDriveUpdateRequestPayloadDigest(input: {
  file_id: string;
  mime_type: string;
  content: string;
  max_bytes: number;
  max_content_bytes: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "blue-tanuki.google-drive-file-update-payload.v1",
    input.file_id,
    input.mime_type,
    createHash("sha256").update(input.content, "utf8").digest("hex"),
    input.max_bytes,
    input.max_content_bytes,
  ]), "utf8").digest("hex");
}
