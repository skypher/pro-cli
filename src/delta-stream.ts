// ChatGPT's conversation stream (delta_encoding "v1") builds every message of a turn from
// edits. A frame's "c" names the message it edits, by the index its add frame gave it; a
// frame without "c" edits the message the previous one did. A frame without "o" or "p"
// repeats the previous frame's operation and path: {"v": " more"} continues an append and
// {"v": [...]} a patch. Fast models stream the answer into two messages at once (one per
// search segment and one that joins them, named by streaming_parent_patch's
// logical_answer_id), and a handed-off stream replays the turn from its first message.

export interface DecodedMessage {
  /** The message's document: {message, conversation_id, ...} as the add frame sent it. */
  root: Record<string, unknown>;
  /** Sequence number of the last frame that changed it. */
  touched: number;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class DeltaStreamDecoder {
  private readonly documents = new Map<string, DecodedMessage>();
  private cursor: string | null = null;
  private lastOperation = "add";
  private lastPath = "";
  private sequence = 0;
  private unindexed = 0;
  logicalAnswerId: string | null = null;

  apply(event: unknown): void {
    if (!isRecord(event)) return;
    if (event.type === "streaming_parent_patch") {
      if (typeof event.logical_answer_id === "string") this.logicalAnswerId = event.logical_answer_id;
      return;
    }
    if (typeof event.type === "string") return;
    this.sequence += 1;
    // Streams without delta encoding send each message whole as {"message": ...}.
    if (!("v" in event)) {
      if (isRecord(event.message)) this.applySnapshot(event, event.message);
      return;
    }
    const bare = typeof event.o !== "string" && typeof event.p !== "string";
    let operation = bare ? this.lastOperation : typeof event.o === "string" ? event.o : this.lastOperation;
    let path = bare ? this.lastPath : typeof event.p === "string" ? event.p : "";
    const index = typeof event.c === "number" ? event.c : null;
    const value = event.v;
    if (isRecord(value) && isRecord(value.message) && (bare || (operation === "add" && path === ""))) {
      this.addMessage(index === null ? `#${(this.unindexed += 1)}` : `c:${index}`, value);
      operation = "add";
      path = "";
    } else {
      if (index !== null) this.cursor = `c:${index}`;
      if (this.cursor === null) return;
      const document = this.documents.get(this.cursor) ?? { root: {}, touched: this.sequence };
      document.root = applyOperation(document.root, operation, path, value);
      document.touched = this.sequence;
      this.documents.set(this.cursor, document);
    }
    this.lastOperation = operation;
    this.lastPath = path;
  }

  messages(): DecodedMessage[] {
    return [...this.documents.values()];
  }

  // A message added while in progress takes the edits that follow. A finished one (a sub-agent
  // record, say) can be inserted whole while another message streams, and the edits after it
  // still belong to the streaming one.
  private addMessage(key: string, root: Record<string, unknown>): void {
    this.documents.set(key, { root, touched: this.sequence });
    const message = root.message as Record<string, unknown>;
    if (message.status === "in_progress" || !this.cursorIsStreaming()) this.cursor = key;
  }

  // A snapshot of a message already here updates it; one that holds only the end of the text
  // streamed so far keeps that text.
  private applySnapshot(root: Record<string, unknown>, message: Record<string, unknown>): void {
    const key = this.snapshotTarget(message);
    const current = key === null ? undefined : this.documents.get(key);
    if (!current || !isRecord(current.root.message)) {
      this.addMessage(typeof message.id === "string" ? `id:${message.id}` : `#${(this.unindexed += 1)}`, root);
      return;
    }
    const before = partsText(current.root.message);
    const after = partsText(message);
    const merged: Record<string, unknown> = { ...current.root.message, ...message };
    if (before !== null && after !== null && before.length > after.length && before.endsWith(after)) {
      merged.content = { ...(isRecord(message.content) ? message.content : {}), parts: [before] };
    }
    current.root = { ...current.root, ...root, message: merged };
    current.touched = this.sequence;
  }

  // The same id, or without one the message being streamed if it has the same author, recipient and channel.
  private snapshotTarget(message: Record<string, unknown>): string | null {
    if (typeof message.id === "string") {
      for (const [key, document] of this.documents) {
        if (isRecord(document.root.message) && document.root.message.id === message.id) return key;
      }
      return null;
    }
    const current = this.cursor === null ? null : this.documents.get(this.cursor)?.root.message;
    if (!isRecord(current)) return null;
    const role = (value: Record<string, unknown>) => (isRecord(value.author) ? value.author.role : undefined);
    const same = role(current) === role(message)
      && (current.recipient ?? null) === (message.recipient ?? null)
      && (current.channel ?? null) === (message.channel ?? null);
    return same ? this.cursor : null;
  }

  private cursorIsStreaming(): boolean {
    const message = this.cursor === null ? null : this.documents.get(this.cursor)?.root.message;
    return isRecord(message) && message.status === "in_progress";
  }
}

export function decodeDeltaStream(raw: string, parse: (frame: string) => unknown): DeltaStreamDecoder {
  const decoder = new DeltaStreamDecoder();
  for (const frame of raw.replace(/\r\n?/g, "\n").split("\n\n")) {
    if (!frame.trim()) continue;
    let event: unknown;
    try {
      event = parse(frame);
    } catch {
      continue;
    }
    decoder.apply(event);
  }
  return decoder;
}

/** Applies one edit (add, replace, remove, append, truncate, or a patch of them) and returns the new root. */
export function applyOperation(
  root: Record<string, unknown>,
  operation: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (operation === "patch") {
    if (!Array.isArray(value)) return root;
    let next = root;
    for (const edit of value) {
      if (isRecord(edit) && typeof edit.o === "string") next = applyOperation(next, edit.o, typeof edit.p === "string" ? edit.p : "", edit.v);
    }
    return next;
  }
  const keys = parsePointer(path);
  if (keys === null) return root;
  if (keys.length === 0) {
    if ((operation === "add" || operation === "replace") && isRecord(value)) return value;
    if (operation === "append" && isRecord(value)) mergeInto(root, value);
    return root;
  }
  let parent: unknown = root;
  for (const key of keys.slice(0, -1)) {
    let child = childOf(parent, key);
    if (child === undefined) {
      child = {};
      setChild(parent, key, child, false);
    }
    parent = child;
  }
  const last = keys[keys.length - 1];
  const current = childOf(parent, last);
  if (operation === "add" || operation === "replace") {
    setChild(parent, last, value, operation === "add");
  } else if (operation === "remove") {
    removeChild(parent, last);
  } else if (operation === "append") {
    if (typeof current === "string" && typeof value === "string") setChild(parent, last, current + value, false);
    else if (Array.isArray(current)) current.push(...(Array.isArray(value) ? value : [value]));
    else if (isRecord(current) && isRecord(value)) mergeInto(current, value);
    else if (current === undefined) setChild(parent, last, value, false);
  } else if (operation === "truncate") {
    if ((typeof current === "string" || Array.isArray(current)) && typeof value === "number") {
      setChild(parent, last, current.slice(0, value), false);
    }
  }
  return root;
}

function parsePointer(path: string): string[] | null {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  const keys = path.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  return keys.some((key) => UNSAFE_KEYS.has(key)) ? null : keys;
}

function childOf(container: unknown, key: string): unknown {
  if (Array.isArray(container)) return /^\d+$/.test(key) ? container[Number(key)] : undefined;
  return isRecord(container) && Object.hasOwn(container, key) ? container[key] : undefined;
}

function setChild(container: unknown, key: string, value: unknown, insert: boolean): void {
  if (Array.isArray(container)) {
    if (key === "-") container.push(value);
    else if (/^\d+$/.test(key) && Number(key) <= container.length) container.splice(Number(key), insert ? 0 : 1, value);
  } else if (isRecord(container)) {
    container[key] = value;
  }
}

function removeChild(container: unknown, key: string): void {
  if (Array.isArray(container)) {
    if (/^\d+$/.test(key)) container.splice(Number(key), 1);
  } else if (isRecord(container)) {
    delete container[key];
  }
}

// Appending an object adds its keys; lists under the same key are joined, not replaced.
function mergeInto(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const [key, next] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (Array.isArray(current) && Array.isArray(next)) current.push(...next);
    else if (isRecord(current) && isRecord(next) && !Array.isArray(next)) mergeInto(current, next);
    else target[key] = next;
  }
}

function partsText(message: Record<string, unknown>): string | null {
  const parts = isRecord(message.content) ? message.content.parts : undefined;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((part): part is string => typeof part === "string");
  return text.length > 0 ? text.join("") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
