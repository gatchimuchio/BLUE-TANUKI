import type { CheckDraft, CheckStatus, Remediation } from "./doctor.js";

const MIN_NODE_VERSION = "22.14.0";

function statusFromLevel(level: CheckDraft["level"]): CheckStatus {
  return level === "warn" ? "warning" : level;
}

export function remediationFor(check: CheckDraft): Remediation {
  const ok = check.level === "ok";
  const defaultOk = {
    cause: check.detail,
    impact: "No owner action is required.",
    next_action: "Continue.",
    doc_ref: "docs/FIRST_RUN_CHECKLIST.md",
    safe_to_ignore: true,
  };
  if (ok) return defaultOk;

  const statusWord = statusFromLevel(check.level);
  const defaultProblem = {
    cause: check.detail,
    impact: `${check.label} is ${statusWord}; affected capability may be unavailable or unsafe.`,
    next_action: "Inspect the check detail, correct configuration, then rerun pnpm run doctor.",
    doc_ref: "TROUBLESHOOTING.md",
    safe_to_ignore: false,
  };

  if (check.id === "node_version") {
    return {
      cause: check.detail,
      impact: "Gateway scripts may fail before BLUE-TANUKI can start.",
      next_action: `Install Node.js ${MIN_NODE_VERSION} or newer, then rerun pnpm install and pnpm run doctor.`,
      doc_ref: "docs/FIRST_RUN_CHECKLIST.md#1-前提",
      safe_to_ignore: false,
    };
  }

  if (check.id === "env:WEBCHAT_TOKEN") {
    return {
      cause: check.detail,
      impact: "WebChat inbound and Control Center read APIs cannot be used safely.",
      next_action: "Run pnpm run setup -- --yes or set WEBCHAT_TOKEN to a distinct random value, then restart.",
      doc_ref: "docs/CREDENTIAL_READINESS_MATRIX.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "env:WEBCHAT_RESUME_TOKEN") {
    return {
      cause: check.detail,
      impact: "Approval and resume operations cannot be safely authorized.",
      next_action: "Run pnpm run setup -- --yes or set WEBCHAT_RESUME_TOKEN to a distinct random value, then restart.",
      doc_ref: "docs/CREDENTIAL_READINESS_MATRIX.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "webchat_token_separation") {
    return {
      cause: check.detail,
      impact: "Inbound access could be reused for approval if the tokens are not separated.",
      next_action: "Generate a new WEBCHAT_RESUME_TOKEN that differs from WEBCHAT_TOKEN, then restart.",
      doc_ref: "SECURITY.md#ApprovalRisk-and-ApprovalLevel",
      safe_to_ignore: false,
    };
  }

  if (check.id === "settings_token") {
    return {
      cause: check.detail,
      impact: "Settings writes may be disabled or unsafe if the token is weak or reused.",
      next_action: "Leave BLUE_TANUKI_SETTINGS_TOKEN unset to disable settings, or set a unique secret and restart.",
      doc_ref: "docs/CREDENTIAL_READINESS_MATRIX.md",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "webhook_token") {
    return {
      cause: check.detail,
      impact: "Webhook ingress may be disabled or unsafe if the token is weak or reused.",
      next_action: "Leave WEBHOOK_TOKEN unset to disable /webhook, or set a unique secret and restart.",
      doc_ref: "CONFIG.md#Webhook-ingress",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (
    check.id === "env:SLACK_BOT_TOKEN" ||
    check.id === "env:SLACK_APP_TOKEN" ||
    check.id === "env:DISCORD_BOT_TOKEN" ||
    check.id === "env:MICROSOFT_GRAPH_ACCESS_TOKEN" ||
    check.id === "env:LINE_CHANNEL_ACCESS_TOKEN" ||
    check.id === "env:ANTHROPIC_API_KEY" ||
    check.id === "env:OPENROUTER_API_KEY" ||
    check.id === "env:COMPOSIO_API_KEY" ||
    check.id === "env:GITHUB_TOKEN" ||
    check.id === "env:BLUE_TANUKI_GITHUB_REPOS"
  ) {
    const name = check.id.slice("env:".length);
    return {
      cause: `${name} is optional and currently ${check.detail}.`,
      impact: "The related preview channel, live smoke path, or external write tool may be skipped; WebChat and HDS authority remain usable.",
      next_action: `Leave ${name} unset if unused, or set it and rerun the relevant smoke/doctor command.`,
      doc_ref: "docs/CREDENTIAL_READINESS_MATRIX.md",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "llm_backend" || check.id === "llm_command_route") {
    return {
      cause: check.detail,
      impact: "Downstream LLM execution may fail, but HDS-BRAIN authority remains upstream.",
      next_action: "Use LLM_BACKEND=stub for offline mode, or fix the configured provider/model/endpoint/key.",
      doc_ref: "CONFIG.md#Optional-LLM",
      safe_to_ignore: false,
    };
  }

  if (check.id === "composio_connector") {
    return {
      cause: check.detail,
      impact: "Composio tools remain unavailable or fail closed; live execution also requires explicit user id, toolkit/action allowlists, live opt-in, and HDS final review. Local/native tools and HDS authority remain usable.",
      next_action: "Leave Composio unset if unused, or set COMPOSIO_API_KEY and COMPOSIO_ALLOWED_TOOLKITS in the user env file.",
      doc_ref: "docs/COMPOSIO_CONNECTOR.md",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "cron_schedules") {
    return {
      cause: check.detail,
      impact: "Boot-time scheduled messages may not register.",
      next_action: "Fix BLUE_TANUKI_SCHEDULES_JSON or remove it, then rerun pnpm run doctor.",
      doc_ref: "CONFIG.md#Generic-scheduled-messages",
      safe_to_ignore: false,
    };
  }

  if (check.id === "google_daily_brief_source") {
    return {
      cause: check.detail,
      impact: "Daily Brief Google summaries may be unavailable; no Google write operation is attempted.",
      next_action: "Leave BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED unset if unused, or set read-only Google OAuth tokens and rerun pnpm run doctor.",
      doc_ref: "CONFIG.md#Google-read-tools-and-Daily-Brief-source",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "session_dir") {
    return {
      cause: check.detail,
      impact: "Session continuity may be lost or gateway startup may fail.",
      next_action: "Set BLUE_TANUKI_SESSION_DIR to a writable directory or leave it unset for memory-only sessions.",
      doc_ref: "docs/PERMANENT_USE_CHECKLIST.md#Startup",
      safe_to_ignore: false,
    };
  }

  if (check.id === "audit_dir") {
    return {
      cause: check.detail,
      impact: "Persistent hash-chain audit may be unavailable.",
      next_action: "Set BLUE_TANUKI_AUDIT_DIR to a writable persistent directory, then rerun audit verification.",
      doc_ref: "AUDIT.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "file_root") {
    return {
      cause: check.detail,
      impact: "file.search/file.write/file.edit may be disabled or fail closed.",
      next_action: "Set BLUE_TANUKI_FILE_ROOT to the intended writable sandbox root, or leave it unset to disable file tools.",
      doc_ref: "CONFIG.md#File-tools",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "shell_root") {
    return {
      cause: check.detail,
      impact: "shell.exec may be disabled or fail closed.",
      next_action: "Set BLUE_TANUKI_SHELL_ROOT to the intended command root, or leave it unset to disable shell.exec.",
      doc_ref: "CONFIG.md#Shell-exec-tool",
      safe_to_ignore: check.level === "warn",
    };
  }

  if (check.id === "manifests") {
    return {
      cause: check.detail,
      impact: "Plugin/channel/tool registration may be unsafe or unavailable.",
      next_action: "Fix the listed manifest/package drift before starting serve mode.",
      doc_ref: "docs/CONFORMANCE.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "compatibility_matrix") {
    return {
      cause: check.detail,
      impact: "Release scope or preview quarantine may be inconsistent.",
      next_action: "Fix docs/compatibility-matrix.json, channel docs, or promotion evidence, then rerun pnpm validate:channels and pnpm run doctor.",
      doc_ref: "docs/CHANNEL_PROMOTION_GATE.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "distribution_readiness") {
    return {
      cause: check.detail,
      impact: "Install, update, rollback, uninstall, channel promotion, plugin review, GA promotion, or release verification guidance may be incomplete for operators.",
      next_action: "Fix the listed distribution docs or release scripts, then rerun pnpm run doctor, pnpm validate:packaging, pnpm validate:ga, and pnpm plugin:review where relevant.",
      doc_ref: "docs/phase10-s3-distribution-ux-hardening.md",
      safe_to_ignore: false,
    };
  }

  if (check.id === "port") {
    return {
      cause: check.detail,
      impact: "WebChat Control Center cannot bind to the configured address.",
      next_action: "Stop the process using the port or set WEBCHAT_PORT/WEBCHAT_HOST to an available loopback address.",
      doc_ref: "TROUBLESHOOTING.md",
      safe_to_ignore: false,
    };
  }

  return defaultProblem;
}
