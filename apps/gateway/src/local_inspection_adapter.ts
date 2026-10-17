import { parseLocalInspectionResponse, type LocalInspectionResponse } from "./external_receipt_observation.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;

function inspectionEndpoint(value: string): URL {
  if (value.length > 2_048 || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value)) {
    throw new Error("local_inspection_endpoint_invalid");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("local_inspection_endpoint_invalid"); }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535 || url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("local_inspection_endpoint_invalid");
  }
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* preserve the bounded-response error */ }
    throw new Error("local_inspection_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("local_inspection_response_empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* preserve the bounded-response error */ }
        throw new Error("local_inspection_response_too_large");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "local_inspection_response_too_large") throw error;
    throw new Error("local_inspection_response_read_failed");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("local_inspection_response_invalid"); }
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("local_inspection_response_invalid"); }
}

/** Query only the synthetic loopback inspection service. This adapter cannot reach a provider or follow redirects. */
export async function queryLocalInspectionReceipt(
  endpoint: string,
  idempotencyKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LocalInspectionResponse> {
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("local_inspection_request_invalid");
  }
  const base = inspectionEndpoint(endpoint);
  const url = new URL(`/reconcile/${idempotencyKey}`, base);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-store" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("local_inspection_request_failed");
  }
  if (response.status !== 200) {
    try { await response.body?.cancel(); } catch { /* preserve the status error */ }
    throw new Error("local_inspection_response_status_invalid");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    try { await response.body?.cancel(); } catch { /* preserve the content-type error */ }
    throw new Error("local_inspection_response_content_type_invalid");
  }
  return parseLocalInspectionResponse(await readBoundedJson(response));
}
