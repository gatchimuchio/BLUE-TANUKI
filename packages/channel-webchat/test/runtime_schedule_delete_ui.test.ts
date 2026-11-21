import { createHash, webcrypto } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderControlCenterDocument } from "../src/control_center_document.js";
import { CONTROL_CENTER_SCRIPT } from "../src/control_center_script.js";

class UiElement {
  value = "";
  hidden = false;
  disabled = false;
  isConnected = true;
  textContent = "";
  children: UiElement[] = [];
  dataset: Record<string, string> = {};
  actions = new Map<string, () => unknown>();

  get selectedOptions() { return this.children.filter((option) => option.value === this.value); }
  add(node: UiElement) { this.children.push(node); }
  appendChild(node: UiElement) { this.add(node); }
  replaceChildren(...nodes: UiElement[]) { this.children = nodes; this.textContent = ""; this.value = ""; }
  addEventListener(event: string, action: () => unknown) { this.actions.set(event, action); }
  fire(event: string) { return this.actions.get(event)?.(); }
}

class UiOption extends UiElement {
  constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; }
}

function scriptBetween(first: string, last: string): string {
  const start = CONTROL_CENTER_SCRIPT.indexOf(first);
  const end = CONTROL_CENTER_SCRIPT.indexOf(last, start + first.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return CONTROL_CENTER_SCRIPT.slice(start, end);
}

function harness() {
  const elements = new Map<string, UiElement>();
  function byId(id: string) {
    if (!elements.has(id)) elements.set(id, new UiElement());
    return elements.get(id)!;
  }
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const responses = new Map<string, Response | Promise<Response>>();
  const context = {
    state: { approvalContentDigests: {} },
    byId,
    setText: (id: string, text: string) => { byId(id).textContent = text; },
    Option: UiOption,
    AbortController,
    crypto: webcrypto,
    TextEncoder,
    isRuntimeScheduleDeleteDigest: (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    isObject: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    formatInterval: (value: number) => String(value) + " ms",
    hasNoStore: (response: Response) => response.headers.get("cache-control") === "no-store",
    isLocalCredentialControlCenter: () => true,
    authHeaders: (token: string) => ({ Authorization: "Bearer " + token }),
    fetch: async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      const reply = responses.get(path);
      responses.delete(path);
      if (!reply) throw new Error("unexpected path");
      return reply;
    },
  };
  return { byId, context, calls, responses };
}

const respond = (body: object, status = 200, noStore = true) =>
  Response.json(body, { status, ...(noStore ? { headers: { "cache-control": "no-store" } } : {}) });
const goalRef = "goal_0123456789abcdef";
const revision = "a".repeat(64);

describe("Control Center runtime schedule deletion", () => {
  it("makes a no-store owner proposal only for the explicitly selected current runtime row and purpose version", async () => {
    expect(() => new Script(CONTROL_CENTER_SCRIPT)).not.toThrow();
    const html = renderControlCenterDocument();
    expect(html).toContain('id="prepare-runtime-schedule-delete"');
    expect(html).toContain('id="runtime-schedule-delete-review-owner-token" type="password"');

    const { byId, context, calls, responses } = harness();
    const window = new UiElement();
    const ui = new Script([
      scriptBetween("function renderOwnerTaskGoalOptions(", "async function loadOwnerTaskGoals("),
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "async function submitDailyBriefRead("),
      scriptBetween('byId("runtime-schedule-delete-id").addEventListener', 'byId("hide-goal-purpose-repair-handoff").addEventListener'),
    ].join("\n") + "\n({ renderRuntimeScheduleDeleteOptions })").runInNewContext({ ...context, window });
    const row = { id: "local-reminder", origin: "runtime", status: "active", enabled: true, time: "08:20",
      time_zone: "Asia/Tokyo", delete_revision_digest: revision };
    ui.renderRuntimeScheduleDeleteOptions([
      row, { ...row, id: "boot-row", origin: "boot" }, { ...row, id: "disabled", enabled: false },
      { ...row, id: "already-pending", pending_operation: "update" },
    ]);
    const schedules = byId("runtime-schedule-delete-id");
    const goals = byId("runtime-schedule-delete-goal");
    const credential = byId("runtime-schedule-delete-owner-token");
    const proposal = byId("prepare-runtime-schedule-delete");
    const next = byId("open-runtime-schedule-delete-plan");
    const status = byId("runtime-schedule-delete-status");
    const load = byId("load-runtime-schedule-delete-goals");
    expect(schedules.children.map((option) => option.value)).toEqual(["", row.id]);
    expect(proposal.disabled).toBe(true);
    expect(calls).toHaveLength(0);
    schedules.value = row.id;
    schedules.fire("change");
    credential.value = "owner-secret";
    responses.set("/owner/task-goals", respond({ goals: [{ goal_ref: goalRef, purpose_version: 2, purpose_preview: "予定を管理する" }] }));
    await load.fire("click");
    expect(calls[0]).toMatchObject({ path: "/owner/task-goals", options: { method: "GET", cache: "no-store",
      headers: { Authorization: "Bearer owner-secret" } } });
    expect(credential.value).toBe("");
    goals.value = goalRef;
    goals.fire("change");
    expect(proposal.disabled).toBe(false);
    await proposal.fire("click");
    expect(calls).toHaveLength(1);
    expect(status.textContent).toContain("owner token");

    const candidate = { accepted: true, status: "candidate_ready", request_id: "bounded-request",
      plan_id_digest: "b".repeat(64), used_for_authority: false, may_execute: false };
    const proposalPath = "/owner/runtime-schedule-delete-proposal";
    credential.value = "owner-secret";
    responses.set(proposalPath, respond(candidate, 202, false));
    await proposal.fire("click");
    expect(next.hidden).toBe(true);
    expect(status.textContent).toContain("受付を確認できません");

    credential.value = "owner-secret";
    responses.set(proposalPath, respond(candidate, 202));
    await proposal.fire("click");
    expect(calls.at(-1)).toMatchObject({ path: proposalPath, options: { method: "POST", cache: "no-store",
      mode: "same-origin", redirect: "error", headers: { Authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, expected_revision_digest: revision, goal_ref: goalRef, purpose_version: 2 }) } });
    expect(next.hidden).toBe(false);
    expect(credential.value).toBe("");
    expect(status.textContent).toContain("計画画面で目的との関係と削除対象を確認");
    expect(calls).toHaveLength(3);

    credential.value = "owner-secret";
    let release!: (response: Response) => void;
    responses.set(proposalPath, new Promise<Response>((resolve) => { release = resolve; }));
    const inFlight = proposal.fire("click");
    ui.renderRuntimeScheduleDeleteOptions([{ ...row, delete_revision_digest: "c".repeat(64) }]);
    expect(schedules.value).toBe("");
    release(respond(candidate, 202));
    await inFlight;
    expect(calls.at(-1)?.options.signal?.aborted).toBe(true);
    expect(next.hidden).toBe(true);
    expect(status.textContent).toContain("前の削除案の受付は未確認");
    window.fire("pagehide");
    expect(goals.children.map((option) => option.value)).toEqual([""]);
    expect(byId("runtime-schedule-delete-request").hidden).toBe(true);
  });

  it("requires both credentials and current exact no-store review before the ordinary approval verdict", async () => {
    const { byId, context, calls, responses } = harness();
    const content = new UiElement();
    const approve = new UiElement();
    const reviewButton = new UiElement();
    const commandId = "delete-sched";
    const card = {
      isConnected: true,
      getAttribute: (attribute: string) => attribute === "data-command" ? commandId
        : attribute === "data-runtime-schedule-delete" ? "" : null,
      querySelector: (selector: string) => selector === "[data-content-review-view]" ? content : approve,
    };
    const ui = new Script([
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "function currentRuntimeScheduleDeleteRow("),
      scriptBetween("function clearRuntimeScheduleDeleteReviews(", "async function requestTaskCancellation("),
      scriptBetween("async function renderRuntimeScheduleDeleteReview(", '        if ((card.getAttribute("data-goal-purpose-adoption")'),
      "}",
    ].join("\n") + "\n({ reviewApprovalContent, submitApproval, clearRuntimeScheduleDeleteReviews })").runInNewContext({
      ...context, document: { querySelectorAll: () => [card], createElement: () => new UiElement() }, loadApprovals: () => {},
    });
    const body = { kind: "schedule_delete", operation: "schedule.delete", command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64), schedule_id: "local-reminder", revision_digest: revision,
      channel: "webchat", target: "<owner>", time: "08:20", payload_hash: "c".repeat(64), goal_ref: goalRef, purpose_version: 2,
      no_store: true, used_for_authority: false, may_execute: false };
    const keys = Object.keys(body).sort((a, b) => a.localeCompare(b));
    const reviewDigest = createHash("sha256").update(JSON.stringify(body, keys)).digest("hex");
    const review = { ...body, command_id: commandId, review_digest: reviewDigest };
    const contentPath = "/approval/delete-sched/content";
    const verdictPath = "/approval/delete-sched";
    byId("approval-token").value = "resume-secret";
    const owner = byId("runtime-schedule-delete-review-owner-token");
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("owner token");
    expect(calls).toHaveLength(0);
    owner.value = "owner-secret";
    responses.set(contentPath, respond(review, 200, false));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("予定削除");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond({ ...review, time: "09:00" }));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("審査");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond(review));
    await ui.reviewApprovalContent(commandId, reviewButton);
    expect(calls.at(-1)).toMatchObject({ path: contentPath, options: { mode: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer resume-secret", "x-blue-tanuki-owner-token": "owner-secret" } } });
    expect(approve.disabled).toBe(false);
    expect(content.children.map((node) => node.textContent)).toContain("送信先　webchat / <owner>");
    responses.set(verdictPath, respond({ ok: true, result: { approval: "approve", executed: true } }));
    await ui.submitApproval(commandId, "approve", "one-use");
    expect(calls.at(-1)).toMatchObject({ path: verdictPath, options: { mode: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer resume-secret", "x-blue-tanuki-owner-token": "owner-secret" },
      body: JSON.stringify({ verdict: "approve", approval_token: "one-use", content_review_digest: reviewDigest }) } });
    expect(owner.value).toBe("");
    expect(approve.disabled).toBe(true);
    expect(Object.keys(context.state.approvalContentDigests)).toHaveLength(0);
  });
});

