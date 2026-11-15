import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDSPrivateAppendOnlyFile } from "../src/private_append_only_file.js";

describe("HDSPrivateAppendOnlyFile", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("creates nested private storage and reads back a first append", () => {
    root = mkdtempSync(join(tmpdir(), "hds-private-append-"));
    const filepath = join(root, "state", "private", "records.jsonl");
    const storage = new HDSPrivateAppendOnlyFile(filepath);

    storage.appendUtf8("{\"record\":1}\n");

    expect(readFileSync(filepath, "utf8")).toBe("{\"record\":1}\n");
    expect(new HDSPrivateAppendOnlyFile(filepath).readUtf8IfPresent()).toBe("{\"record\":1}\n");
  });
});
