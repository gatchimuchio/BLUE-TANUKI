import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { githubCodePushRequestPayloadDigest, githubReleaseDraftCreateRequestPayloadDigest, type OperationStep } from "@blue-tanuki/protocol";
import { operationPlanResultValidationMatches } from "../src/operation_plan.js";

describe("github.write code.push Operation Plan result contract", () => {
  it("accepts only a commit whose parent, branch, path, and content digest match the request", () => {
    const parameters = {
      operation: "code.push",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      branch: "feature/code-push",
      expected_head_sha: "a".repeat(40),
      path: "docs/new-note.txt",
      content: "reviewed file\n",
      commit_message: "Add reviewed note",
    };
    const target = { kind: "external_service" as const, id: "github" };
    const step = { operation: "github.write", adapter: "external_api", target, parameters } as OperationStep;
    const validation = { method: "github_write_result_matches", target,
      expected: { schema_version: "blue-tanuki.github-write-result-validation.v1", operation: "code.push" } };
    const binding = { command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
      executor_command_digest: "e".repeat(64) };
    const contentDigest = createHashHex(parameters.content);
    const requestPayloadDigest = githubCodePushRequestPayloadDigest({ owner: parameters.owner, repo: parameters.repo,
      branch: parameters.branch, expected_head_sha: parameters.expected_head_sha, path: parameters.path,
      content: parameters.content, commit_message: parameters.commit_message });
    const result = {
      schema_version: "blue-tanuki.github-write-result.v1",
      operation: "code.push",
      api_host: "api.github.com",
      repo: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      target_identity_digest: "1".repeat(64),
      request_payload_digest: requestPayloadDigest,
      command_digest: binding.command_digest,
      operation_plan_binding_digest: binding.operation_plan_binding_digest,
      method: "POST",
      path: "/graphql",
      status: 200,
      mutation_status: "provider_accepted",
      content_type: "application/json",
      truncated: false,
      rate_limit_remaining: "59",
      github_request_id: "CODE-PUSH-REQ",
      result_digest: "3".repeat(64),
      result: { branch: parameters.branch, commit_sha: "b".repeat(40),
        parent_sha: parameters.expected_head_sha, path: parameters.path, content_sha256: contentDigest },
      provider_data_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    };
    const matches = (output: unknown) => operationPlanResultValidationMatches(
      validation as Parameters<typeof operationPlanResultValidationMatches>[0], step, output,
      binding as Parameters<typeof operationPlanResultValidationMatches>[3]);

    expect(matches(result)).toBe(true);
    expect(matches({ ...result, result: { ...result.result, parent_sha: "f".repeat(40) } })).toBe(false);
    expect(matches({ ...result, result: { ...result.result, path: "docs/other.txt" } })).toBe(false);
    expect(matches({ ...result, result: { ...result.result, content_sha256: "4".repeat(64) } })).toBe(false);
  });
});

describe("github.write release.draft.create Operation Plan result contract", () => {
  it("accepts only a verified unpublished draft bound to the reviewed tag and commit", () => {
    const parameters = {
      operation: "release.draft.create",
      owner: "gatchimuchio",
      repo: "blue-tanuki",
      tag_name: "v1.0",
      target_commit_sha: "a".repeat(40),
      name: "Reviewed draft",
      body: "Draft body",
    };
    const target = { kind: "external_service" as const, id: "github" };
    const step = { operation: "github.write", adapter: "external_api", target, parameters } as OperationStep;
    const validation = { method: "github_write_result_matches", target,
      expected: { schema_version: "blue-tanuki.github-write-result-validation.v1", operation: "release.draft.create" } };
    const binding = { command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
      executor_command_digest: "e".repeat(64) };
    const requestPayloadDigest = githubReleaseDraftCreateRequestPayloadDigest({ owner: parameters.owner,
      repo: parameters.repo, tag_name: parameters.tag_name, target_commit_sha: parameters.target_commit_sha,
      name: parameters.name, body: parameters.body });
    const result = {
      schema_version: "blue-tanuki.github-write-result.v1",
      operation: "release.draft.create",
      api_host: "api.github.com",
      repo: "gatchimuchio/blue-tanuki",
      repository_id: 123,
      target_identity_digest: "1".repeat(64),
      request_payload_digest: requestPayloadDigest,
      command_digest: binding.command_digest,
      operation_plan_binding_digest: binding.operation_plan_binding_digest,
      method: "POST",
      path: "/repos/gatchimuchio/blue-tanuki/releases",
      status: 201,
      mutation_status: "provider_accepted",
      content_type: "application/json",
      truncated: false,
      rate_limit_remaining: "59",
      github_request_id: "DRAFT-REQ",
      result_digest: "3".repeat(64),
      result: { id: 987, tag_name: parameters.tag_name, target_commit_sha: parameters.target_commit_sha,
        name: parameters.name, draft: true, prerelease: false },
      provider_data_is_untrusted: true,
      used_for_authority: false,
      may_execute: false,
    };
    const matches = (output: unknown) => operationPlanResultValidationMatches(
      validation as Parameters<typeof operationPlanResultValidationMatches>[0], step, output,
      binding as Parameters<typeof operationPlanResultValidationMatches>[3]);

    expect(matches(result)).toBe(true);
    expect(matches({ ...result, result: { ...result.result, tag_name: "v2.0" } })).toBe(false);
    expect(matches({ ...result, result: { ...result.result, target_commit_sha: "f".repeat(40) } })).toBe(false);
    expect(matches({ ...result, result: { ...result.result, draft: false } })).toBe(false);
  });
});

function createHashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
