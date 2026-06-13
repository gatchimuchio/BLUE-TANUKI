const SECRET_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|authorization|bearer|credential|private[_-]?key)/i;
const CONTENT_KEY_PATTERN = /^(?:content|rendered_output|raw_output|payload|messages|result|api_key)$/i;

export interface EvidenceRedactionScan {
  ok: boolean;
  findings: string[];
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key|credential|private[_-]?key)["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1[redacted]")
    .replace(/("(?:content|rendered_output|raw_output|payload|messages)"\s*:\s*)"([^"\\]|\\.)*"/gi, "$1\"[redacted]\"")
    .replace(/("(?:result)"\s*:\s*)\{[^}\n]*\}/gi, "$1\"[redacted]\"");
}

export function redactEvidenceValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (input: unknown, key = ""): unknown => {
    if (typeof input === "string") {
      if (SECRET_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key)) return "[redacted]";
      return redactEvidenceText(input);
    }
    if (typeof input !== "object" || input === null) return input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => visit(item, key));
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(input as Record<string, unknown>)) {
      output[entryKey] = SECRET_KEY_PATTERN.test(entryKey) || CONTENT_KEY_PATTERN.test(entryKey)
        ? redactSecretLikeField(entryValue)
        : visit(entryValue, entryKey);
    }
    return output;
  };
  return visit(value);
}

export function scanEvidenceForSecrets(
  value: unknown,
  forbiddenValues: readonly string[] = [],
): EvidenceRedactionScan {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const findings: string[] = [];
  for (const forbidden of forbiddenValues) {
    if (forbidden.length > 0 && text.includes(forbidden)) {
      findings.push(`forbidden_value:${fingerprint(forbidden)}`);
    }
  }
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text)) findings.push("bearer_token");
  if (/"(?:token|secret|password|api_key|apiKey)"\s*:\s*"(?!\[redacted\])[^"]{8,}"/i.test(text)) {
    findings.push("secret_key_value");
  }
  return { ok: findings.length === 0, findings };
}

function redactSecretLikeField(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(() => "[redacted]");
  if (typeof value === "object") return "[redacted]";
  return "[redacted]";
}

function fingerprint(value: string): string {
  return `${value.length}:${value.slice(0, 2)}...${value.slice(-2)}`;
}
