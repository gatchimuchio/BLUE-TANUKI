import { createServer, type Server } from "node:http";
import {
  AgentApplication,
  AuthType,
  CloudAdapter,
  OutboundHostValidator,
  type AuthConfiguration,
  type TurnContext,
} from "@microsoft/agents-hosting";
import { createAgentRequestHandler } from "@microsoft/agents-hosting-express";
import express, { type NextFunction, type Request, type Response } from "express";
import type {
  TeamsConversationType,
  TeamsFetch,
  TeamsInboundHandler,
  TeamsInboundMessage,
  TeamsPostResult,
  TeamsTransport,
} from "./transport.js";
import { TeamsGraphTransport } from "./transport.js";

export interface TeamsAgentCredentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly tenant_id: string;
}

export interface TeamsAgentsTransportOptions {
  readonly credentials: TeamsAgentCredentials;
  readonly graph_access_token?: string;
  readonly fetch?: TeamsFetch;
  readonly host?: string;
  readonly port?: number;
  readonly route?: string;
  readonly log?: (line: string) => void;
}

const DEFAULT_AGENT_HOST = "127.0.0.1";
const DEFAULT_AGENT_PORT = 3978;
const DEFAULT_AGENT_ROUTE = "/api/messages";
const MAX_ACTIVITY_BODY = "256kb";

/** Authenticated Microsoft 365 Agents SDK ingress combined with the existing Graph sender. */
export class TeamsAgentsTransport implements TeamsTransport {
  private readonly graph: TeamsGraphTransport | null;
  private server: Server | null = null;
  private listeningPort: number | null = null;

  constructor(private readonly opts: TeamsAgentsTransportOptions) {
    validateCredentials(opts.credentials);
    if (opts.graph_access_token) {
      this.graph = new TeamsGraphTransport({
        access_token: opts.graph_access_token,
        fetch: opts.fetch,
      });
    } else {
      this.graph = null;
    }
    validateListenerOptions(opts);
  }

