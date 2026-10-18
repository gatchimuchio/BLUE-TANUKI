import { createHash } from "node:crypto";

const OPERATION_REQUEST_PREFIX = "operation-request:";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const SAFE_ACTOR_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

/** The same channel/actor digest used by the document checkpoint store. */
export function recoveryActorScopeDigest(channel: unknown, actor: unknown): string | null {
  if (typeof channel !== "string" || !SAFE_ACTOR_ID.test(channel) ||
      typeof actor !== "string" || !SAFE_ACTOR_ID.test(actor)) return null;
  return createHash("sha256")
    .update(`${channel.length}:${channel}|${actor.length}:${actor}`)
    .digest("hex");
}

/** Stable diagnostic correlation for one actor-bound inbound request; never authority or a recovery grant. */
export function recoveryRequestScopeDigest(requestId: unknown, actorDigest: unknown): string | null {
  if (typeof requestId !== "string" || !SAFE_REQUEST_ID.test(requestId) ||
      typeof actorDigest !== "string" || !DIGEST.test(actorDigest)) return null;
  return createHash("sha256")
    .update(`blue-tanuki.inbound-request-scope.v1\0${actorDigest}\0${requestId}`)
    .digest("hex");
}

/** Operation Plan stores this exact namespace around the originating InboundRequest.id. */
export function operationPlanRequestScopeDigest(operationRequestId: unknown, channel: unknown, actor: unknown): string | null {
  if (typeof operationRequestId !== "string" || !operationRequestId.startsWith(OPERATION_REQUEST_PREFIX)) return null;
  return recoveryRequestScopeDigest(
    operationRequestId.slice(OPERATION_REQUEST_PREFIX.length),
    recoveryActorScopeDigest(channel, actor),
  );
}
