interface VariableSpec {
  readonly name: string;
  readonly prefix_length?: number;
}

interface TemplateExpression {
  readonly operator: "" | "+" | "#" | "." | "/" | ";" | "?" | "&";
  readonly variables: readonly VariableSpec[];
}

interface ParsedTemplate {
  readonly parts: readonly (string | TemplateExpression)[];
  readonly variable_names: readonly string[];
}

const OPERATORS = new Set(["+", "#", ".", "/", ";", "?", "&"]);
const RESERVED = new Set(Array.from(":/?#[]@!$&'()*+,;="));

/** Returns the bounded scalar variables accepted by the MCP read path, or null for unsupported syntax. */
export function mcpUriTemplateVariableNames(template: string): readonly string[] | null {
  return parseTemplate(template)?.variable_names ?? null;
}

/** Expands a bounded RFC 6570 scalar template. Lists, maps, and malformed expressions fail closed. */
export function expandMcpUriTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
): string | null {
  const parsed = parseTemplate(template);
  if (!parsed) return null;
  const suppliedNames = Object.keys(values).sort();
  if (suppliedNames.join("\0") !== [...parsed.variable_names].sort().join("\0")) return null;
  for (const name of parsed.variable_names) {
    if (typeof values[name] !== "string" || (values[name] as string).length > 4_096) return null;
  }

  const output: string[] = [];
  for (const part of parsed.parts) {
    if (typeof part === "string") {
      output.push(part);
      continue;
    }
    const config = operatorConfig(part.operator);
    const expanded: string[] = [];
    for (const variable of part.variables) {
      const value = values[variable.name] as string;
      const boundedValue = variable.prefix_length === undefined
        ? value
        : Array.from(value).slice(0, variable.prefix_length).join("");
      const encoded = encodeTemplateValue(boundedValue, config.allow_reserved);
      if (config.named) {
        const encodedName = encodeTemplateValue(variable.name, false);
        expanded.push(boundedValue.length === 0 && part.operator === ";"
          ? encodedName
          : `${encodedName}=${encoded}`);
      } else {
        expanded.push(encoded);
      }
    }
    output.push(expanded.length > 0 ? `${config.prefix}${expanded.join(config.separator)}` : "");
  }

  const uri = output.join("");
  if (Buffer.byteLength(uri, "utf8") > 8_192 || !isValidMcpResourceUri(uri)) return null;
  return uri;
}

function parseTemplate(template: string): ParsedTemplate | null {
  if (template.length < 1 || template.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(template)) return null;
  const parts: (string | TemplateExpression)[] = [];
  const variableNames = new Set<string>();
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{", cursor);
    const strayClose = template.indexOf("}", cursor);
    if (strayClose >= 0 && (open < 0 || strayClose < open)) return null;
    if (open < 0) {
      parts.push(template.slice(cursor));
      cursor = template.length;
      break;
    }
    if (open > cursor) parts.push(template.slice(cursor, open));
    const close = template.indexOf("}", open + 1);
    if (close < 0 || template.indexOf("{", open + 1) >= 0 && template.indexOf("{", open + 1) < close) return null;
    const expression = parseExpression(template.slice(open + 1, close));
    if (!expression) return null;
    for (const variable of expression.variables) variableNames.add(variable.name);
    parts.push(expression);
    cursor = close + 1;
  }
  if (parts.length === 0 || variableNames.size === 0) return null;
  const validationUri = template.replace(/\{[^{}]+\}/gu, "x");
  if (!isValidMcpResourceUri(validationUri)) return null;
  return { parts, variable_names: [...variableNames].sort() };
}

function isValidMcpResourceUri(uri: string): boolean {
  if (/[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/u.test(uri) || /%(?![0-9a-f]{2})/iu.test(uri) ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) || /[{}]/u.test(uri)) return false;
  try {
    // URI parsing is validation only; the value is sent to the already configured MCP server.
    const parsed = new URL(uri);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function parseExpression(source: string): TemplateExpression | null {
  if (!source) return null;
  let operator: TemplateExpression["operator"] = "";
  if (OPERATORS.has(source[0]!)) {
    operator = source[0] as TemplateExpression["operator"];
    source = source.slice(1);
  }
  if (!source) return null;
  const variables: VariableSpec[] = [];
  for (const raw of source.split(",")) {
    let name = raw;
    let prefixLength: number | undefined;
    if (name.endsWith("*")) return null;
    const prefix = name.match(/^(.*):([0-9]{1,4})$/u);
    if (prefix) {
      name = prefix[1]!;
      prefixLength = Number(prefix[2]);
      if (prefixLength < 1 || prefixLength > 4_096) return null;
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/u.test(name)) return null;
    variables.push({ name, ...(prefixLength === undefined ? {} : { prefix_length: prefixLength }) });
  }
  return variables.length > 0 ? { operator, variables } : null;
}

function operatorConfig(operator: TemplateExpression["operator"]) {
  switch (operator) {
    case "+": return { prefix: "", separator: ",", named: false, allow_reserved: true };
    case "#": return { prefix: "#", separator: ",", named: false, allow_reserved: true };
    case ".": return { prefix: ".", separator: ".", named: false, allow_reserved: false };
    case "/": return { prefix: "/", separator: "/", named: false, allow_reserved: false };
    case ";": return { prefix: ";", separator: ";", named: true, allow_reserved: false };
    case "?": return { prefix: "?", separator: "&", named: true, allow_reserved: false };
    case "&": return { prefix: "&", separator: "&", named: true, allow_reserved: false };
    default: return { prefix: "", separator: ",", named: false, allow_reserved: false };
  }
}

function encodeTemplateValue(value: string, allowReserved: boolean): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!allowReserved) return encoded;
  return encoded.replace(/%(3A|2F|3F|23|5B|5D|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/giu,
    (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16))
      .replace(/[\u0000-\u007f]/u, (character) => RESERVED.has(character) ? character : escape));
}
