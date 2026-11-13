import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";

const BASE64_LINE_LENGTH = 76;
const READ_CHUNK_SIZE = 64 * 1024;

export function* readUtf8LinesSync(filepath: string): Generator<string> {
  const fd = openSync(filepath, "r");
  const chunk = Buffer.alloc(READ_CHUNK_SIZE);
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const data = pending.length === 0
        ? chunk.subarray(0, count)
        : Buffer.concat([pending, chunk.subarray(0, count)]);
      let start = 0;
      while (true) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        let line = data.subarray(start, newline);
        if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
        yield line.toString("utf8");
        start = newline + 1;
      }
      pending = Buffer.from(data.subarray(start));
    }
    if (pending.length > 0) {
      let line = pending;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      yield line.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}

export function sha256FileSync(filepath: string): string {
  const fd = openSync(filepath, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  const hash = createHash("sha256");
  try {
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function hashEmbeddedBase64PayloadSync(
  filepath: string,
  marker: string,
): { sha256: string; sizeBytes: number } {
  const hash = createHash("sha256");
  let foundMarker = false;
  let sawPayload = false;
  let sawPadding = false;
  let sizeBytes = 0;

  for (const line of readUtf8LinesSync(filepath)) {
    if (!foundMarker) {
      if (line === marker) foundMarker = true;
      continue;
    }
    if (line.length === 0) continue;
    if (line.length > BASE64_LINE_LENGTH || line.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(line) || sawPadding) {
      throw new Error(`embedded payload contains invalid Base64 text: ${filepath}`);
    }
    const decoded = Buffer.from(line, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== line) {
      throw new Error(`embedded payload contains non-canonical Base64 text: ${filepath}`);
    }
    if (line.includes("=")) sawPadding = true;
    sawPayload = true;
    sizeBytes += decoded.length;
    hash.update(decoded);
  }

  if (!foundMarker) throw new Error(`embedded payload marker missing: ${filepath}`);
  if (!sawPayload) throw new Error(`embedded payload is empty: ${filepath}`);
  return { sha256: hash.digest("hex"), sizeBytes };
}

export function readTextBeforeEmbeddedPayloadSync(filepath: string, marker: string): string {
  const lines: string[] = [];
  let sizeBytes = 0;
  for (const line of readUtf8LinesSync(filepath)) {
    if (line === marker) return `${lines.join("\n")}\n`;
    sizeBytes += Buffer.byteLength(line, "utf8") + 1;
    if (sizeBytes > 1024 * 1024) {
      throw new Error(`installer preamble exceeds the expected bounded size: ${filepath}`);
    }
    lines.push(line);
  }
  throw new Error(`embedded payload marker missing: ${filepath}`);
}

async function* encodedPayloadLines(payloadPath: string, lineEnding: string): AsyncGenerator<string> {
  let remainder = Buffer.alloc(0);
  let pendingLine = "";

  for await (const chunkValue of createReadStream(payloadPath)) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    const combined = remainder.length === 0 ? chunk : Buffer.concat([remainder, chunk]);
    const encodedByteCount = combined.length - (combined.length % 3);
    if (encodedByteCount === 0) {
      remainder = Buffer.from(combined);
      continue;
    }
    pendingLine += combined.subarray(0, encodedByteCount).toString("base64");
    remainder = Buffer.from(combined.subarray(encodedByteCount));
    while (pendingLine.length >= BASE64_LINE_LENGTH) {
      yield `${pendingLine.slice(0, BASE64_LINE_LENGTH)}${lineEnding}`;
      pendingLine = pendingLine.slice(BASE64_LINE_LENGTH);
    }
  }

  if (remainder.length > 0) pendingLine += remainder.toString("base64");
  if (pendingLine.length > 0) yield `${pendingLine}${lineEnding}`;
}

export async function writeEmbeddedPayloadInstaller(
  outputPath: string,
  header: string,
  payloadPath: string,
  lineEnding: string,
): Promise<void> {
  const absoluteOutputPath = path.resolve(outputPath);
  const absolutePayloadPath = path.resolve(payloadPath);
  await pipeline(
    Readable.from((async function* () {
      yield header;
      yield* encodedPayloadLines(absolutePayloadPath, lineEnding);
    })()),
    createWriteStream(absoluteOutputPath, { flags: "w" }),
  );
}
