import type { InboundRequest } from "@blue-tanuki/protocol";

export interface ToolActionRoute {
  type: "tool_call";
  tool_name: string;
  arguments: Record<string, unknown>;
  allowed_capabilities: string[];
  timeout_ms: number;
}

export interface NoopActionRoute {
  type: "noop";
  reason: string;
}

export type ActionRoute = ToolActionRoute | NoopActionRoute | null;

interface ToolSpec {
  allowed_capabilities: string[];
  timeout_ms: number;
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  echo: {
    allowed_capabilities: ["tool:echo"],
    timeout_ms: 5_000,
  },
  "file.search": {
    allowed_capabilities: ["tool:file.search", "fs:read"],
    timeout_ms: 10_000,
  },
  "file.write": {
    allowed_capabilities: ["tool:file.write", "fs:write"],
    timeout_ms: 15_000,
  },
  "file.edit": {
    allowed_capabilities: ["tool:file.edit", "fs:read", "fs:write"],
    timeout_ms: 15_000,
  },
  "http.fetch": {
    allowed_capabilities: ["tool:http.fetch", "network:http"],
    timeout_ms: 15_000,
  },
  "web.search": {
    allowed_capabilities: ["tool:web.search", "network:http"],
    timeout_ms: 15_000,
  },
  "github.read": {
    allowed_capabilities: ["tool:github.read", "network:github.com"],
    timeout_ms: 15_000,
  },
  "github.write": {
    allowed_capabilities: [
      "tool:github.write",
      "network:github.com",
      "secrets:GITHUB_TOKEN",
      "github:issue.write",
      "github:pr.write",
      "github:comment.write",
    ],
    timeout_ms: 15_000,
  },
  "gmail.read": {
    allowed_capabilities: [
      "tool:gmail.read",
      "network:googleapis.com",
      "secrets:GMAIL_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:gmail.read",
    ],
    timeout_ms: 15_000,
  },
  "google.calendar.read": {
    allowed_capabilities: [
      "tool:google.calendar.read",
      "network:googleapis.com",
      "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:calendar.read",
    ],
    timeout_ms: 15_000,
  },
  "google.drive.read": {
    allowed_capabilities: [
      "tool:google.drive.read",
      "network:googleapis.com",
      "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:drive.read",
    ],
    timeout_ms: 15_000,
  },
  "gmail.write": {
    allowed_capabilities: [
      "tool:gmail.write",
      "network:googleapis.com",
      "secrets:GMAIL_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:gmail.write",
      "external:send",
      "email:send",
    ],
    timeout_ms: 15_000,
  },
  "google.calendar.write": {
    allowed_capabilities: [
      "tool:google.calendar.write",
      "network:googleapis.com",
      "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:calendar.write",
    ],
    timeout_ms: 15_000,
  },
  "google.drive.write": {
    allowed_capabilities: [
      "tool:google.drive.write",
      "network:googleapis.com",
      "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:drive.write",
    ],
    timeout_ms: 15_000,
  },
  "composio.search": {
    allowed_capabilities: [
      "tool:composio.search",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
    ],
    timeout_ms: 15_000,
  },
  "composio.execute": {
    allowed_capabilities: [
      "tool:composio.execute",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
      "external:send",
    ],
    timeout_ms: 15_000,
  },
  "browser.read": {
    allowed_capabilities: ["tool:browser.read", "network:http"],
    timeout_ms: 15_000,
  },
  "browser.snapshot": {
    allowed_capabilities: ["tool:browser.snapshot", "browser:snapshot", "network:http"],
    timeout_ms: 15_000,
  },
  "browser.automation": {
    allowed_capabilities: ["tool:browser.automation", "browser:act", "network:http"],
    timeout_ms: 15_000,
  },
  "shell.exec": {
    allowed_capabilities: ["tool:shell.exec", "shell:exec"],
    timeout_ms: 15_000,
  },
  "schedule.list": {
    allowed_capabilities: ["tool:schedule.list", "schedule:read"],
    timeout_ms: 5_000,
  },
  "schedule.create": {
    allowed_capabilities: ["tool:schedule.create", "schedule:create"],
    timeout_ms: 5_000,
  },
  "schedule.update": {
    allowed_capabilities: ["tool:schedule.update", "schedule:update"],
    timeout_ms: 5_000,
  },
  "schedule.delete": {
    allowed_capabilities: ["tool:schedule.delete", "schedule:delete"],
    timeout_ms: 5_000,
  },
};

/**
 * Route explicit tool requests to a bounded command envelope.
 *
 * Supported content forms:
 *   - tool:file.search root=. query=needle max_results=5
 *   - tool:file.write path=notes/today.md content="hello" mode=create
 *   - tool:file.edit path=notes/today.md search=hello replace=hi expected_replacements=1
 *   - tool:http.fetch url=https://example.com method=HEAD
 *   - tool:web.search query="blue tanuki" max_results=5
 *   - tool:github.read resource=issues owner=gatchimuchio repo=blue-tanuki max_results=5
 *   - tool:github.write operation=issue.create owner=gatchimuchio repo=blue-tanuki title="hello" body="world"
 *   - tool:gmail.read query="newer_than:1d" max_results=5
 *   - tool:google.calendar.read calendar_id=primary days=1 max_results=5
 *   - tool:google.drive.read query="trashed=false" max_results=5
 *   - tool:gmail.write operation=draft.create to=owner@example.com subject="hello" body_text="draft"
 *   - tool:google.calendar.write operation=event.create calendar_id=primary summary="Standup" start=2026-05-12T09:00:00Z end=2026-05-12T09:15:00Z
 *   - tool:google.drive.write operation=file.create name=notes.txt content="hello"
 *   - tool:composio.search toolkit=github query=issues
 *   - tool:composio.execute toolkit=github tool=issues.search payload="{...}"
 *   - tool:browser.read url=https://example.com max_chars=4000
 *   - tool:browser.snapshot url=https://example.com max_chars=4000
 *   - tool:browser.automation action=smoke
 *   - tool:browser.automation action=navigate url=https://example.com
 *   - tool:shell.exec {"cmd":"git","args":["status","-sb"],"cwd":"."}
 *   - tool:schedule.list
 *   - tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
 *   - tool:schedule.update id=<id> content="updated smoke"
 *   - tool:schedule.delete id=<id>
 *   - /tool echo text="hello"
 *   - tool:http.fetch {"url":"https://example.com","method":"GET"}
 *
 * Supported metadata forms:
 *   - metadata["blue_tanuki.tool_call"] = { tool_name, arguments }
 *   - metadata.tool_call = { tool_name, arguments }
 */
