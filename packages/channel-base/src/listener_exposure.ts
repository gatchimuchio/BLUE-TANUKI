import { isIP } from "node:net";

/** 実bind経路に現在の内容結合L3審査が接続されるまでloopback hostだけを許す。 */
export function isLoopbackListenerHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized === "localhost.") return true;
  const family = isIP(normalized);
  if (family === 4) return Number(normalized.split(".", 1)[0]) === 127;
  return family === 6 && normalized === "::1";
}

/** loopback以外の実bindを、L3 gate未接続として拒否する。 */
export function assertLoopbackListenerHost(host: string): void {
  if (!isLoopbackListenerHost(host)) {
    throw new Error("network_listener_l3_gate_unavailable");
  }
}
