import type { DecodedMessage } from "./delta-stream";

// ChatGPT marks web citations in answer text in three ways:
// - private-use markers: U+E200 opens, U+E202 separates fields, U+E201 closes, as in
//   cite + turn0search3 (+ more refs), or genui + {"citation":{"ref":"turn8view0"}};
// - <Cite ref="turn0search3"/> or <Cite refs={["turn0view0","turn0search1"]}/> tags;
// - <Link url="https://..." title="..."/> tags for a link written into the text.
// A ref names a source of the turn: turn<turn_index><ref_type><ref_index>. The sources are
// in the stream, in search results and citation entries that carry the same ref_id, and a
// marker's content_references entry (matched_text = the marker) lists its sources too.
//
// numbered: citations become [1], [2] and a Sources list ends the answer.
// strip:    citations are removed, for answers parsed by programs (odds, --schema, --format).
// raw:      the text is left as ChatGPT sent it.
// In numbered and strip mode a <Link> tag becomes a Markdown link. A marker of another kind
// becomes its content_references alt text when it has one, and is otherwise left in place.

export const CITATION_MODES = ["numbered", "strip", "raw"] as const;
export type CitationMode = (typeof CITATION_MODES)[number];

export interface CitationStats {
  citations: number;
  resolved: number;
  links: number;
  sources: number;
  /** Kinds of private-use markers left in place or replaced by alt text, e.g. "entity". */
  otherKinds: string[];
}

interface Source {
  url: string;
  title: string | null;
}

const CITATION_SYNTAX = /\uE200|<Cite\b|<Link\b/;
const MARKER = /([ \t]*)\uE200([^\uE200\uE201]*)\uE201/g;
const MARKER_OR_TAG = /([ \t]*)(?:\uE200([^\uE200\uE201]*)\uE201|<(Cite|Link)\b([^<>]*?)\/>)/g;
// Fenced and inline code keep their tags: an answer can show <Link .../> as an example.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const REF = /turn\d+[a-z_]+\d+/g;
const KIND = /^[a-z][a-z0-9_]{0,31}$/;

export function hasCitationSyntax(text: string): boolean {
  return CITATION_SYNTAX.test(text);
}

export function citationMode(value: unknown): CitationMode {
  return CITATION_MODES.includes(value as CitationMode) ? (value as CitationMode) : "raw";
}

export function formatCitations(
  text: string,
  messages: DecodedMessage[],
  mode: CitationMode,
): { text: string; stats: CitationStats } {
  const stats: CitationStats = { citations: 0, resolved: 0, links: 0, sources: 0, otherKinds: [] };
  if (mode === "raw" || !hasCitationSyntax(text)) return { text, stats };
  const index = indexSources(messages);
  const numbers = new Map<string, number>();
  const listed: Source[] = [];
  const otherKinds = new Set<string>();

  const replace = (whole: string, lead: string, marker: string | undefined, tag: string | undefined, attributes: string | undefined) => {
    if (tag === "Link") {
      stats.links += 1;
      return `${lead}${markdownLink(attribute(attributes ?? "", "url"), attribute(attributes ?? "", "title"))}`;
    }
    let refs: string[];
    let matched: Source[] = [];
    if (marker !== undefined) {
      const fields = marker.split("\uE202");
      const kind = fields[0];
      if (kind !== "cite" && kind !== "genui") {
        otherKinds.add(KIND.test(kind) ? kind : "?");
        const alt = index.altByMarker.get(`\uE200${marker}\uE201`);
        return alt === undefined ? whole : `${lead}${alt}`;
      }
      refs = kind === "cite" ? fields.slice(1) : genuiRefs(fields[1]);
      if (kind === "genui" && refs.length === 0) {
        otherKinds.add("genui");
        return whole;
      }
      matched = index.byMarker.get(`\uE200${marker}\uE201`) ?? [];
    } else {
      refs = (attributes ?? "").match(REF) ?? [];
    }
    stats.citations += 1;
    const sources = uniqueSources([...refs.map((ref) => index.byRef.get(ref)).filter((source) => source !== undefined), ...matched]);
    if (sources.length > 0) stats.resolved += 1;
    if (mode === "strip" || sources.length === 0) return "";
    return `${lead}${sources
      .map((source) => {
        let number = numbers.get(source.url);
        if (number === undefined) {
          number = listed.push(source);
          numbers.set(source.url, number);
        }
        return `[${number}]`;
      })
      .join("")}`;
  };

  let output = "";
  let position = 0;
  for (const code of text.matchAll(CODE)) {
    output += text.slice(position, code.index).replace(MARKER_OR_TAG, replace);
    output += code[0].replace(MARKER, (whole, lead: string, marker: string) => replace(whole, lead, marker, undefined, undefined));
    position = code.index + code[0].length;
  }
  output += text.slice(position).replace(MARKER_OR_TAG, replace);

  stats.sources = listed.length;
  stats.otherKinds = [...otherKinds].sort();
  if (listed.length > 0) {
    const lines = listed.map((source, i) => `[${i + 1}] ${source.title ? `${source.title} — ` : ""}${source.url}`);
    output = `${output.trimEnd()}\n\nSources:\n${lines.join("\n")}\n`;
  }
  return { text: output, stats };
}

