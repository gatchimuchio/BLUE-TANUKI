import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired } from "@blue-tanuki/hds-brain";
import { GoogleDrivePublicLinkCreateTargetVersionObservationSchema, type ExecuteCommand } from "@blue-tanuki/protocol";
import {
  assertGoogleDriveWriteTargetVersion,
  inspectGoogleDriveWriteContentReview,
  inspectGoogleDriveWriteTargetVersion,
  invokeGoogleDriveWrite,
  type GoogleWriteResponse,
  type GoogleWriteTarget,
} from "../src/tools/google_write.js";

const publicLinkArgs = {
  operation: "permissions.create.public_link",
  file_id: "fixture-file-1",
  sharing_scope: "anyone_with_link",
  role: "reader",
  allow_file_discovery: false,
};
const commandDigest = "a".repeat(64);
const operationPlanBindingDigest = "b".repeat(64);
const fixtureContent = "Publicly reviewed fixture body.\n";

function response(body: string, contentType = "application/json"): GoogleWriteResponse {
  return { status: 200, ok: true, content_type: contentType, body, body_utf8_valid: true,
    truncated: false, request_id: "fixture-request" };
}

function createFixture(options: { existingPublicPermission?: boolean; changeContentAfterReads?: number;
  throwAfterPublicPermissionCreate?: boolean } = {}) {
  const targets: GoogleWriteTarget[] = [];
  let publicPermissionCreated = options.existingPublicPermission === true;
  let contentReadCount = 0;
  const request = async (target: GoogleWriteTarget): Promise<GoogleWriteResponse> => {
    targets.push(target);
    if (target.method === "POST" && target.path.includes("/permissions?")) {
      publicPermissionCreated = true;
      if (options.throwAfterPublicPermissionCreate) throw new Error("fixture connection ended after request dispatch");
      return response(JSON.stringify({ id: "fixture-public-permission", type: "anyone", role: "reader",
        allowFileDiscovery: false }));
    }
    if (target.method === "GET" && target.path.includes("/permissions/fixture-public-permission?")) {
      return response(JSON.stringify({ id: "fixture-public-permission", type: "anyone", role: "reader",
        allowFileDiscovery: false }));
    }
    if (target.method === "GET" && target.path.includes("/permissions?")) {
      const permissions: unknown[] = [{ type: "user", emailAddress: "owner@example.invalid", role: "owner",
        allowFileDiscovery: false, deleted: false,
        permissionDetails: [{ permissionType: "file", role: "owner", inherited: false }] }];
      if (publicPermissionCreated) permissions.push({ type: "anyone", role: "reader", allowFileDiscovery: false,
        deleted: false, permissionDetails: [{ permissionType: "file", role: "reader", inherited: false }] });
      return response(JSON.stringify({ permissions }));
    }
    if (target.method === "GET" && target.path.includes("alt=media")) {
      contentReadCount += 1;
      const content = options.changeContentAfterReads !== undefined && contentReadCount > options.changeContentAfterReads
        ? "Changed after owner review.\n" : fixtureContent;
      return response(content, "text/plain; charset=utf-8");
    }
    if (target.method === "GET" && target.path.startsWith("/drive/v3/files/fixture-file-1?")) {
      return response(JSON.stringify({ id: "fixture-file-1", name: "reviewed.txt", mimeType: "text/plain",
        modifiedTime: "2026-11-11T00:00:00.000Z", parents: ["fixture-parent-1"], version: "17",
        headRevisionId: "fixture-revision-17", shared: publicPermissionCreated,
        inheritedPermissionsDisabled: false, ownedByMe: true, trashed: false }));
    }
    throw new Error(`Unexpected fixture request: ${target.method} ${target.path}`);
  };
  return { request, targets };
}

const env = { GOOGLE_DRIVE_ACCESS_TOKEN: "fixture-token" };

