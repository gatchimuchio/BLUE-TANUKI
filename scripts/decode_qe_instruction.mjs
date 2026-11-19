import { createHash } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// BT6.1/LLM-JP/1。参照先はバイト列のSHAを確認してから読み込む。
export function decodeQeInstruction(envelope, upstream, expectedDecodedHash) {
  if (envelope.型 !== "BT6.1/LLM-JP/1" || envelope.文 !== "I" ||
      !/^[a-f0-9]{64}$/.test(expectedDecodedHash) || envelope.SHA256 !== expectedDecodedHash) {
    throw new Error("施工指示書の形式または復号SHA-256が現行pinと不一致");
  }
  const sources = {};
  for (const kind of ["S", "P"]) {
    const { name, bytes } = upstream[kind];
    const pin = envelope.上位?.[kind];
    if (!Array.isArray(pin) || pin.length !== 2 || pin[0] !== name || pin[1] !== sha256(bytes)) {
      throw new Error(`施工指示書の上位原典 ${kind} が不一致`);
    }
    sources[kind] = JSON.parse(bytes);
  }

  function entry(table, index) {
    if (!Array.isArray(table) || !Number.isSafeInteger(index) || index < 0 || !Object.hasOwn(table, index)) {
      throw new Error("施工指示書に未解決の辞書参照");
    }
    return table[index];
  }

  function expand(value) {
    if (typeof value === "string") {
      if (value.startsWith("@@")) return value.slice(1);
      if (/^@\d+$/.test(value)) return entry(envelope.語, Number(value.slice(1)));
      return value;
    }
    if (!Array.isArray(value)) return value;
    if (value[0] === "$O") {
      const keys = entry(envelope.鍵, value[1]);
      if (keys.length !== value.length - 2 || new Set(keys).size !== keys.length) {
        throw new Error("施工指示書のオブジェクトの鍵と値が不一致");
      }
      return Object.fromEntries(keys.map((key, index) => [key, expand(value[index + 2])]));
    }
    if (value[0] === "$R") {
      const reference = entry(envelope.参, value[1]);
      return reference.reduce((current, key) => {
        if (current == null || !Object.hasOwn(current, key)) throw new Error("上位原典に未解決の参照");
        return current[key];
      }, sources);
    }
    return (value[0] === "$A" ? value.slice(1) : value).map(expand);
  }

  const instruction = expand(envelope.体);
  if (sha256(JSON.stringify(instruction, null, 2) + "\n") !== expectedDecodedHash) {
    throw new Error("施工指示書の復号結果がSHA-256と不一致");
  }
  return instruction;
}