interface SourceIndex {
  byRef: Map<string, Source>;
  byMarker: Map<string, Source[]>;
  altByMarker: Map<string, string>;
}

function indexSources(messages: DecodedMessage[]): SourceIndex {
  const index: SourceIndex = { byRef: new Map(), byMarker: new Map(), altByMarker: new Map() };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 40) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const source = sourceOf(value);
    if (source) {
      for (const ref of refsOf(value)) {
        const known = index.byRef.get(ref);
        if (!known || (!known.title && source.title)) index.byRef.set(ref, source);
      }
    }
    if (typeof value.matched_text === "string" && value.matched_text.startsWith("\uE200")) {
      const items = Array.isArray(value.items) ? value.items.map(sourceOf).filter((item) => item !== null) : [];
      if (items.length > 0) index.byMarker.set(value.matched_text, items);
      if (typeof value.alt === "string") index.altByMarker.set(value.matched_text, value.alt);
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const message of messages) visit(message.root, 0);
  return index;
}

function sourceOf(value: unknown): Source | null {
  if (!isRecord(value) || typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) return null;
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : null;
  return { url: cleanUrl(value.url), title };
}

function refsOf(value: Record<string, unknown>): string[] {
  const refs = Array.isArray(value.refs) ? [...value.refs] : [];
  if (value.ref_id !== undefined) refs.push(value.ref_id);
  return refs.flatMap((ref) => {
    if (typeof ref === "string") return ref.match(REF) ?? [];
    if (isRecord(ref) && (typeof ref.turn_index === "number" || typeof ref.turn_index === "string")
      && typeof ref.ref_type === "string" && (typeof ref.ref_index === "number" || typeof ref.ref_index === "string")) {
      return [`turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`];
    }
    return [];
  });
}

function genuiRefs(field: string | undefined): string[] {
  try {
    const citation = (JSON.parse(field ?? "") as { citation?: { ref?: unknown; refs?: unknown } }).citation;
    const refs = [citation?.ref, ...(Array.isArray(citation?.refs) ? citation.refs : [])];
    return refs.filter((ref): ref is string => typeof ref === "string");
  } catch {
    return [];
  }
}

function uniqueSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => !seen.has(source.url) && seen.add(source.url));
}

// ChatGPT tags the links it hands out with utm_source=chatgpt.com.
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("utm_source") !== "chatgpt.com") return url;
    parsed.searchParams.delete("utm_source");
    return parsed.toString();
  } catch {
    return url;
  }
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match ? decodeEntities(match[1]) : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function markdownLink(url: string | null, title: string | null): string {
  if (!url || !/^https?:\/\//.test(url)) return title ?? "";
  const clean = cleanUrl(url);
  if (!title?.trim()) return `<${clean}>`;
  return `[${title.trim().replace(/([[\]])/g, "\\$1")}](${clean.replace(/\)/g, "%29")})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