describe("Google Drive public link permission", () => {
  it("shows the exact current text in a read-only review and requires explicit link-only reader fields", async () => {
    const fixture = createFixture();
    const observation = GoogleDrivePublicLinkCreateTargetVersionObservationSchema.parse(
      await inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
        env, request: fixture.request, command_digest: commandDigest,
        operation_plan_binding_digest: operationPlanBindingDigest,
      }),
    );
    const review = await inspectGoogleDriveWriteContentReview(publicLinkArgs, {
      env, request: fixture.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    });

    expect(observation).toMatchObject({ permission_type: "anyone", permission_role: "reader",
      allow_file_discovery: false, used_for_authority: false, may_execute: false });
    expect(review).toMatchObject({ kind: "google_drive_public_link_create", current_content: fixtureContent,
      sharing_scope: "anyone_with_link", permission_role: "reader", allow_file_discovery: false,
      notification_email_sent: false, ownership_transfer: false, used_for_authority: false, may_execute: false });
    expect(fixture.targets.some((target) => target.method !== "GET")).toBe(false);
    await expect(inspectGoogleDriveWriteTargetVersion({ ...publicLinkArgs, allow_file_discovery: true }, {
      env, request: fixture.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    })).rejects.toThrow(/anyone_with_link reader access with discovery disabled/);
    await expect(inspectGoogleDriveWriteTargetVersion({ operation: "permissions.create", file_id: "fixture-file-1",
      email_address: "owner@example.invalid", role: "reader", sharing_scope: "anyone_with_link" }, {
      env, request: fixture.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    })).rejects.toThrow(/permissions.create contains unsupported fields/);
    expect(fixture.targets.some((target) => target.method !== "GET")).toBe(false);
  });

  it("blocks an already-public file and a body changed after the reviewed target version", async () => {
    const alreadyPublic = createFixture({ existingPublicPermission: true });
    await expect(inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
      env, request: alreadyPublic.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    })).rejects.toThrow(/public-link permission already exists/);
    expect(alreadyPublic.targets.some((target) => target.method === "POST")).toBe(false);

    const changed = createFixture({ changeContentAfterReads: 2 });
    const observation = await inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
      env, request: changed.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    });
    await expect(invokeGoogleDriveWrite(publicLinkArgs, {
      env, request: changed.request, command_digest: commandDigest,
      idempotency_key: "c".repeat(64), target_version_observation: observation,
    })).rejects.toThrow(/target or access scope changed after owner review/);
    expect(changed.targets.some((target) => target.method === "POST")).toBe(false);
  });

  it("reports a changed body or unknown create response without retrying or auto-revoking", async () => {
    const changedAfterCreate = createFixture({ changeContentAfterReads: 4 });
    const changedObservation = await inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
      env, request: changedAfterCreate.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    });
    await expect(invokeGoogleDriveWrite(publicLinkArgs, {
      env, request: changedAfterCreate.request, command_digest: commandDigest,
      idempotency_key: "f".repeat(64), target_version_observation: changedObservation,
    })).rejects.toThrow(/public-link readback did not confirm the reviewed audience, target, and content.*public_access_may_remain=true.*retry=false/);
    expect(changedAfterCreate.targets.filter((target) => target.method === "POST")).toHaveLength(1);

    const uncertain = createFixture({ throwAfterPublicPermissionCreate: true });
    const uncertainObservation = await inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
      env, request: uncertain.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    });
    await expect(invokeGoogleDriveWrite(publicLinkArgs, {
      env, request: uncertain.request, command_digest: commandDigest,
      idempotency_key: "0".repeat(64), target_version_observation: uncertainObservation,
    })).rejects.toThrow(/outcome_unknown.*public_access_may_remain=true.*retry=false/);
    expect(uncertain.targets.filter((target) => target.method === "POST")).toHaveLength(1);
  });

  it("sends one dedicated link-only reader request and confirms the permission by readback", async () => {
    const fixture = createFixture();
    const observation = await inspectGoogleDriveWriteTargetVersion(publicLinkArgs, {
      env, request: fixture.request, command_digest: commandDigest,
      operation_plan_binding_digest: operationPlanBindingDigest,
    });
    expect(assertGoogleDriveWriteTargetVersion(publicLinkArgs, observation, commandDigest,
      operationPlanBindingDigest)).toEqual(observation);

    const result = await invokeGoogleDriveWrite(publicLinkArgs, {
      env, request: fixture.request, command_digest: commandDigest,
      idempotency_key: "d".repeat(64), target_version_observation: observation,
    });
    const writes = fixture.targets.filter((target) => target.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body!)).toEqual({ type: "anyone", role: "reader", allowFileDiscovery: false });
    expect(result).toMatchObject({ operation: "permissions.create.public_link", mutation_sent: true,
      result: { file_id: "fixture-file-1", file_name: "reviewed.txt",
        verification: { status: "confirmed", permission_type: "anyone", permission_role: "reader",
          sharing_scope: "anyone_with_link", allow_file_discovery: false } } });
  });

  it("classifies the Google Drive mutation as requiring final review", () => {
    const command: ExecuteCommand = {
      id: "fixture-public-link-command",
      type: "tool_call",
      payload: { tool_name: "google.drive.write", arguments: publicLinkArgs },
      constraints: { allowed_tools: ["google.drive.write"], allowed_capabilities: ["tool:google.drive.write"] },
      upstream_decision: { frame_goal: "fixture", model_abstraction: "fixture",
        commit_hash: "e".repeat(64), commit_decision: "ASSERT" },
    };
    expect(finalReviewRequired(approvalContextFromCommand(command))).toBe(true);
  });
});