export function routeAction(req: InboundRequest): ActionRoute {
  const fromMetadata = routeMetadata(req);
  if (fromMetadata) return fromMetadata;
  return routeContent(req.content);
}

function routeMetadata(req: InboundRequest): ActionRoute {
  const raw =
    req.metadata?.["blue_tanuki.tool_call"] ?? req.metadata?.["tool_call"];
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    return { type: "noop", reason: "tool_call metadata must be an object" };
  }
  const toolName = stringField(raw, "tool_name") ?? stringField(raw, "tool");
  if (!toolName) {
    return { type: "noop", reason: "tool_call metadata missing tool_name" };
  }
  const argsRaw = raw.arguments ?? raw.args ?? {};
  if (!isRecord(argsRaw)) {
    return { type: "noop", reason: "tool_call metadata arguments must be an object" };
  }
  return buildToolRoute(toolName, { ...argsRaw });
}

function routeContent(content: string): ActionRoute {
  const trimmed = content.trim();
  const match = /^(?:tool:([A-Za-z0-9_.-]+)|\/tool\s+([A-Za-z0-9_.-]+))(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const toolName = match[1] ?? match[2] ?? "";
  const rest = (match[3] ?? "").trim();
  let args: Record<string, unknown>;
  try {
    args = parseArgs(rest);
  } catch (e) {
    return {
      type: "noop",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  return buildToolRoute(toolName, args);
}

function buildToolRoute(
  toolName: string,
  args: Record<string, unknown>,
): ActionRoute {
  const spec = TOOL_SPECS[toolName];
  if (!spec) {
    return { type: "noop", reason: `unsupported tool: ${toolName}` };
  }
  return {
    type: "tool_call",
    tool_name: toolName,
    arguments: coerceToolArgs(toolName, args),
    allowed_capabilities: [...spec.allowed_capabilities],
    timeout_ms: spec.timeout_ms,
  };
}

function parseArgs(rest: string): Record<string, unknown> {
  if (!rest) return {};
  if (rest.startsWith("{")) {
    const parsed = JSON.parse(rest) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("tool arguments JSON must be an object");
    }
    return { ...parsed };
  }
  const out: Record<string, unknown> = {};
  for (const token of tokenize(rest)) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new Error(`tool argument must be key=value: ${token}`);
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quoted tool argument");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function coerceToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if (
    toolName === "file.search" ||
    toolName === "web.search" ||
    toolName === "github.read" ||
    toolName === "gmail.read" ||
    toolName === "google.calendar.read" ||
    toolName === "google.drive.read"
  ) {
    coercePositiveInt(next, "max_results");
  }
  if (
    toolName === "http.fetch" ||
    toolName === "web.search" ||
    toolName === "github.read" ||
    toolName === "github.write" ||
    toolName === "gmail.read" ||
    toolName === "google.calendar.read" ||
    toolName === "google.drive.read" ||
    toolName === "gmail.write" ||
    toolName === "google.calendar.write" ||
    toolName === "google.drive.write" ||
    toolName === "browser.read" ||
    toolName === "browser.snapshot" ||
    toolName === "browser.automation" ||
    toolName === "file.write" ||
    toolName === "file.edit" ||
    toolName === "shell.exec" ||
    toolName === "schedule.create" ||
    toolName === "schedule.update"
  ) {
    coercePositiveInt(next, "max_bytes");
  }
  if (toolName === "shell.exec") {
    coercePositiveInt(next, "timeout_ms");
  }
  if (
    toolName === "browser.read" ||
    toolName === "browser.snapshot" ||
    toolName === "browser.automation"
  ) {
    coercePositiveInt(next, "max_chars");
  }
  if (toolName === "browser.snapshot" || toolName === "browser.automation") {
    coercePositiveInt(next, "timeout_ms");
  }
  if (toolName === "github.read" || toolName === "github.write") {
    coercePositiveInt(next, "number");
  }
  if (toolName === "google.calendar.read") {
    coercePositiveInt(next, "days");
  }
  if (toolName === "google.drive.write") {
    coercePositiveInt(next, "max_content_bytes");
  }
  if (toolName === "file.edit") {
    coercePositiveInt(next, "expected_replacements");
  }
  if (toolName === "schedule.create" || toolName === "schedule.update") {
    coercePositiveInt(next, "interval_ms");
  }
  if (toolName === "http.fetch") {
    if (typeof next.method === "string") {
      next.method = next.method.toUpperCase();
    }
  }
  return next;
}

function coercePositiveInt(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    args[key] = parseInt(value, 10);
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
