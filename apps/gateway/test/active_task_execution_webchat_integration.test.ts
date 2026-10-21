import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { ActiveTaskExecutionRegistry } from "../src/active_task_execution_registry.js";
import { WebChatChannel } from "@blue-tanuki/channel-webchat";

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("failed to allocate integration-test port"));
      });
    });
  });
}

describe("active task cancellation WebChat integration", () => {
  let channel: WebChatChannel | undefined;

  afterEach(async () => {
    await channel?.stop();
    channel = undefined;
  });

  it("routes a resume-authenticated task cancel to only the matching active AbortController", async () => {
    const registry = new ActiveTaskExecutionRegistry();
    const target = new AbortController();
    const other = new AbortController();
    registry.register("cmd-integration-target", target, 100);
    registry.register("cmd-integration-other", other, 200);

    const port = await allocatePort();
    channel = new WebChatChannel({
      port,
      host: "127.0.0.1",
      token: "integration-inbound-token",
      resume_token: "integration-resume-token",
      rate_limits: false,
      approval: {
        list: async () => [],
        activeExecutions: async () => registry.snapshot(),
        cancelExecution: async (command_id, context) => registry.requestCancel(command_id, context.actor),
      },
    });
    await channel.start(async () => {});

    const baseUrl = `http://127.0.0.1:${port}`;
    const unauthenticated = await fetch(`${baseUrl}/approval/executions/cmd-integration-target/cancel`, {
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    expect(target.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);

    const wrongTarget = await fetch(`${baseUrl}/approval/executions/cmd-missing/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer integration-resume-token" },
    });
    expect(wrongTarget.status).toBe(404);
    expect(target.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);

    const accepted = await fetch(`${baseUrl}/approval/executions/cmd-integration-target/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer integration-resume-token" },
    });
    expect(accepted.status).toBe(200);
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(await accepted.json()).toMatchObject({
      cancellation: {
        command_id: "cmd-integration-target",
        cancel_request_accepted: true,
        executor_settled: false,
        external_processing_stop: "unknown",
        used_for_authority: false,
      },
    });

    const snapshot = await fetch(`${baseUrl}/approval`, {
      headers: { authorization: "Bearer integration-resume-token" },
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      active_executions: [
        {
          command_id: "cmd-integration-target",
          execution_signal_aborted: true,
          executor_state: "cancel_requested",
          external_processing_stop: "unknown",
        },
        { command_id: "cmd-integration-other", execution_signal_aborted: false },
      ],
    });
  });
});