describe("Control Center runtime schedule creation", () => {
  it("submits only the exact owner-entered content, explicit trigger and selected current purpose", async () => {
    expect(() => new Script(CONTROL_CENTER_SCRIPT)).not.toThrow();
    const html = renderControlCenterDocument();
    expect(html).toContain('id="prepare-runtime-schedule-create"');
    expect(html).toContain('id="runtime-schedule-create-content"');
    expect(html).toContain('id="runtime-schedule-create-review-owner-token" type="password"');

    const { byId, context, calls, responses } = harness();
    const ui = new Script([
      scriptBetween("function renderOwnerTaskGoalOptions(", "async function loadOwnerTaskGoals("),
      scriptBetween("function runtimeScheduleCreateProposalFromForm(", "async function submitRuntimeScheduleDeleteRequest("),
      "({ runtimeScheduleCreateProposalFromForm, renderRuntimeScheduleCreateAvailability, submitRuntimeScheduleCreateRequest })",
    ].join("\n")).runInNewContext(context);
    byId("runtime-schedule-create-id").value = "morning-note";
    byId("runtime-schedule-create-channel").value = "webchat";
    byId("runtime-schedule-create-target").value = "owner";
    byId("runtime-schedule-create-content").value = "<reminder>朝の確認</reminder>";
    byId("runtime-schedule-create-trigger-kind").value = "daily";
    byId("runtime-schedule-create-time").value = "08:30";
    byId("runtime-schedule-create-time-zone").value = "Asia/Tokyo";
    byId("runtime-schedule-create-owner-token").value = "owner-secret";
    ui.renderRuntimeScheduleCreateAvailability();
    expect(byId("prepare-runtime-schedule-create").disabled).toBe(true);

    responses.set("/owner/task-goals", respond({ goals: [{ goal_ref: goalRef, purpose_version: 3, purpose_preview: "朝の確認" }] }));
    await ui.submitRuntimeScheduleCreateRequest(true);
    const goal = byId("runtime-schedule-create-goal");
    goal.value = goalRef;
    byId("runtime-schedule-create-owner-token").value = "owner-secret";
    ui.renderRuntimeScheduleCreateAvailability();
    expect(byId("prepare-runtime-schedule-create").disabled).toBe(false);
    const candidate = { accepted: true, status: "candidate_ready", request_id: "bounded-request",
      plan_id_digest: "b".repeat(64), used_for_authority: false, may_execute: false };
    responses.set("/owner/runtime-schedule-create-proposal", respond(candidate, 202));
    await ui.submitRuntimeScheduleCreateRequest(false);
    expect(calls.at(-1)).toMatchObject({ path: "/owner/runtime-schedule-create-proposal", options: {
      method: "POST", cache: "no-store", mode: "same-origin", redirect: "error",
      headers: { Authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: "morning-note", channel: "webchat", target: "owner",
        content: "<reminder>朝の確認</reminder>", goal_ref: goalRef, purpose_version: 3,
        time: "08:30", time_zone: "Asia/Tokyo" }),
    } });
    expect(byId("runtime-schedule-create-owner-token").value).toBe("");
    expect(byId("runtime-schedule-create-content").value).toBe("");
    expect(byId("open-runtime-schedule-create-plan").hidden).toBe(false);
    expect(byId("runtime-schedule-create-status").textContent).toContain("本文・宛先・時刻・委任目的");
  });

  it("validates daily clock and interval syntax in the emitted Control Center script", () => {
    const { byId, context } = harness();
    const ui = new Script([
      scriptBetween("function runtimeScheduleCreateProposalFromForm(", "function renderRuntimeScheduleCreateAvailability("),
      "({ runtimeScheduleCreateProposalFromForm })",
    ].join("\n")).runInNewContext(context) as { runtimeScheduleCreateProposalFromForm: () => Record<string, unknown> | null };
    byId("runtime-schedule-create-id").value = "morning-note";
    byId("runtime-schedule-create-channel").value = "webchat";
    byId("runtime-schedule-create-target").value = "owner";
    byId("runtime-schedule-create-content").value = "朝の確認";
    byId("runtime-schedule-create-goal").children.push(Object.assign(new UiOption("目的", goalRef), {
      dataset: { purposeVersion: "3" },
    }));
    byId("runtime-schedule-create-goal").value = goalRef;
    byId("runtime-schedule-create-trigger-kind").value = "daily";
    byId("runtime-schedule-create-time").value = "08:30";
    byId("runtime-schedule-create-time-zone").value = "Asia/Tokyo";
    expect(ui.runtimeScheduleCreateProposalFromForm()).toMatchObject({ time: "08:30", time_zone: "Asia/Tokyo" });
    for (const time of ["8:30", "24:00", "08:60"]) {
      byId("runtime-schedule-create-time").value = time;
      expect(ui.runtimeScheduleCreateProposalFromForm()).toBeNull();
    }
    byId("runtime-schedule-create-trigger-kind").value = "interval";
    byId("runtime-schedule-create-interval").value = "60000";
    expect(ui.runtimeScheduleCreateProposalFromForm()).toMatchObject({ interval_ms: 60_000 });
    for (const interval of ["0", "1e3", "2147483648"]) {
      byId("runtime-schedule-create-interval").value = interval;
      expect(ui.runtimeScheduleCreateProposalFromForm()).toBeNull();
    }
  });

  it("renders the digest-bound no-store review as text and keeps approval disabled for changed content", async () => {
    const { byId, context } = harness();
    const content = new UiElement();
    const approve = new UiElement();
    const reviewButton = new UiElement();
    const commandId = "create-sched";
    const card = { isConnected: true };
    const ui = new Script([
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "function currentRuntimeScheduleDeleteRow("),
      scriptBetween("async function renderRuntimeScheduleCreateReview(", "async function renderRuntimeScheduleDeleteReview("),
      "({ renderRuntimeScheduleCreateReview })",
    ].join("\n")).runInNewContext({ ...context,
      document: { createElement: () => new UiElement(), querySelectorAll: () => [] },
    });
    const purpose = "毎朝の確認事項を owner に案内する。";
    const body = {
      kind: "schedule_create", operation: "schedule.create", command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64), schedule_id: "morning-note", channel: "webchat", target: "owner",
      content: "<img src=x onerror=alert(1)>", interval_ms: 60_000, payload_hash: "c".repeat(64),
      goal_ref: goalRef, purpose_version: 3, purpose_digest: createHash("sha256").update(purpose, "utf8").digest("hex"),
      purpose_text: purpose, no_store: true, used_for_authority: false, may_execute: false,
    };
    const digestKeys = Object.keys(body).sort((a, b) => a.localeCompare(b));
    const reviewDigest = createHash("sha256").update(JSON.stringify(body, digestKeys)).digest("hex");
    const review = { ...body, command_id: commandId, review_digest: reviewDigest };
    const isCurrent = () => true;
    approve.disabled = true;
    await ui.renderRuntimeScheduleCreateReview(review, commandId, card, content, approve, reviewButton, isCurrent);
    expect(approve.disabled).toBe(false);
    expect(content.children.map((node) => node.textContent)).toContain("<img src=x onerror=alert(1)>");
    expect(content.children.some((node) => node.innerHTML)).toBe(false);
    approve.disabled = true;
    await expect(ui.renderRuntimeScheduleCreateReview({ ...review, content: "changed" }, commandId, card, content, approve,
      reviewButton, isCurrent)).rejects.toThrow("審査");
    expect(approve.disabled).toBe(true);
    expect(byId("approval-token").value).toBe("");
  });
});