  async start(handler: TeamsInboundHandler): Promise<void> {
    if (this.server) return;

    const credentials = this.opts.credentials;
    const auth = createTeamsAuthConfiguration(credentials);
    const adapter = new CloudAdapter(
      auth,
      undefined,
      undefined,
      { validateServiceUrl: true },
      new OutboundHostValidator({ enabled: true }),
    );
    const agent = new AgentApplication({ adapter });
    agent.onError(async () => {
      this.opts.log?.("[teams] authenticated activity processing failed");
    });
    agent.onActivity("message", async (context) => {
      const message = teamsMessageFromActivity(context.activity);
      if (message) await handler(message);
    });

    const requestHandler = createAgentRequestHandler(agent, auth);
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: MAX_ACTIVITY_BODY, strict: true, type: "application/json" }));
    app.post(this.opts.route ?? DEFAULT_AGENT_ROUTE, (request, response) => {
      void requestHandler(request, response).catch(() => {
        this.opts.log?.("[teams] authenticated request handler failed");
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.status(500).json({ error: "teams_activity_processing_failed" });
      });
    });
    app.use((_request: Request, response: Response) => response.status(404).json({ error: "not_found" }));
    app.use((error: Error & { status?: number }, _request: Request, response: Response, _next: NextFunction) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.status(error.status === 413 ? 413 : 400).json({ error: "invalid_agent_request" });
    });

    const server = createServer(app);
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on("error", () => this.opts.log?.("[teams] authenticated ingress server error"));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.opts.port ?? DEFAULT_AGENT_PORT, this.opts.host ?? DEFAULT_AGENT_HOST);
    });
    this.server = server;
    const address = server.address();
    this.listeningPort = address && typeof address === "object" ? address.port : null;
    this.opts.log?.(`[teams] authenticated agent ingress listening host=${this.opts.host ?? DEFAULT_AGENT_HOST} port=${this.listeningPort ?? "unknown"}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  getListeningPort(): number | null {
    return this.listeningPort;
  }

  async postMessage(args: { target: string; text: string }, signal?: AbortSignal): Promise<TeamsPostResult> {
    if (!this.graph) {
      return {
        ok: false,
        error: "teams_graph_access_token_unset",
        error_kind: "non_recoverable",
        error_code: "teams_not_configured",
      };
    }
    return await this.graph.postMessage(args, signal);
  }
}

/** Map a JWT-authenticated Teams message activity into the adapter's minimal input. */
export function teamsMessageFromActivity(activity: TurnContext["activity"]): TeamsInboundMessage | null {
  if (activity.type !== "message" || activity.channelId !== "msteams") return null;
  const conversation = activity.conversation;
  const sender = activity.from;
  if (!conversation || !sender || activity.attachments?.length) return null;
  if (sender.role !== undefined && sender.role !== "user") return null;
  if (!isSafeIdentifier(activity.id) || !isSafeIdentifier(sender.id) || !isSafeIdentifier(conversation.id)) return null;
  if (activity.recipient?.id && activity.recipient.id === sender.id) return null;
  if (typeof activity.text !== "string" || !activity.text.trim()) return null;

  const conversationType = conversation.conversationType;
  if (!isTeamsConversationType(conversationType)) return null;

  const channelData = asRecord(activity.channelData);
  const tenantData = asRecord(channelData?.tenant);
  const tenantId = readString(tenantData, "id");
  if (!isTenantId(tenantId)) return null;
  if (conversation.tenantId && !sameTenantId(conversation.tenantId, tenantId)) return null;
  if (sender.tenantId && !sameTenantId(sender.tenantId, tenantId)) return null;

  const team = asRecord(channelData?.team);
  const channel = asRecord(channelData?.channel);
  const teamId = readString(team, "id");
  const channelId = readString(channel, "id");
  if (conversationType === "channel") {
    if (!isSafeIdentifier(teamId) || !isSafeIdentifier(channelId)) return null;
  } else if (team !== null || channel !== null) {
    return null;
  }

  const result: TeamsInboundMessage = {
    tenant_id: tenantId.toLowerCase(),
    conversation_id: conversation.id,
    conversation_type: conversationType,
    user_id: sender.id,
    text: activity.text,
    message_id: activity.id,
  };
  if (teamId && channelId) {
    result.team_id = teamId;
    result.channel_id = channelId;
    result.reply_to_message_id = activity.id;
  }
  return result;
}

export function createTeamsAuthConfiguration(credentials: TeamsAgentCredentials): AuthConfiguration {
  validateCredentials(credentials);
  const connectionName = "blueTanukiTeamsService";
  const settings: AuthConfiguration = {
    authType: AuthType.ClientSecret,
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    tenantId: credentials.tenant_id,
    scopes: ["https://api.botframework.com/.default"],
    validateIssuer: true,
  };
  return {
    connections: new Map([[connectionName, settings]]),
    connectionsMap: [{ serviceUrl: "*", audience: credentials.client_id, connection: connectionName }],
  };
}

function validateCredentials(credentials: TeamsAgentCredentials): void {
  if (!isUuid(credentials.client_id) || !isUuid(credentials.tenant_id) ||
      typeof credentials.client_secret !== "string" || credentials.client_secret.trim().length < 1 ||
      credentials.client_secret.length > 4096 || /[\r\n]/u.test(credentials.client_secret)) {
    throw new Error("teams_agent_auth_configuration_invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function validateListenerOptions(options: TeamsAgentsTransportOptions): void {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error("teams_agent_listener_port_invalid");
  }
  if (options.host !== undefined && options.host !== "127.0.0.1" && options.host !== "::1") {
    throw new Error("teams_agent_listener_host_must_be_loopback");
  }
  const route = options.route ?? DEFAULT_AGENT_ROUTE;
  if (!route.startsWith("/") || route.startsWith("//") || /[?#\r\n]/u.test(route)) {
    throw new Error("teams_agent_listener_route_invalid");
  }
}

function isTeamsConversationType(value: unknown): value is TeamsConversationType {
  return value === "personal" || value === "groupChat" || value === "channel";
}

function isTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function sameTenantId(left: string, right: string): boolean {
  return isTenantId(left) && isTenantId(right) && left.toLowerCase() === right.toLowerCase();
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return isSafeIdentifier(value) ? value : undefined;
}
