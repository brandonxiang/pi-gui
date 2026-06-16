import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Session data types and grouping utilities for Pi sessions.
 */

export interface PiSessionSummary {
  id: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  created: string;
  modified: string;
}

export interface PiSessionProject {
  name: string;
  path: string;
  sessions: PiSessionSummary[];
}

interface RawSessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

interface PiSessionEntryLike {
  type: string;
  id: string;
  timestamp: string;
  message?: unknown;
  summary?: string;
}

interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
}

interface PiTextContent {
  type: "text";
  text: string;
}

interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

interface PiSessionMessageLike {
  role: string;
  timestamp?: number;
  content?: unknown;
  provider?: string;
  model?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  display?: boolean;
  customType?: string;
}

export interface PiBranchModel {
  provider: string;
  modelId: string;
}

export interface PiHistoryImage {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

export type PiHistoryMessage =
  | {
      id: string;
      role: "user";
      content: string;
      images?: PiHistoryImage[];
      timestamp: number;
    }
  | {
      id: string;
      role: "assistant";
      content: string;
      provider?: string;
      model?: string;
      timestamp: number;
    }
  | {
      id: string;
      role: "tool";
      toolName: string;
      content: string;
      isError: boolean;
      expandable: true;
      timestamp: number;
    }
  | {
      id: string;
      role: "summary";
      summaryType: "compaction" | "branch" | "custom";
      title: string;
      content: string;
      timestamp: number;
    };

export interface PiSessionDetailResponse {
  session: {
    id: string;
    name: string;
    cwd: string;
    projectName: string;
    created: string;
    modified: string;
  };
  messages: PiHistoryMessage[];
}

const MAX_FIRST_MESSAGE_LENGTH = 120;
const MAX_TOOL_CONTENT_LENGTH = 12_000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

/** Truncate a session first message for display, appending "…" when cut. */
export function truncateFirstMessage(text: string): string {
  return truncate(text, MAX_FIRST_MESSAGE_LENGTH);
}

function extractProjectName(cwd: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || "(unknown)";
}

function toIsoString(date: Date): string {
  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readNumber(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function readBoolean(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function toTimestamp(value: unknown, fallback: string) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const parsed = Date.parse(fallback);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function stringifyContent(value: string) {
  return truncate(value, MAX_TOOL_CONTENT_LENGTH);
}

function isTextContent(value: unknown): value is PiTextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is PiImageContent {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function isThinkingContent(value: unknown): value is PiThinkingContent {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCallContent(value: unknown): value is PiToolCallContent {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

function normalizeRichContent(
  content: unknown,
  entryId: string
): { text: string; images: PiHistoryImage[]; toolCalls: PiToolCallContent[] } {
  if (typeof content === "string") {
    return { text: content, images: [], toolCalls: [] };
  }

  if (!Array.isArray(content)) {
    return { text: "", images: [], toolCalls: [] };
  }

  const textParts: string[] = [];
  const images: PiHistoryImage[] = [];
  const toolCalls: PiToolCallContent[] = [];
  let imageIndex = 0;

  for (const item of content) {
    if (isTextContent(item)) {
      textParts.push(item.text);
      continue;
    }

    if (isImageContent(item)) {
      imageIndex += 1;
      images.push({
        id: `${entryId}-image-${imageIndex - 1}`,
        data: item.data,
        mimeType: item.mimeType,
        name: `Pi session image ${imageIndex}`
      });
      continue;
    }

    if (isToolCallContent(item)) {
      toolCalls.push(item);
      continue;
    }

    if (isThinkingContent(item)) {
      continue;
    }
  }

  return { text: textParts.join("\n\n").trim(), images, toolCalls };
}

function formatToolArguments(argumentsValue: unknown) {
  if (typeof argumentsValue === "string") return stringifyContent(argumentsValue);

  try {
    return stringifyContent(JSON.stringify(argumentsValue ?? {}, null, 2));
  } catch {
    return "{}";
  }
}

function normalizeContentToText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => isTextContent(item))
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function toCustomSummaryTitle(customType?: string) {
  if (!customType) return "Custom Note";

  const normalized = customType
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

  return normalized ? `Custom ${normalized}` : "Custom Note";
}

function normalizeMessageEntry(entry: PiSessionEntryLike): PiHistoryMessage[] {
  const message = entry.message as PiSessionMessageLike | undefined;
  if (!message || typeof message.role !== "string") return [];

  const timestamp = toTimestamp(message.timestamp, entry.timestamp);

  if (message.role === "user") {
    const normalized = normalizeRichContent(message.content, entry.id);
    return [
      {
        id: entry.id,
        role: "user",
        content: normalized.text,
        images: normalized.images.length > 0 ? normalized.images : undefined,
        timestamp
      }
    ];
  }

  if (message.role === "assistant") {
    const normalized = normalizeRichContent(message.content, entry.id);
    const result: PiHistoryMessage[] = [];

    if (normalized.text) {
      result.push({
        id: entry.id,
        role: "assistant",
        content: normalized.text,
        provider: message.provider,
        model: message.model,
        timestamp
      });
    }

    for (const toolCall of normalized.toolCalls) {
      result.push({
        id: `${entry.id}:${toolCall.id}`,
        role: "tool",
        toolName: toolCall.name,
        content: formatToolArguments(toolCall.arguments),
        isError: false,
        expandable: true,
        timestamp
      });
    }

    return result;
  }

  if (message.role === "toolResult") {
    return [
      {
        id: entry.id,
        role: "tool",
        toolName: message.toolName || "tool",
        content: stringifyContent(normalizeContentToText(message.content)),
        isError: Boolean(message.isError),
        expandable: true,
        timestamp
      }
    ];
  }

  if (message.role === "bashExecution") {
    const lines = [`$ ${message.command || ""}`];
    if (message.output) lines.push(message.output);

    return [
      {
        id: entry.id,
        role: "tool",
        toolName: "bash",
        content: stringifyContent(lines.join("\n").trim()),
        isError: typeof message.exitCode === "number" ? message.exitCode !== 0 : false,
        expandable: true,
        timestamp
      }
    ];
  }

  if (message.role === "custom") {
    if (!message.display) return [];

    return [
      {
        id: entry.id,
        role: "summary",
        summaryType: "custom",
        title: toCustomSummaryTitle(message.customType),
        content: normalizeContentToText(message.content) || "",
        timestamp
      }
    ];
  }

  if (message.role === "branchSummary") {
    return [
      {
        id: entry.id,
        role: "summary",
        summaryType: "branch",
        title: "Branch Summary",
        content: readString(message, "summary") || "",
        timestamp
      }
    ];
  }

  if (message.role === "compactionSummary") {
    return [
      {
        id: entry.id,
        role: "summary",
        summaryType: "compaction",
        title: "Compaction Summary",
        content: readString(message, "summary") || "",
        timestamp
      }
    ];
  }

  return [];
}

function normalizeSummaryEntry(entry: PiSessionEntryLike): PiHistoryMessage[] {
  const timestamp = toTimestamp(undefined, entry.timestamp);
  const summary = entry.summary || "";

  if (entry.type === "compaction") {
    return [
      {
        id: entry.id,
        role: "summary",
        summaryType: "compaction",
        title: "Compaction Summary",
        content: summary,
        timestamp
      }
    ];
  }

  if (entry.type === "branch_summary") {
    return [
      {
        id: entry.id,
        role: "summary",
        summaryType: "branch",
        title: "Branch Summary",
        content: summary,
        timestamp
      }
    ];
  }

  return [];
}

export function groupSessionsByProject(rawSessions: RawSessionInfo[]): PiSessionProject[] {
  const groups = new Map<string, { path: string; sessions: RawSessionInfo[] }>();

  for (const session of rawSessions) {
    const key = session.cwd || "";
    if (!groups.has(key)) {
      groups.set(key, { path: session.cwd, sessions: [] });
    }
    groups.get(key)!.sessions.push(session);
  }

  const projects: PiSessionProject[] = [];

  for (const [cwd, group] of groups) {
    // Sort sessions within project by modified time descending
    group.sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

    projects.push({
      name: extractProjectName(cwd),
      path: group.path,
      sessions: group.sessions.map((s) => ({
        id: s.id,
        name: s.name,
        firstMessage: truncateFirstMessage(s.firstMessage),
        messageCount: s.messageCount,
        created: toIsoString(s.created),
        modified: toIsoString(s.modified)
      }))
    });
  }

  // Sort projects alphabetically by name
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return projects;
}

export function findSessionById(rawSessions: RawSessionInfo[], sessionId: string) {
  return rawSessions.find((session) => session.id === sessionId) || null;
}

export function normalizeBranchEntries(entries: PiSessionEntryLike[]): PiHistoryMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type === "message") return normalizeMessageEntry(entry);
    return normalizeSummaryEntry(entry);
  });
}

export function inferBranchModel(entries: PiSessionEntryLike[]): PiBranchModel | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (
      entry.type === "model_change" &&
      typeof readString(entry, "provider") === "string" &&
      typeof readString(entry, "modelId") === "string"
    ) {
      return {
        provider: readString(entry, "provider")!,
        modelId: readString(entry, "modelId")!
      };
    }

    if (entry.type !== "message") continue;

    const message = entry.message as PiSessionMessageLike | undefined;
    if (
      message?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return {
        provider: message.provider,
        modelId: message.model
      };
    }
  }