describe("Control Center runtime schedule update", () => {
  it("submits only a full replacement bound to the selected current revision", async () => {
    expect(() => new Script(CONTROL_CENTER_SCRIPT)).not.toThrow();
    const html = renderControlCenterDocument();
    expect(html).toContain('id="prepare-runtime-schedule-update"');
    expect(html).toContain('id="runtime-schedule-update-review-owner-token" type="password"');
    const { byId, context, calls, responses } = harness();
    const ui = new Script([
      scriptBetween("function renderOwnerTaskGoalOptions(", "async function loadOwnerTaskGoals("),
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "function currentRuntimeScheduleDeleteRow("),
      scriptBetween("function currentRuntimeScheduleUpdateRow(", "function runtimeScheduleCreateProposalFromForm("),
      scriptBetween("function runtimeScheduleUpdateProposalFromForm(", "function renderRuntimeScheduleCreateAvailability("),
      scriptBetween("function renderRuntimeScheduleUpdateAvailability(", "function clearRuntimeScheduleCreateReceipt("),
      scriptBetween("function clearRuntimeScheduleUpdateForm(", "async function submitRuntimeScheduleCreateRequest("),
      scriptBetween("async function submitRuntimeScheduleUpdateRequest(", "async function submitRuntimeScheduleDeleteRequest("),
      "({ renderRuntimeScheduleUpdateOptions, selectRuntimeScheduleUpdateRow, runtimeScheduleUpdateProposalFromForm, renderRuntimeScheduleUpdateAvailability, submitRuntimeScheduleUpdateRequest })",
    ].join("\n")).runInNewContext(context) as {
      renderRuntimeScheduleUpdateOptions: (rows: Record<string, unknown>[]) => void;
      selectRuntimeScheduleUpdateRow: () => void;
      runtimeScheduleUpdateProposalFromForm: () => Record<string, unknown> | null;
      renderRuntimeScheduleUpdateAvailability: () => void;
      submitRuntimeScheduleUpdateRequest: (goalsOnly: boolean) => Promise<void>;
    };
    const row = { id: "morning-note", origin: "runtime", status: "active", enabled: true,
      channel: "webchat", target: "owner", interval_ms: 120_000, revision_digest: revision,
      content: "must not be projected into the form" };
    ui.renderRuntimeScheduleUpdateOptions([row, { ...row, id: "pending", pending_operation: "update" },
      { ...row, id: "boot", origin: "boot" }, { ...row, id: "unbound", revision_digest: undefined }]);
    expect(byId("runtime-schedule-update-id").children.map((option) => option.value)).toEqual(["", row.id]);
    byId("runtime-schedule-update-id").value = row.id;
    ui.selectRuntimeScheduleUpdateRow();
    expect(byId("runtime-schedule-update-channel").value).toBe("webchat");
    expect(byId("runtime-schedule-update-target").value).toBe("owner");
    expect(byId("runtime-schedule-update-content").value).toBe("");
    expect(byId("runtime-schedule-update-content").value).not.toContain("must not be projected");

    byId("runtime-schedule-update-content").value = "更新後の本文";
    byId("runtime-schedule-update-owner-token").value = "owner-secret";
    const goal = byId("runtime-schedule-update-goal");
    goal.children.push(Object.assign(new UiOption("目的", goalRef), { dataset: { purposeVersion: "3" } }));
    goal.value = goalRef;
    ui.renderRuntimeScheduleUpdateAvailability();
    expect(ui.runtimeScheduleUpdateProposalFromForm()).toMatchObject({ id: row.id, expected_revision_digest: revision,
      channel: "webchat", target: "owner", content: "更新後の本文", interval_ms: 120_000,
      goal_ref: goalRef, purpose_version: 3 });

    responses.set("/owner/task-goals", respond({ goals: [{ goal_ref: goalRef, purpose_version: 3, purpose_preview: "毎朝確認する" }] }));
    await ui.submitRuntimeScheduleUpdateRequest(true);
    expect(byId("runtime-schedule-update-owner-token").value).toBe("");
    goal.value = goalRef;
    byId("runtime-schedule-update-owner-token").value = "owner-secret";
    const candidate = { accepted: true, status: "candidate_ready", request_id: "bounded-update",
      plan_id_digest: "b".repeat(64), used_for_authority: false, may_execute: false };
    responses.set("/owner/runtime-schedule-update-proposal", respond(candidate, 202));
    await ui.submitRuntimeScheduleUpdateRequest(false);
    expect(calls.at(-1)).toMatchObject({ path: "/owner/runtime-schedule-update-proposal", options: {
      method: "POST", cache: "no-store", mode: "same-origin", redirect: "error",
      headers: { Authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, expected_revision_digest: revision, channel: "webchat", target: "owner",
        content: "更新後の本文", goal_ref: goalRef, purpose_version: 3, interval_ms: 120_000 }),
    } });
    expect(byId("runtime-schedule-update-owner-token").value).toBe("");
    expect(byId("runtime-schedule-update-content").value).toBe("");
    expect(byId("open-runtime-schedule-update-plan").hidden).toBe(false);
    expect(byId("runtime-schedule-update-status").textContent).toContain("新しい本文・宛先・発火条件・委任目的");
  });

  it("requires a no-store digest-bound update review before the ordinary L3 verdict", async () => {
    const { byId, context, calls, responses } = harness();
    const content = new UiElement();
    const approve = new UiElement();
    const reviewButton = new UiElement();
    const commandId = "update-sched";
    const card = {
      isConnected: true,
      getAttribute: (attribute: string) => attribute === "data-command" ? commandId
        : attribute === "data-runtime-schedule-update" ? "" : null,
      querySelector: (selector: string) => selector === "[data-content-review-view]" ? content : approve,
    };
    const purpose = "毎朝の確認事項を owner に案内する。";
    const payload = { channel: "webchat", target: "<owner>", content: "<safe-text>更新後</safe-text>",
      time: "07:00", interval_ms: 60_000 };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    const body = { kind: "schedule_update", operation: "schedule.update", command_digest: "a".repeat(64),
      operation_plan_binding_digest: "b".repeat(64), schedule_id: "morning-note", expected_revision_digest: revision,
      channel: payload.channel, target: payload.target, content: payload.content, interval_ms: payload.interval_ms,
      payload_hash: payloadHash, goal_ref: goalRef, purpose_version: 3,
      purpose_digest: createHash("sha256").update(purpose, "utf8").digest("hex"), purpose_text: purpose,
      no_store: true, used_for_authority: false, may_execute: false };
    const keys = Object.keys(body).sort((a, b) => a.localeCompare(b));
    const reviewDigest = createHash("sha256").update(JSON.stringify(body, keys)).digest("hex");
    const review = { ...body, command_id: commandId, review_digest: reviewDigest };
    const contentPath = "/approval/update-sched/content";
    const verdictPath = "/approval/update-sched";
    const ui = new Script([
      scriptBetween("function isRuntimeScheduleDeleteDigest(", "function currentRuntimeScheduleDeleteRow("),
      scriptBetween("function clearRuntimeScheduleUpdateReviews(", "async function submitApproval("),
      scriptBetween("async function submitApproval(", "async function requestTaskCancellation("),
      scriptBetween("async function renderRuntimeScheduleUpdateReview(", '        if ((card.getAttribute("data-goal-purpose-adoption")'),
      "}",
    ].join("\n") + "\n({ reviewApprovalContent, submitApproval, clearRuntimeScheduleUpdateReviews })").runInNewContext({
      ...context, document: { querySelectorAll: () => [card], createElement: () => new UiElement() }, loadApprovals: () => {},
    }) as {
      reviewApprovalContent: (commandId: string, button: UiElement) => Promise<void>;
      submitApproval: (commandId: string, verdict: string, token: string) => Promise<void>;
      clearRuntimeScheduleUpdateReviews: () => void;
    };
    byId("approval-token").value = "resume-secret";
    const owner = byId("runtime-schedule-update-review-owner-token");
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("owner token");
    expect(calls).toHaveLength(0);
    owner.value = "owner-secret";
    responses.set(contentPath, respond(review, 200, false));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("予定更新");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond({ ...review, content: "改変" }));
    await expect(ui.reviewApprovalContent(commandId, reviewButton)).rejects.toThrow("審査");
    expect(approve.disabled).toBe(true);
    responses.set(contentPath, respond(review));
    await ui.reviewApprovalContent(commandId, reviewButton);
    expect(content.children.map((node) => node.textContent)).toContain("更新前の版　" + revision);
    expect(content.children.map((node) => node.textContent)).toContain(payload.content);
    expect(approve.disabled).toBe(false);
    responses.set(verdictPath, respond({ ok: true, result: { approval: "approve", executed: true } }));
    await ui.submitApproval(commandId, "approve", "one-use");
    expect(calls.at(-1)).toMatchObject({ path: verdictPath, options: { mode: "same-origin", cache: "no-store",
      headers: { Authorization: "Bearer resume-secret", "x-blue-tanuki-owner-token": "owner-secret" },
      body: JSON.stringify({ verdict: "approve", approval_token: "one-use", content_review_digest: reviewDigest }) } });
    expect(owner.value).toBe("");
    expect(approve.disabled).toBe(true);
    expect(Object.keys(context.state.approvalContentDigests)).toHaveLength(0);
  });
});
