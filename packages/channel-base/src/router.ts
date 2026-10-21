import type { InboundRequest } from "@blue-tanuki/protocol";
import type { InboundChannel, InboundEphemeralContext, InboundHandler } from "./types.js";

export interface InboundRouterOptions {
  /** Channels whose scheduler must observe handler failure to persist an unknown outcome. */
  readonly propagateHandlerErrorsForChannels?: readonly string[];
  /** Channels whose handler error details may contain external provider or user data. */
  readonly redactHandlerErrorsForChannels?: readonly string[];
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
  private started = false;
  private handler: InboundHandler | null = null;

  constructor(options: InboundRouterOptions = {}) {
    this.propagateHandlerErrorsForChannels = new Set(options.propagateHandlerErrorsForChannels ?? []);
    this.redactHandlerErrorsForChannels = new Set(options.redactHandlerErrorsForChannels ?? []);
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
      try {
        await handler(req, context);
      } catch (e) {
        const msg = this.redactHandlerErrorsForChannels.has(req.channel)
          ? "details redacted"
          : e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(`[inbound-router] handler threw on ${req.channel}/${req.id}: ${msg}`);
        if (this.propagateHandlerErrorsForChannels.has(req.channel)) {
          // Keep the router's existing exception detail out of scheduler logs/cursors.
          throw new Error("inbound_handler_failed");
        }
      } finally {
        for (const image of context?.ephemeral_images ?? []) image.data.fill(0);
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