  return null;
}

export function buildPiSessionDetail(
  session: RawSessionInfo,
  entries: PiSessionEntryLike[]
): PiSessionDetailResponse {
  return {
    session: {
      id: session.id,
      name: session.name?.trim() || session.firstMessage.trim() || "Pi session",
      cwd: session.cwd,
      projectName: extractProjectName(session.cwd),
      created: toIsoString(session.created),
      modified: toIsoString(session.modified)
    },
    messages: normalizeBranchEntries(entries)
  };
}

export async function loadPiSessionDetailById(sessionId: string) {
  const sessions = await SessionManager.listAll();
  const match = findSessionById(sessions as RawSessionInfo[], sessionId);
  if (!match) return null;

  const sessionManager = SessionManager.open(match.path);
  return buildPiSessionDetail(
    match,
    sessionManager.getBranch() as unknown as PiSessionEntryLike[]
  );
}

export async function loadPiSessionContextById(sessionId: string) {
  const sessions = await SessionManager.listAll();
  const match = findSessionById(sessions as RawSessionInfo[], sessionId);
  if (!match) return null;

  const sessionManager = SessionManager.open(match.path);
  const entries = sessionManager.getBranch() as unknown as PiSessionEntryLike[];

  return {
    session: match,
    sessionManager,
    entries,
    model: inferBranchModel(entries)
  };
}
