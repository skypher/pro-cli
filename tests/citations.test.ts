import { describe, expect, test } from "bun:test";
import { citationMode, formatCitations } from "../src/citations";
import type { DecodedMessage } from "../src/delta-stream";

const turn = (metadata: Record<string, unknown>): DecodedMessage[] => [{ root: { message: { metadata } }, touched: 1 }];
const sources = turn({
  search_result_groups: [{ entries: [
    { url: "https://a.example/one", title: "One", ref_id: { turn_index: 0, ref_type: "search", ref_index: 0 } },
    { url: "https://b.example/two", ref_id: { turn_index: 0, ref_type: "search", ref_index: 1 } },
  ] }],
});

describe("formatCitations", () => {
  test("numbers each source once, in order of first citation", () => {
    const text = "A \ue200cite\ue202turn0search1\ue201 B <Cite ref=\"turn0search0\"/> C \ue200cite\ue202turn0search0\ue202turn0search1\ue201";
    const { text: formatted, stats } = formatCitations(text, sources, "numbered");
    expect(formatted).toBe("A [1] B [2] C [2][1]\n\nSources:\n[1] https://b.example/two\n[2] One — https://a.example/one\n");
    expect(stats).toEqual({
      citations: 3,
      resolved: 3,
      links: 0,
      sources: 2,
      otherKinds: [],
      unresolvedRefTypes: {},
      unresolvedInUnknownTurns: 0,
      unresolvedWithEntry: 0,
      indexedRefTypes: { search: 2 },
    });
  });

  test("says why citations found no source, without naming them", () => {
    const marker = (...fields: string[]) => String.fromCharCode(0xe200) + fields.join(String.fromCharCode(0xe202)) + String.fromCharCode(0xe201);
    const withEntry = marker("cite", "turn0view5");
    const messages = [...sources, ...turn({ content_references: [{ matched_text: withEntry, items: [] }] })];
    const text = `A ${withEntry} B ${marker("cite", "turn3search0", "turn3__proto__1")} C <Cite/> D`;
    const { text: formatted, stats } = formatCitations(text, messages, "numbered");
    expect(formatted).toBe("A B C D");
    expect(stats).toMatchObject({ citations: 3, resolved: 0, unresolvedInUnknownTurns: 2, unresolvedWithEntry: 1, indexedRefTypes: { search: 2 } });
    // A ref type spelled __proto__ is counted as a key and leaves the prototype alone.
    expect(Object.entries(stats.unresolvedRefTypes)).toEqual([["view", 1], ["search", 1], ["__proto__", 1], ["none", 1]]);
    expect(Object.getPrototypeOf(stats.unresolvedRefTypes)).toBe(Object.prototype);
  });

  test("leaves tags in code alone", () => {
    const text = "Use `<Link url=\"https://x.example\" title=\"X\"/>`:\n```\n<Cite ref=\"turn0search0\"/>\n```\nDone <Cite ref=\"turn0search0\"/>";
    expect(formatCitations(text, sources, "strip").text).toBe(
      "Use `<Link url=\"https://x.example\" title=\"X\"/>`:\n```\n<Cite ref=\"turn0search0\"/>\n```\nDone",
    );
  });

  test("writes links as Markdown, escaping brackets in titles", () => {
    const text = "See <Link url=\"https://x.example/a?utm_source=chatgpt.com\" title=\"[Docs] &amp; more\"/> or <Link url=\"https://y.example\"/>.";
    expect(formatCitations(text, [], "numbered").text).toBe("See [\\[Docs\\] & more](https://x.example/a) or <https://y.example>.");
  });

  test("replaces another kind of marker with its alt text, or leaves it in place", () => {
    const entity = "\ue200entity\ue202[\"company\",\"Acme\"]\ue201";
    const other = "\ue200navlist\ue202x\ue201";
    const messages = turn({ content_references: [{ matched_text: entity, alt: "Acme" }] });
    const { text, stats } = formatCitations(`${entity} and ${other}`, messages, "numbered");
    expect(text).toBe(`Acme and ${other}`);
    expect(stats.otherKinds).toEqual(["entity", "navlist"]);
  });

  test("raw leaves the text alone", () => {
    const text = "A \ue200cite\ue202turn0search0\ue201";
    expect(formatCitations(text, sources, "raw").text).toBe(text);
  });
});

test("an unknown or missing mode means raw", () => {
  expect([citationMode("numbered"), citationMode("strip"), citationMode("bogus"), citationMode(undefined)]).toEqual(["numbered", "strip", "raw", "raw"]);
});
