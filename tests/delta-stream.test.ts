import { describe, expect, test } from "bun:test";
import { applyOperation, DeltaStreamDecoder } from "../src/delta-stream";

describe("applyOperation", () => {
  test("appends to text and lists, and merges objects key by key", () => {
    let root: Record<string, unknown> = { message: { content: { parts: ["Hel"] }, metadata: { refs: ["a"], safe_urls: ["x"] } } };
    root = applyOperation(root, "append", "/message/content/parts/0", "lo");
    root = applyOperation(root, "append", "/message/metadata/refs", ["b", "c"]);
    root = applyOperation(root, "append", "/message/metadata", { safe_urls: [], status: "done" });
    expect(root).toEqual({ message: { content: { parts: ["Hello"] }, metadata: { refs: ["a", "b", "c"], safe_urls: ["x"], status: "done" } } });
  });

  test("replaces, adds, removes and truncates, alone or in a patch", () => {
    const root = applyOperation({ list: ["a", "c"], text: "abcdef", gone: 1 }, "patch", "", [
      { p: "/list/1", o: "add", v: "b" },
      { p: "/list/0", o: "replace", v: "A" },
      { p: "/text", o: "truncate", v: 3 },
      { p: "/gone", o: "remove" },
      { p: "/new/deep", o: "replace", v: true },
    ]);
    expect(root).toEqual({ list: ["A", "b", "c"], text: "abc", new: { deep: true } });
  });

  test("ignores paths that would reach an object's prototype", () => {
    applyOperation({}, "replace", "/__proto__/polluted", true);
    applyOperation({}, "append", "", { ["__proto__"]: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("DeltaStreamDecoder", () => {
  const add = (c: number, id: string, status: string) =>
    ({ p: "", o: "add", c, v: { message: { id, author: { role: "assistant" }, content: { content_type: "text", parts: [""] }, status } } });
  const text = (decoder: DeltaStreamDecoder, id: string) => {
    const found = decoder.messages().find((decoded) => (decoded.root.message as { id: string }).id === id);
    return (found?.root.message as { content: { parts: string[] } } | undefined)?.content.parts.join("");
  };

  test("a frame without o or p repeats the previous operation and path", () => {
    const decoder = new DeltaStreamDecoder();
    decoder.apply(add(1, "a", "in_progress"));
    decoder.apply({ p: "/message/content/parts/0", o: "append", v: "one" });
    decoder.apply({ v: " two" });
    decoder.apply({ type: "url_moderation" });
    decoder.apply({ o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: " three" }] });
    decoder.apply({ v: [{ p: "/message/content/parts/0", o: "append", v: " four" }] });
    expect(text(decoder, "a")).toBe("one two three four");
  });

  test("c picks the message; a finished message added mid-stream leaves the edits with the streaming one", () => {
    const decoder = new DeltaStreamDecoder();
    decoder.apply(add(1, "a", "in_progress"));
    decoder.apply(add(2, "b", "in_progress"));
    decoder.apply({ c: 1, p: "/message/content/parts/0", o: "append", v: "to a" });
    decoder.apply({ v: ", still a" });
    decoder.apply({ c: 2, p: "/message/content/parts/0", o: "append", v: "to b" });
    decoder.apply(add(3, "record", "finished_successfully"));
    decoder.apply({ p: "/message/content/parts/0", o: "append", v: ", still b" });
    expect([text(decoder, "a"), text(decoder, "b"), text(decoder, "record")]).toEqual(["to a, still a", "to b, still b", ""]);
  });

  test("a replayed stream rebuilds each message instead of adding to it", () => {
    const decoder = new DeltaStreamDecoder();
    for (let replay = 0; replay < 2; replay += 1) {
      decoder.apply(add(1, "a", "in_progress"));
      decoder.apply({ p: "/message/content/parts/0", o: "append", v: "once" });
    }
    expect(text(decoder, "a")).toBe("once");
    expect(decoder.messages()).toHaveLength(1);
  });

  test("records the logical answer named by streaming_parent_patch", () => {
    const decoder = new DeltaStreamDecoder();
    decoder.apply({ type: "streaming_parent_patch", logical_answer_id: "joined", updates: [] });
    expect(decoder.logicalAnswerId).toBe("joined");
  });
});
