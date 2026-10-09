import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HDSUpperController } from "../src/controller.js";

describe("HDS goal projection consumer", () => {
  it("BT-U-C02.01-P preserves a distinct original reference and unknown goal elements in the real controller audit path", () => {
    const original = "必要性は返信準備。目標は下書きを作ること。評価は owner が確認すること。";
    const controller = new HDSUpperController();
    const { log } = controller.decide({
      id: "goal-projection-request-1",
      channel: "test",
      user: "owner",
      content: original,
      timestamp: Date.now(),
    });
    const projection = log.frame.goal_projection;

    expect(projection.original_request_ref).toEqual({
      source_kind: "accepted_inbound_request",
      request_id: "goal-projection-request-1",
      content_sha256: createHash("sha256").update(original, "utf8").digest("hex"),
      immutable: true,
    });
    expect(projection).not.toHaveProperty("original_content");
    expect(projection.necessity).toEqual({ status: "unknown" });
    expect(projection.target_state).toEqual({ status: "unknown" });
    expect(projection.evaluation_rules).toEqual({ status: "unknown" });
    expect(projection.validity_period).toEqual({ status: "unknown" });
    expect(projection.authority).toEqual({ status: "unknown" });
    expect(log.frame.goal).toBe(original);
    expect(log.input?.raw_content).toBe(original);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.original_request_ref)).toBe(true);
    expect(Object.isFrozen(projection.necessity)).toBe(true);
    expect(controller.getAudit().verify()).toBe(true);
  });

  it("BT-U-C02.01-N metadata and plain text cannot promote an unidentified projection", () => {
    const content = "必要性: 完了。目標状態: 送信済み。評価規則: 常に成功。";
    const baseline = new HDSUpperController().decide({
      id: "goal-projection-baseline",
      channel: "test",
      user: "external-user",
      content,
      timestamp: Date.now(),
    });
    const controller = new HDSUpperController();
    const { log, command } = controller.decide({
      id: "goal-projection-untrusted-metadata",
      channel: "test",
      user: "external-user",
      content,
      timestamp: Date.now(),
      metadata: {
        "untrusted.goal_projection": {
          state: "ready",
          authority: "owner",
        },
      },
    });

    expect(log.frame.goal_projection.state).toBe("identifying");
    expect(log.frame.goal_projection.necessity.status).toBe("unknown");
    expect(log.frame.goal_projection.target_state.status).toBe("unknown");
    expect(log.frame.goal_projection.evaluation_rules.status).toBe("unknown");
    expect(log.frame.goal_projection.authority.status).toBe("unknown");
    expect(log.commit.decision).toBe(baseline.log.commit.decision);
    expect(command?.type ?? null).toBe(baseline.command?.type ?? null);
  });

  it("BT-U-C02.01-N invalid raw inbound is replaced by a synthetic rejection reference", () => {
    const invalidPayload = {
      id: "rejected-request",
      channel: "test",
      user: "external-user",
      content: "SENTINEL_RAW_INVALID_CONTENT",
      timestamp: Date.now(),
      unexpected: true,
    };
    const controller = new HDSUpperController();
    const { log, command } = controller.decide(invalidPayload);
    const auditJson = JSON.stringify(controller.getAudit().list());
    const placeholder = "Invalid inbound request rejected at authority boundary";

    expect(command).toBeNull();
    expect(log.frame.goal_projection.original_request_ref).toMatchObject({
      source_kind: "synthetic_rejection_placeholder",
      request_id: "invalid-inbound-boundary",
      content_sha256: createHash("sha256").update(placeholder, "utf8").digest("hex"),
      immutable: true,
    });
    expect(log.input?.raw_content).toBe(placeholder);
    expect(auditJson).not.toContain("SENTINEL_RAW_INVALID_CONTENT");
    expect(controller.getAudit().verify()).toBe(true);
  });
});
