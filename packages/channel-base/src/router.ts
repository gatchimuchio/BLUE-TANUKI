import type { InboundRequest } from "@blue-tanuki/protocol";
import type { InboundChannel, InboundEphemeralContext, InboundHandler } from "./types.js";
import { clearInboundLineReplyContext, registerInboundLineReplyContext } from "./dispatcher.js";

export interface InboundRouterOptions {
  /** Channels whose scheduler must observe handler failure to persist an unknown outcome. */
  readonly propagateHandlerErrorsForChannels?: readonly string[];
  /** Channels whose handler error details may contain external provider or user data. */
  readonly redactHandlerErrorsForChannels?: readonly string[];
  /** Requests whose authenticated ingress must observe a failure without the original exception. */
  readonly propagateRedactedHandlerErrorsForRequest?: (request: InboundRequest) => boolean;
}

/**
 * InboundRouter — multiplexes multiple InboundChannels into a single handler.
 *
 * Phase 2: registration is in-memory. Each channel calls the handler
 * independently; ordering across channels is not guaranteed.
 *
 * Pure routing layer. No judgment. No LLM. The handler typically wires to
 * HDS-BRAIN's `decide()`.
 */
export class InboundRouter {
  private readonly channels = new Map<string, InboundChannel>();
  private readonly propagateHandlerErrorsForChannels: ReadonlySet<string>;
  private readonly redactHandlerErrorsForChannels: ReadonlySet<string>;
  private readonly propagateRedactedHandlerErrorsForRequest: InboundRouterOptions["propagateRedactedHandlerErrorsForRequest"];
  private started = false;
  private handler: InboundHandler | null = null;

  constructor(options: InboundRouterOptions = {}) {
    this.propagateHandlerErrorsForChannels = new Set(options.propagateHandlerErrorsForChannels ?? []);
    this.redactHandlerErrorsForChannels = new Set(options.redactHandlerErrorsForChannels ?? []);
    this.propagateRedactedHandlerErrorsForRequest = options.propagateRedactedHandlerErrorsForRequest;
  }

  register(channel: InboundChannel): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`InboundRouter: channel already registered: ${channel.name}`);
    }
    if (this.started) {
      throw new Error(
        `InboundRouter: cannot register '${channel.name}' after start()`,
      );
    }
    this.channels.set(channel.name, channel);
  }

  /**
   * Start every registered channel with the given handler.
   * The handler is invoked once per inbound message from any channel.
   */
  async start(handler: InboundHandler): Promise<void> {
    if (this.started) {
      throw new Error("InboundRouter: already started");
    }
    this.handler = handler;
    const wrapped: InboundHandler = async (req: InboundRequest, context?: InboundEphemeralContext) => {
      // Defensive: never let one inbound throw take down a channel listener.
      let lineReplyContextRegistered = false;
      try {
        if (req.channel === "line" && context?.ephemeral_line_reply) {
          registerInboundLineReplyContext(req.id, context.ephemeral_line_reply);
          lineReplyContextRegistered = true;
        }
        await handler(req, context);
      } catch (e) {
        const propagateRedacted = this.propagateRedactedHandlerErrorsForRequest?.(req) === true;
        const msg = propagateRedacted || this.redactHandlerErrorsForChannels.has(req.channel)
          ? "details redacted"
          : e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(`[inbound-router] handler threw on ${req.channel}/${req.id}: ${msg}`);
        if (propagateRedacted || this.propagateHandlerErrorsForChannels.has(req.channel)) {
          // Keep the router's existing exception detail out of scheduler logs/cursors.
          throw new Error("inbound_handler_failed");
        }
      } finally {
        if (lineReplyContextRegistered) clearInboundLineReplyContext(req.id);
        for (const image of context?.ephemeral_images ?? []) image.data.fill(0);
        for (const audio of context?.ephemeral_audio ?? []) audio.data.fill(0);
        context?.ephemeral_canvas_artifact?.data.fill(0);
        context?.ephemeral_line_reply?.reply_token?.fill(0);
      }
    };
    this.started = true;
    await Promise.all(
      Array.from(this.channels.values()).map((c) => c.start(wrapped)),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.handler = null;
    await Promise.all(
      Array.from(this.channels.values()).map((c) => c.stop()),
    );
  }

  list(): readonly string[] {
    return Array.from(this.channels.keys());
  }
}
