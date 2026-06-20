import { Suspense, lazy, type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import Dropdown from "antd/es/dropdown";
import Input from "antd/es/input";
import Modal from "antd/es/modal";
import Bubble, { type BubbleItemType, type BubbleListProps } from "@ant-design/x/es/bubble";
import Sender from "@ant-design/x/es/sender";
import Suggestion, { type SuggestionItem } from "@ant-design/x/es/suggestion";
import XProvider from "@ant-design/x/es/x-provider";
import {
  createTranslator,
  formatMessageCount,
  LOCALE_STORAGE_KEY,
  localeOptions,
  readStoredLocale,
  type Locale,
  type TranslationKey,
  type Translator
} from "./i18n";
import {
  appSlashCommands,
  findAppSlashCommand,
  isServerAppSlashCommand,
  parseSlashCommandInput
} from "../shared/slash-commands.js";
import type {
  AssistantMessage,
  ChatMessage,
  ImageAttachment,
  PiHistoryMessage,
  PiSessionProject,
  PiSessionDetailResponse,
  StreamEvent,
  UserMessage
} from "./types";
import { PiSessionSection } from "./PiSessionSection";
import {
  findProjectBySessionId,
  getNewestProjectSessionId,
  resolveInitialPiSessionSelection
} from "./pi-session-launch.js";
import {
  applyPiSessionStreamingEvent,
  createPiSessionStreamingState,
  flushPiSessionThinking
} from "./pi-session-streaming";
import {
  groupPiHistoryMessages,
  type PiHistoryTranscriptEntry
} from "./pi-session-transcript";

const MarkdownContent = lazy(() => import("./MarkdownContent"));
const TerminalPanel = lazy(async () => {
  const module = await import("./TerminalPanel");
  return { default: module.TerminalPanel };
});

const PANEL_MODE_STORAGE_KEY = "my-pi-panel-mode";
type PanelMode = "chat" | "terminal";

const STORAGE_KEY = "my-pi-chat-session";
const SESSIONS_STORAGE_KEY = "my-pi-chat-sessions";
const ACTIVE_SESSION_KEY = "my-pi-active-session-id";
const ACTIVE_PI_PROJECT_KEY = "my-pi-active-pi-project-path";
const ARCHIVED_PI_SESSIONS_KEY = "my-pi-archived-pi-sessions";
const supportedImageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const maxImageBytes = 5 * 1024 * 1024;

const modelPresets = [
  { provider: "openai", model: "gpt-4o-mini", label: "OpenAI GPT-4o mini", supportsImages: true },
  { provider: "openai", model: "gpt-4.1-mini", label: "OpenAI GPT-4.1 mini", supportsImages: true },
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    label: "Claude 3.5 Haiku",
    supportsImages: true
  },
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", supportsImages: true },
  { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small", supportsImages: false }
];

type ModelOption = (typeof modelPresets)[number];
type SlashSuggestionInfo = { query: string };
type ProjectSuggestionInfo = { query: string };
type Skill = { name: string; description: string; disableModelInvocation: boolean };
type LocalResultStatus = Extract<PiHistoryMessage, { role: "local_result" }>["status"];
type LocalActionResult = {
  title: string;
  content: string;
  status: LocalResultStatus;
  updatedSessionName?: string;
  refreshProjects?: boolean;
};
type ChatSession = {
  id: string;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};
type ActivePanelView = { kind: "empty" } | { kind: "pi"; sessionId: string };
type LauncherMode = "new" | "select" | null;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVEL_STORAGE_KEY = "my-pi-thinking-level";

const defaultSystemPrompt =
  "You are My Pi, an online agent conversation assistant. Be concise, practical, and explicit about assumptions.";

const bubbleRoles: BubbleListProps["role"] = {
  assistant: {
    placement: "start",
    variant: "outlined",
    shape: "default",
    className: "chat-bubble chat-bubble-assistant",
    contentRender(content) {
      if (typeof content === "string") {
        return <RenderMarkdown content={content} />;
      }
      return content;
    }
  },
  user: {
    placement: "end",
    variant: "outlined",
    shape: "default",
    className: "chat-bubble chat-bubble-user"
  }
};

const xTheme = {
  token: {
    colorPrimary: "#0075de",
    borderRadius: 8,
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  }
};

function createSessionId() {
  return crypto.randomUUID();
}

function createSession(title = "Untitled session", messages: ChatMessage[] = []): ChatSession {
  const timestamp = Date.now();

  return {
    id: createSessionId(),
    title,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages
  };
}

function getSessionTitleFromMessages(messages: ChatMessage[], untitledTitle: string) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage?.content.trim()) return untitledTitle;
  return firstUserMessage.content.trim().slice(0, 48);
}

function readStoredSessions(locale: Locale): ChatSession[] {
  const t = createTranslator(locale);

  try {
    const rawSessions = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (rawSessions) {
      const parsed = JSON.parse(rawSessions) as ChatSession[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.some((session) => !session.archived)
          ? parsed
          : [createSession(t("session.untitled")), ...parsed];
      }
    }

    const legacyMessages = readStoredMessages();
    if (legacyMessages.length > 0) {
      return [
        createSession(
          getSessionTitleFromMessages(legacyMessages, t("session.untitled")),
          legacyMessages
        )
      ];
    }
  } catch {
    // Fall through to a clean session if local storage is unavailable or corrupted.
  }

  return [createSession(t("session.untitled"))];
}

function getMessageText(message: ChatMessage) {
  return message.content;
}

function getImageDataUrl(image: { mimeType: string; data: string }) {
  return `data:${image.mimeType};base64,${image.data}`;
}

function getModelKey(provider: string, model: string) {
  return `${provider}:${model}`;
}

function parseModelKey(modelKey: string) {
  const separatorIndex = modelKey.indexOf(":");
  if (separatorIndex === -1) return { provider: "openai", model: "gpt-4o-mini" };

  return {
    provider: modelKey.slice(0, separatorIndex),
    model: modelKey.slice(separatorIndex + 1)
  };
}

function MessageHeader({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="message-meta">
      <span>{label}</span>
      <small>{meta}</small>
    </div>
  );
}

function MarkdownFallback({ content }: { content: string }) {
  return <p>{content}</p>;
}

function RenderMarkdown({ content }: { content: string }) {
  return (
    <Suspense fallback={<MarkdownFallback content={content} />}>
      <MarkdownContent content={content} />
    </Suspense>
  );
}

function UserMessageContent({ message }: { message: UserMessage }) {
  return (
    <div className="message-content">
      {message.images?.length ? (
        <div className="message-images">
          {message.images.map((image) => (
            <figure className="message-image" key={image.id}>
              <img alt={image.name} src={getImageDataUrl(image)} />
              <figcaption>{image.name}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      <p>{getMessageText(message)}</p>
    </div>
  );
}

function PiHistoryUserMessageContent({
  message
}: {
  message: Extract<PiHistoryMessage, { role: "user" }>;
}) {
  return (
    <div className="message-content">
      {message.images?.length ? (
        <div className="message-images">
          {message.images.map((image) => (
            <figure className="message-image" key={image.id}>
              <img alt={image.name} src={getImageDataUrl(image)} />
              <figcaption>{image.name}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {message.content ? <p>{message.content}</p> : null}
    </div>
  );
}

function PiToolMessageContent({
  t,
  message
}: {
  t: Translator;
  message: Extract<PiHistoryMessage, { role: "tool" }>;
}) {
  return (
    <details className={message.isError ? "pi-tool-card pi-tool-card-error" : "pi-tool-card"}>
      <summary>
        <span>{message.toolName}</span>
        <small>{t("chat.clickToExpand")}</small>
      </summary>
      <pre>{message.content}</pre>
    </details>
  );
}

function PiToolGroupContent({
  t,
  messages
}: {
  t: Translator;
  messages: Extract<PiHistoryTranscriptEntry, { role: "tool-group" }>["messages"];
}) {
  const hasError = messages.some((message) => message.isError);

  return (
    <details className={hasError ? "pi-tool-group-card pi-tool-group-card-error" : "pi-tool-group-card"}>
      <summary>
        <span>{t("chat.toolHistory")}</span>
        <small>{t("chat.clickToExpand")}</small>
      </summary>
      <div className="pi-tool-group-list">
        {messages.map((message) => (
          <section className="pi-tool-group-item" key={message.id}>
            <header>
              <strong>{message.toolName}</strong>
            </header>
            <pre>{message.content}</pre>
          </section>
        ))}
      </div>
    </details>
  );
}

function PiSummaryMessageContent({
  message
}: {
  message: Extract<PiHistoryMessage, { role: "summary" }>;
}) {
  return (
    <div className={`pi-summary-card pi-summary-card-${message.summaryType}`}>
      <strong>{message.title}</strong>
      <p>{message.content}</p>
    </div>
  );
}

function PiLocalResultContent({
  message
}: {
  message: Extract<PiHistoryMessage, { role: "local_result" }>;
}) {
  return (
    <div className={`pi-local-result-card pi-local-result-card-${message.status}`}>
      <RenderMarkdown content={message.content} />
    </div>
  );
}

function createBubbleItem(
  message: ChatMessage,
  index: number,
  locale: Locale,
  t: Translator
): BubbleItemType {
  const isAssistant = message.role === "assistant";

  return {
    key: `${message.role}-${message.timestamp}-${index}`,
    role: isAssistant ? "assistant" : "user",
    content: isAssistant ? getMessageText(message) : <UserMessageContent message={message} />,
    header: (
      <MessageHeader
        label={isAssistant ? t("chat.myPi") : t("chat.you")}
        meta={
          isAssistant
            ? `${message.provider}/${message.model}`
            : new Date(message.timestamp).toLocaleTimeString(locale)
        }
      />
    )
  };
}

function createPiHistoryBubbleItem(entry: PiHistoryTranscriptEntry, index: number, t: Translator): BubbleItemType {
  if (entry.role === "tool-group") {
    return {
      key: `${entry.role}-${entry.timestamp}-${index}`,
      role: "assistant",
      content: <PiToolGroupContent t={t} messages={entry.messages} />,
      header: <MessageHeader label={t("chat.tool")} meta={t("chat.toolSummary", { count: entry.messages.length })} />
    };
  }

  if (entry.role === "user") {
    return {
      key: `${entry.role}-${entry.timestamp}-${index}`,
      role: "user",
      content: <PiHistoryUserMessageContent message={entry} />,
      header: <MessageHeader label={t("chat.piSession")} meta={t("chat.user")} />
    };
  }

  if (entry.role === "assistant") {
    return {
      key: `${entry.role}-${entry.timestamp}-${index}`,
      role: "assistant",
      content: entry.content,
      header: (
        <MessageHeader
          label={t("chat.piSession")}
          meta={entry.provider && entry.model ? `${entry.provider}/${entry.model}` : t("chat.assistant")}
        />
      )
    };
  }

  if (entry.role === "tool") {
    return {
      key: `${entry.role}-${entry.timestamp}-${index}`,
      role: "assistant",
      content: <PiToolMessageContent t={t} message={entry} />,
      header: <MessageHeader label={t("chat.tool")} meta={entry.toolName} />
    };
  }

  if (entry.role === "local_result") {
    return {
      key: `${entry.role}-${entry.timestamp}-${index}`,
      role: "assistant",
      content: <PiLocalResultContent message={entry} />,
      header: <MessageHeader label={t("chat.localAction")} meta={entry.title} />
    };
  }

  return {
    key: `${entry.role}-${entry.timestamp}-${index}`,
    role: "assistant",
    content: <PiSummaryMessageContent message={entry} />,
    header: <MessageHeader label={entry.title} meta={t("chat.piSessionSummary")} />
  };
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

function shouldShowSlashSuggestions(value: string) {
  return /^\/[\w-]*$/.test(value);
}

function getSlashSuggestionItems(
  t: Translator,
  skills: Skill[],
  info?: SlashSuggestionInfo
): SuggestionItem[] {
  const query = info?.query.toLowerCase() || "";
  const matchedCommands = appSlashCommands.filter((command) =>
    command.name.toLowerCase().includes(query)
  );
  const matchedSkills = skills.filter((skill) =>
    skill.name.toLowerCase().includes(query)
  );

  return [
    ...matchedCommands.map((command) => ({
      label: (
        <div className="slash-command-option">
          <span>/{command.name}</span>
          <small>{t(command.descriptionKey as TranslationKey)}</small>
        </div>
      ),
      value: `/${command.name}`,
      extra: <span className="slash-command-source slash-command-badge-app">app</span>
    })),
    ...matchedSkills.map((skill) => ({
      label: (
        <div className="slash-command-option">
          <span>/{skill.name}</span>
          <small>{skill.description}</small>
        </div>
      ),
      value: `/${skill.name}`,
      extra: <span className="slash-command-source slash-command-badge-skill">skill</span>
    }))
  ];
}

function getWorkspaceName(cwd: string) {
  const normalized = cwd.replace(/\/$/, "");
  if (!normalized) return "workspace";

  const parts = normalized.split("/");
  return parts[parts.length - 1] || "workspace";
}

function readStoredMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function readEventStream(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.body) throw new Error("No response stream returned.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((item) => item.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)) as StreamEvent);
    }
  }
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => readStoredLocale());
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [input, setInput] = useState("");
  const [selectedImage, setSelectedImage] = useState<ImageAttachment | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [modelKey, setModelKey] = useState(() => {
    try {
      return localStorage.getItem("my-pi-model") || "openai:gpt-4o-mini";
    } catch {
      return "openai:gpt-4o-mini";
    }
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(modelPresets);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({
    modelKey: "",
    panelMode: "chat" as PanelMode,
    systemPrompt: "",
    locale,
    thinkingLevel: "high" as ThinkingLevel
  });
  const [renameDraft, setRenameDraft] = useState("");
  const [archivedPiSessionIds, setArchivedPiSessionIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ARCHIVED_PI_SESSIONS_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [draftAssistant, setDraftAssistant] = useState("");
  const [draftThinking, setDraftThinking] = useState("");
  const [draftThinkingVisible, setDraftThinkingVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    try {
      const stored = localStorage.getItem(PANEL_MODE_STORAGE_KEY);
      if (stored === "terminal" || stored === "chat") return stored;
    } catch {}
    return "chat";
  });
  const [serverCwd, setServerCwd] = useState("");
  const [projects, setProjects] = useState<PiSessionProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [activePanelView, setActivePanelView] = useState<ActivePanelView>({ kind: "empty" });
  const [piSessionDetail, setPiSessionDetail] = useState<PiSessionDetailResponse | null>(null);
  const [piLocalMessages, setPiLocalMessages] = useState<PiHistoryMessage[]>([]);
  const [piPendingMessages, setPiPendingMessages] = useState<PiHistoryMessage[]>([]);
  const [piSessionError, setPiSessionError] = useState<string | null>(null);
  const [piSessionLoading, setPiSessionLoading] = useState(false);
  const [draftToolMessages, setDraftToolMessages] = useState<Map<string, { toolName: string; content: string; isError: boolean }>>(new Map());
  const [launcherMode, setLauncherMode] = useState<LauncherMode>(null);
  const [newSessionQuery, setNewSessionQuery] = useState("");
  const [selectSessionQuery, setSelectSessionQuery] = useState("");
  const [launcherError, setLauncherError] = useState<string | null>(null);
  const [workspaceBrowseName, setWorkspaceBrowseName] = useState<string | null>(null);
  const [workspaceResolvedPath, setWorkspaceResolvedPath] = useState<string | null>(null);
  const [workspaceResolving, setWorkspaceResolving] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);

  const didHydrateSelectionRef = useRef(false);
  const piSessionRequestIdRef = useRef(0);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const thinkingFlushTimeoutRef = useRef<number | null>(null);
  const piHistoryMessages = piSessionDetail?.messages ?? [];
  const selectedPiSessionId = activePanelView.kind === "pi" ? activePanelView.sessionId : null;

  const terminalCwd = useMemo(() => {
    if (activePanelView.kind === "pi" && piSessionDetail) {
      return piSessionDetail.session.cwd;
    }
    return serverCwd || "";
  }, [activePanelView, piSessionDetail, serverCwd]);

  const terminalInitialCommand = useMemo(() => {
    if (activePanelView.kind === "pi") {
      return `pi --session ${activePanelView.sessionId}`;
    }
    return undefined;
  }, [activePanelView]);

  const selectedModel = useMemo(() => parseModelKey(modelKey), [modelKey]);
  const selectedModelOption = useMemo(() => {
    return modelOptions.find(
      (option) => getModelKey(option.provider, option.model) === modelKey
    );
  }, [modelKey, modelOptions]);
  const selectedModelSupportsImages = selectedModelOption?.supportsImages ?? false;
  const launcherWorkspaceName = getWorkspaceName(serverCwd);
  const filteredNewProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(newSessionQuery.trim().toLowerCase())
  );
  const filteredSelectableProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(selectSessionQuery.trim().toLowerCase())
  );

  function clearThinkingFlushTimeout() {
    if (thinkingFlushTimeoutRef.current === null) return;
    window.clearTimeout(thinkingFlushTimeoutRef.current);
    thinkingFlushTimeoutRef.current = null;
  }

  function resetStreamingDraft() {
    clearThinkingFlushTimeout();
    setDraftAssistant("");
    setDraftThinking("");
    setDraftThinkingVisible(false);
    setDraftToolMessages(new Map());
  }

  const draftToolBubbleItems = useMemo<BubbleItemType[]>(() => {
    if (draftToolMessages.size === 0) return [];

    return Array.from(draftToolMessages.entries()).map(([toolCallId, entry]) => ({
      key: `tool-streaming-${toolCallId}`,
      role: "assistant" as const,
      content: (
        <details className="pi-tool-card" open>
          <summary>
            <span>{entry.toolName}</span>
            <small>{t("chat.streaming")}</small>
          </summary>
          <pre>{entry.content || "…"}</pre>
        </details>
      ),
      header: <MessageHeader label={t("chat.tool")} meta={entry.toolName} />
    }));
  }, [draftToolMessages, t]);

  const thinkingBubbleItem = useMemo<BubbleItemType | null>(() => {
    if (!draftThinkingVisible) return null;

    return {
      key: "assistant-thinking",
      role: "assistant",
      content: (
        <div className="thinking-block thinking-block-static">
          <div className="thinking-block-title">{t("chat.thinking")}</div>
          <div className="thinking-content">{draftThinking}</div>
        </div>
      ),
      streaming: isStreaming,
      status: "updating" as const,
      header: <MessageHeader label={t("chat.myPi")} meta={t("chat.streaming")} />
    };
  }, [draftThinking, draftThinkingVisible, isStreaming, t]);

  const streamingAssistantBubbleItem = useMemo<BubbleItemType | null>(() => {
    if (!draftAssistant) return null;

    return {
      key: "assistant-streaming",
      role: "assistant",
      content: draftAssistant,
      streaming: isStreaming,
      status: "updating" as const,
      header: <MessageHeader label={t("chat.myPi")} meta={t("chat.streaming")} />
    };
  }, [draftAssistant, isStreaming, t]);

  const piHistoryBubbleItems = useMemo<BubbleItemType[]>(() => {
    const items = groupPiHistoryMessages([
      ...piHistoryMessages,
      ...piLocalMessages,
      ...piPendingMessages
    ]).map((entry, index) => createPiHistoryBubbleItem(entry, index, t));
    if (!thinkingBubbleItem && !streamingAssistantBubbleItem && draftToolBubbleItems.length === 0) return items;

    return [
      ...items,
      ...draftToolBubbleItems,
      ...(thinkingBubbleItem ? [thinkingBubbleItem] : []),
      ...(streamingAssistantBubbleItem ? [streamingAssistantBubbleItem] : [])
    ];
  }, [draftToolBubbleItems, piHistoryMessages, piLocalMessages, piPendingMessages, streamingAssistantBubbleItem, t, thinkingBubbleItem]);

  const panelTitle = selectedPiSessionId
    ? piSessionDetail?.session.name || t("chat.piSession")
    : t("launcher.title", { workspace: launcherWorkspaceName });
  const panelMeta =
    selectedPiSessionId && piSessionDetail
      ? `${piSessionDetail.session.projectName} · ${piSessionDetail.session.cwd}`
      : null;

  useEffect(() => {
    localStorage.setItem(PANEL_MODE_STORAGE_KEY, panelMode);
  }, [panelMode]);

  useEffect(() => {
    return () => {
      clearThinkingFlushTimeout();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage errors and keep the current in-memory preference.
    }
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    localStorage.setItem("my-pi-model", modelKey);
  }, [modelKey]);

  function persistSelectedPiSession(sessionId: string, projectPath: string | null) {
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    if (projectPath) {
      localStorage.setItem(ACTIVE_PI_PROJECT_KEY, projectPath);
    } else {
      localStorage.removeItem(ACTIVE_PI_PROJECT_KEY);
    }
  }

  function clearSelectedPiSession() {
    piSessionRequestIdRef.current += 1;
    setActivePanelView({ kind: "empty" });
    setPiSessionDetail(null);
    setPiLocalMessages([]);
    setPiSessionLoading(false);
    setPiSessionError(null);
    setPiPendingMessages([]);
    resetStreamingDraft();
    setError(null);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_PI_PROJECT_KEY);
  }

  async function selectPiSession(
    sessionId: string,
    options?: { persist?: boolean; projectPath?: string | null }
  ) {
    if (isStreaming) return;

    const requestId = piSessionRequestIdRef.current + 1;
    piSessionRequestIdRef.current = requestId;
    setActivePanelView({ kind: "pi", sessionId });
    setPiSessionDetail(null);
    setPiLocalMessages([]);
    setPiSessionLoading(true);
    setPiSessionError(null);
    setError(null);
    resetStreamingDraft();
    setPiPendingMessages([]);

    if (options?.persist !== false) {
      const projectPath =
        options?.projectPath ?? findProjectBySessionId(projects, sessionId)?.path ?? null;
      persistSelectedPiSession(sessionId, projectPath);
    }

    try {
      const response = await fetch(`/api/pi-sessions/${encodeURIComponent(sessionId)}`);
      const body = (await response.json().catch(() => null)) as
        | PiSessionDetailResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          body && "error" in body && body.error ? body.error : `Request failed with ${response.status}`
        );
      }

      if (piSessionRequestIdRef.current !== requestId) return;
      setPiSessionDetail(body as PiSessionDetailResponse);
    } catch (err) {
      if (piSessionRequestIdRef.current !== requestId) return;
      setPiSessionError(err instanceof Error ? err.message : "Failed to load Pi session");
    } finally {
      if (piSessionRequestIdRef.current === requestId) {
        setPiSessionLoading(false);
      }
    }
  }

  async function refreshPiProjects(options?: { hydrateSelection?: boolean }) {
    setProjectsLoading(true);
    setProjectsError(null);

    try {
      const response = await fetch("/api/pi-sessions");
      if (!response.ok) {
        throw new Error(`Failed to load Pi sessions: ${response.status}`);
      }

      const body = (await response.json()) as { projects: PiSessionProject[] };
      setProjects(body.projects);

      if (options?.hydrateSelection && !didHydrateSelectionRef.current) {
        didHydrateSelectionRef.current = true;
        const storedSessionId = localStorage.getItem(ACTIVE_SESSION_KEY);
        const storedProjectPath = localStorage.getItem(ACTIVE_PI_PROJECT_KEY);
        const initialSelection = resolveInitialPiSessionSelection({
          storedSessionId,
          storedProjectPath,
          projects: body.projects
        });

        if (initialSelection.kind === "pi") {
          const projectPath =
            findProjectBySessionId(body.projects, initialSelection.sessionId)?.path ||
            storedProjectPath;
          await selectPiSession(initialSelection.sessionId, {
            persist: true,
            projectPath
          });
        } else {
          clearSelectedPiSession();
        }
      }
    } catch (err) {
      setProjectsError(err instanceof Error ? err.message : t("sidebar.piCliUnavailable"));
      if (options?.hydrateSelection && !didHydrateSelectionRef.current) {
        didHydrateSelectionRef.current = true;
        clearSelectedPiSession();
      }
    } finally {
      setProjectsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const response = await fetch("/api/models");
        if (!response.ok) return;
        const body = (await response.json()) as { models?: ModelOption[] };
        if (cancelled || !body.models?.length) return;

        setModelOptions(body.models);
        setModelKey((current) => {
          const currentExists = body.models?.some(
            (option) => `${option.provider}:${option.model}` === current
          );
          return currentExists
            ? current
            : getModelKey(body.models![0].provider, body.models![0].model);
        });
      } catch {
        // Keep static presets when the model registry endpoint is unavailable.
      }
    }

    fetch("/api/skills")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.skills) {
          setSkills(data.skills);
        }
      })
      .catch(() => {});

    loadModels();
    fetch("/api/cwd")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.cwd) {
          setServerCwd(data.cwd);
        }
      })
      .catch(() => {});
    void refreshPiProjects({ hydrateSelection: true });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedImage && !selectedModelSupportsImages) {
      setSelectedImage(null);
      setError(t("errors.removedImageUnsupported"));
    }
  }, [selectedImage, selectedModelSupportsImages, t]);

  function openNewSessionLauncher() {
    setLauncherMode("new");
    setNewSessionQuery("");
    setLauncherError(null);
    setWorkspaceBrowseName(null);
    setWorkspaceResolvedPath(null);
    setWorkspaceResolving(false);
  }

  function openSelectSessionLauncher() {
    setLauncherMode("select");
    setSelectSessionQuery("");
    setLauncherError(null);
  }

  function closeLauncher() {
    setLauncherMode(null);
    setLauncherError(null);
    setWorkspaceBrowseName(null);
    setWorkspaceResolvedPath(null);
    setWorkspaceResolving(false);
  }

  function openRenameModal(sessionId: string) {
    const piName =
      piSessionDetail && piSessionDetail.session.id === sessionId
        ? piSessionDetail.session.name
        : findProjectBySessionId(projects, sessionId)?.sessions.find((session) => session.id === sessionId)?.name;
    setRenameTargetId(sessionId);
    setRenameDraft(piName || "");
  }

  function closeRenameModal() {
    setRenameTargetId(null);
    setRenameDraft("");
  }

  async function confirmRename() {
    const targetId = renameTargetId;
    if (!targetId) return;

    const newName = renameDraft.trim() || t("session.untitled");

    if (
      piSessionDetail &&
      activePanelView.kind === "pi" &&
      activePanelView.sessionId === targetId
    ) {
      setPiSessionDetail({
        ...piSessionDetail,
        session: { ...piSessionDetail.session, name: newName }
      });
    }

    try {
      await fetch(`/api/sessions/${encodeURIComponent(targetId)}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName })
      });
    } catch {
      // Keep optimistic UI update when rename persistence fails.
    }

    await refreshPiProjects();
    closeRenameModal();
  }

  function archivePiSession(sessionId: string) {
    setArchivedPiSessionIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      localStorage.setItem(ARCHIVED_PI_SESSIONS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function restorePiSession(sessionId: string) {
    setArchivedPiSessionIds((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      localStorage.setItem(ARCHIVED_PI_SESSIONS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  async function createPiSessionInProject(projectPath: string) {
    if (isStreaming) return;
    setLauncherError(null);

    try {
      const response = await fetch("/api/pi-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPath })
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error || `Request failed with ${response.status}`);
      }

      const body = (await response.json()) as { projects: PiSessionProject[] };
      setProjects(body.projects);
      const nextSessionId = getNewestProjectSessionId(body.projects, projectPath);
      closeLauncher();

      if (nextSessionId) {
        await selectPiSession(nextSessionId, { projectPath });
      } else {
        clearSelectedPiSession();
      }
    } catch (err) {
      setLauncherError(err instanceof Error ? err.message : t("workspace.newPiSession"));
    }
  }

  function handleBrowseClick() {
    projectFileInputRef.current?.click();
  }

  async function handleBrowseChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const path = files[0].webkitRelativePath;
    const folderName = path.split("/")[0];
    setWorkspaceBrowseName(folderName);
    setWorkspaceResolvedPath(null);
    setLauncherError(null);
    event.target.value = "";

    setWorkspaceResolving(true);
    try {
      const response = await fetch("/api/resolve-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName })
      });
      const body = (await response.json()) as {
        found: boolean;
        path?: string;
        error?: string;
      };

      if (body.found && body.path) {
        setWorkspaceResolvedPath(body.path);
        await createPiSessionInProject(body.path);
      } else {
        setLauncherError(body.error || `Could not find directory "${folderName}"`);
      }
    } catch (err) {
      setLauncherError(err instanceof Error ? err.message : t("workspace.resolving"));
    } finally {
      setWorkspaceResolving(false);
    }
  }

  async function openNewestSessionForProject(projectPath: string) {
    const sessionId = getNewestProjectSessionId(projects, projectPath);
    if (!sessionId) {
      setLauncherError(t("workspace.noneFound"));
      return;
    }

    closeLauncher();
    await selectPiSession(sessionId, { projectPath });
  }

  function handleSettingsConfirm() {
    setModelKey(settingsDraft.modelKey);
    setPanelMode(settingsDraft.panelMode);
    setSystemPrompt(settingsDraft.systemPrompt);
    setLocale(settingsDraft.locale);
    localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, settingsDraft.thinkingLevel);
    setIsSettingsOpen(false);
  }

  function handleSettingsCancel() {
    setIsSettingsOpen(false);
  }

  function openSettingsModal() {
    const storedThinkingLevel =
      (localStorage.getItem(THINKING_LEVEL_STORAGE_KEY) as ThinkingLevel | null) || "high";
    setSettingsDraft({ modelKey, panelMode, systemPrompt, locale, thinkingLevel: storedThinkingLevel });
    setIsSettingsOpen(true);
  }

  function createLocalUserMessage(content: string): Extract<PiHistoryMessage, { role: "user" }> {
    return {
      id: `local-user-${crypto.randomUUID()}`,
      role: "user",
      content,
      timestamp: Date.now()
    };
  }

  function createLocalResultMessage(
    result: LocalActionResult
  ): Extract<PiHistoryMessage, { role: "local_result" }> {
    return {
      id: `local-result-${crypto.randomUUID()}`,
      role: "local_result",
      title: result.title,
      content: result.content,
      status: result.status,
      timestamp: Date.now()
    };
  }

  function appendPiLocalTurn(
    userMessage: Extract<PiHistoryMessage, { role: "user" }>,
    result: LocalActionResult
  ) {
    setPiLocalMessages((current) => [
      ...current,
      userMessage,
      createLocalResultMessage(result)
    ]);
  }

  async function runClientSlashAction(
    commandName: "settings" | "model" | "copy"
  ): Promise<LocalActionResult> {
    if (commandName === "settings") {
      openSettingsModal();
      return {
        title: "Settings",
        content: "Opened the Settings panel.",
        status: "success"
      };
    }

    if (commandName === "model") {
      openSettingsModal();
      return {
        title: "Model",
        content: "Opened Settings. Update the model from the Settings panel.",
        status: "success"
      };
    }

    const latestAssistant = [...piHistoryMessages]
      .reverse()
      .find((message): message is Extract<PiHistoryMessage, { role: "assistant" }> => message.role === "assistant");

    if (!latestAssistant?.content) {
      return {
        title: "Copy",
        content: "No assistant message is available to copy yet.",
        status: "error"
      };
    }

    try {
      await navigator.clipboard.writeText(latestAssistant.content);
      return {
        title: "Copy",
        content: `Copied the last assistant message to the clipboard (${latestAssistant.content.length} characters).`,
        status: "success"
      };
    } catch (error) {
      return {
        title: "Copy",
        content:
          error instanceof Error
            ? `Failed to copy the last assistant message: ${error.message}`
            : "Failed to copy the last assistant message.",
        status: "error"
      };
    }
  }

  async function runServerSlashAction(
    action: "session" | "export" | "name",
    args: string
  ): Promise<LocalActionResult> {
    const response = await fetch("/api/pi-local-actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pi-session-id": activePanelView.kind === "pi" ? activePanelView.sessionId : ""
      },
      body: JSON.stringify({ action, args })
    });

    const body = (await response.json().catch(() => null)) as
      | { result?: LocalActionResult; error?: string }
      | null;

    if (!response.ok || !body?.result) {
      throw new Error(body?.error || `Request failed with ${response.status}`);
    }

    return body.result;
  }

  async function submitLocalSlashAction(trimmedInput: string): Promise<boolean> {
    const parsed = parseSlashCommandInput(trimmedInput);
    if (!parsed) return false;

    const command = findAppSlashCommand(parsed.normalizedName);
    if (!command) return false;

    const userMessage = createLocalUserMessage(trimmedInput);
    setInput("");
    setSelectedImage(null);
    setError(null);

    try {
      setIsStreaming(true);
      const result = isServerAppSlashCommand(command)
        ? await runServerSlashAction(command.name, parsed.args)
        : await runClientSlashAction(command.name);

      appendPiLocalTurn(userMessage, result);

      if (result.updatedSessionName) {
        setPiSessionDetail((current) =>
          current
            ? {
                ...current,
                session: {
                  ...current.session,
                  name: result.updatedSessionName || current.session.name
                }
              }
            : current
        );
      }

      if (result.refreshProjects) {
        await refreshPiProjects();
      }
    } catch (error) {
      appendPiLocalTurn(userMessage, {
        title: command.name,
        content:
          error instanceof Error
            ? error.message
            : "The local action failed unexpectedly.",
        status: "error"
      });
    } finally {
      setIsStreaming(false);
    }

    return true;
  }

  async function submitMessage(messageText: string) {
    const trimmed = messageText.trim();
    if ((!trimmed && !selectedImage) || isStreaming || activePanelView.kind !== "pi") return;

    if (await submitLocalSlashAction(trimmed)) {
      return;
    }

    if (selectedImage && !selectedModelSupportsImages) {
      setError(t("errors.noImageSupport"));
      return;
    }

    const userMessage: UserMessage = {
      role: "user",
      content: trimmed || t("composer.defaultImagePrompt"),
      images: selectedImage ? [selectedImage] : undefined,
      timestamp: Date.now()
    };

    setPiPendingMessages([
      {
        id: `pi-user-${userMessage.timestamp}`,
        role: "user",
        content: userMessage.content,
        images: userMessage.images,
        timestamp: userMessage.timestamp
      }
    ]);

    setInput("");
    setSelectedImage(null);
    resetStreamingDraft();
    setError(null);
    setIsStreaming(true);

    let streamState = createPiSessionStreamingState(panelMode);
    setDraftThinkingVisible(streamState.thinkingVisible);

    const syncStreamingDraft = () => {
      setDraftAssistant(streamState.assistant);
      setDraftThinkingVisible(streamState.thinkingVisible);
      setDraftThinking(streamState.visibleThinking);
      setDraftToolMessages(new Map(streamState.activeToolMessages));
    };

    const flushThinkingDraft = () => {
      thinkingFlushTimeoutRef.current = null;
      streamState = flushPiSessionThinking(streamState);
      syncStreamingDraft();
    };

    const scheduleThinkingFlush = () => {
      if (thinkingFlushTimeoutRef.current !== null) return;

      thinkingFlushTimeoutRef.current = window.setTimeout(() => {
        flushThinkingDraft();
      }, 75);
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pi-session-id": activePanelView.sessionId
        },
        body: JSON.stringify({
          ...selectedModel,
          prompt: userMessage.content,
          thinkingLevel:
            (localStorage.getItem(THINKING_LEVEL_STORAGE_KEY) as ThinkingLevel | null) ||
            "high",
          images: userMessage.images?.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            size: image.size,
            data: image.data
          }))
        })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Request failed with ${response.status}`);
      }

      await readEventStream(response, (streamEvent) => {
        streamState = applyPiSessionStreamingEvent(streamState, streamEvent);

        if (streamEvent.type === "thinking") {
          if (streamState.acceptsThinking && streamState.bufferedThinking) {
            scheduleThinkingFlush();
          }
          return;
        }

        clearThinkingFlushTimeout();
        if (streamEvent.type !== "done" && streamEvent.type !== "error") {
          streamState = flushPiSessionThinking(streamState);
        }
        syncStreamingDraft();

        if (streamEvent.type === "error") {
          setError(streamEvent.error);
        }
      });

      if (streamState.finalMessage) {
        // Build the assistant message with intermediate tool results embedded.
        const fm = streamState.finalMessage as AssistantMessage;
        const finalAssistantMsg: AssistantMessage = {
          role: "assistant",
          content: fm.content,
          provider: fm.provider,
          model: fm.model,
          timestamp: fm.timestamp
        };

        const pendingUserMsg: PiHistoryMessage = {
          id: `pi-user-${Date.now()}`,
          role: "user",
          content: userMessage.content,
          images: userMessage.images,
          timestamp: userMessage.timestamp
        };
        const toolBaseTimestamp = finalAssistantMsg.timestamp - streamState.completedToolMessages.length;
        const toolMsgs: Extract<PiHistoryMessage, { role: "tool" }>[] = streamState.completedToolMessages.map(
          (tool, index) =>
            ({
              id: `tool-${Date.now()}-${index}`,
              role: "tool",
              toolName: tool.toolName,
              content: tool.content,
              isError: tool.isError,
              expandable: true,
              timestamp: toolBaseTimestamp + index
            }) as Extract<PiHistoryMessage, { role: "tool" }>
        );
        setPiSessionDetail((current) =>
          current
            ? {
                ...current,
                session: {
                  ...current.session,
                  modified: new Date(finalAssistantMsg.timestamp).toISOString()
                },
                messages: [
                  ...current.messages,
                  pendingUserMsg,
                  ...toolMsgs,
                  {
                    id: finalAssistantMsg.content.slice(0, 32),
                    role: "assistant",
                    content: finalAssistantMsg.content,
                    provider: finalAssistantMsg.provider,
                    model: finalAssistantMsg.model,
                    timestamp: finalAssistantMsg.timestamp
                  } as Extract<PiHistoryMessage, { role: "assistant" }>
                ]
              }
            : current
        );
        setPiPendingMessages([]);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "No response stream returned.") {
        setError(t("errors.streamMissing"));
      } else {
        setError(err instanceof Error ? err.message : t("errors.unexpectedChat"));
      }
      setPiPendingMessages([]);
    } finally {
      resetStreamingDraft();
      setIsStreaming(false);
    }
  }

  function handleSlashSelect(value: string) {
    setInput(`${value} `);
  }

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!selectedModelSupportsImages) {
      setError(t("errors.noImageSupport"));
      return;
    }
    if (!supportedImageMimeTypes.includes(file.type)) {
      setError(t("errors.uploadSupportedImage"));
      return;
    }
    if (file.size > maxImageBytes) {
      setError(t("errors.imageTooLarge"));
      return;
    }

    try {
      const data = await readFileAsBase64(file);
      setSelectedImage({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        data
      });
      setError(null);
    } catch {
      setError(t("errors.readImageFailed"));
    }
  }

  const launcherActions = (
    <div className="launcher-actions">
      <button className="settings-btn settings-btn-confirm" type="button" onClick={openNewSessionLauncher}>
        {t("launcher.newPiSession")}
      </button>
      <button className="settings-btn settings-btn-cancel" type="button" onClick={openSelectSessionLauncher}>
        {t("launcher.selectPiSession")}
      </button>
    </div>
  );

  return (
    <XProvider theme={xTheme}>
      <main className={`app-shell${sidebarCollapsed ? " app-shell-collapsed" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-inner">
            <div className="sidebar-top-row">
              <div className="sidebar-brand-icon">
                <svg width="28" height="28" viewBox="0 0 128 128" fill="none">
                  <rect x="8" y="8" width="112" height="112" rx="22" fill="var(--canvas)" stroke="var(--sidebar-border)" strokeWidth="3" />
                  <g transform="translate(64, 44)">
                    <line x1="-30" y1="0" x2="30" y2="0" stroke="var(--primary)" strokeWidth="10" strokeLinecap="round" />
                    <line x1="-18" y1="0" x2="-18" y2="34" stroke="var(--primary)" strokeWidth="10" strokeLinecap="round" />
                    <line x1="18" y1="0" x2="18" y2="34" stroke="var(--primary)" strokeWidth="10" strokeLinecap="round" />
                  </g>
                </svg>
              </div>
              <div className="sidebar-actions">
                <button
                  className="icon-button"
                  disabled={isStreaming}
                  type="button"
                  title={t("sidebar.newPiSession")}
                  onClick={openNewSessionLauncher}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  className="icon-button"
                  type="button"
                  title={t("settings.title")}
                  onClick={openSettingsModal}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
                <button
                  className="sidebar-collapse-btn"
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  title={t("sidebar.collapse")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              </div>
            </div>

            <PiSessionSection
              error={projectsError}
              isStreaming={isStreaming}
              locale={locale}
              loading={projectsLoading}
              onCreateSessionInProject={(projectPath) => {
                void createPiSessionInProject(projectPath);
              }}
              projects={projects}
              selectedSessionId={selectedPiSessionId}
              onSelectSession={(sessionId) => {
                void selectPiSession(sessionId);
              }}
              onRename={openRenameModal}
              archivedSessionIds={archivedPiSessionIds}
              onArchive={archivePiSession}
              onRestore={restorePiSession}
            />
          </div>
        </aside>

        {sidebarCollapsed && (
          <button
            className="sidebar-expand-btn"
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            title={t("sidebar.expand")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}

        {panelMode === "terminal" ? (
          <section className="chat-panel" aria-label={t("panel.terminal")}>
            <header className="chat-header">
              <div className="chat-header-copy">
                <span className="chat-header-title">{t("panel.terminal")}</span>
                <small className="chat-header-meta">{terminalCwd}</small>
              </div>
            </header>
            {activePanelView.kind === "empty" ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>{t("launcher.title", { workspace: launcherWorkspaceName })}</h3>
                  <p>{t("launcher.body")}</p>
                  {launcherActions}
                </div>
              </div>
            ) : activePanelView.kind === "pi" && !piSessionDetail ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>{t("panel.loadingTerminalTitle")}</h3>
                  <p>{t("panel.loadingTerminalBody")}</p>
                </div>
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="messages messages-empty">
                    <div className="empty-state">
                      <h3>{t("panel.loadingTerminalTitle")}</h3>
                    </div>
                  </div>
                }
              >
                <TerminalPanel
                  cwd={terminalCwd}
                  initialCommand={terminalInitialCommand}
                  locale={locale}
                  sessionId={selectedPiSessionId ?? undefined}
                />
              </Suspense>
            )}
          </section>
        ) : (
          <section className="chat-panel" aria-label={t("chat.agentDialogue")}>
            <header className="chat-header">
              <div className="chat-header-copy">
                <span className="chat-header-title">{panelTitle}</span>
                {panelMeta ? <small className="chat-header-meta">{panelMeta}</small> : null}
              </div>
              {piSessionDetail ? (
                <button
                  className="chat-header-action-btn"
                  type="button"
                  title={t("panel.openEditor")}
                  onClick={() => {
                    const cwd = piSessionDetail?.session.cwd;
                    if (cwd) window.open(`vscode://file/${encodeURIComponent(cwd)}`);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </button>
              ) : null}
            </header>

            {activePanelView.kind === "empty" ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>{t("launcher.title", { workspace: launcherWorkspaceName })}</h3>
                  <p>{t("launcher.body")}</p>
                  {launcherActions}
                  {projectsError ? <div className="error-banner">{projectsError}</div> : null}
                </div>
              </div>
            ) : piSessionError ? (
              <div className="messages messages-empty">
                <div className="error-banner">
                  <p>{piSessionError}</p>
                  <button
                    className="inline-action-button"
                    type="button"
                    onClick={() => {
                      void selectPiSession(activePanelView.sessionId);
                    }}
                  >
                    {t("panel.retry")}
                  </button>
                </div>
              </div>
            ) : !piSessionDetail ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>{t("sidebar.loadingPiSessionTitle")}</h3>
                  <p>{t("sidebar.loadingPiSessionBody")}</p>
                </div>
              </div>
            ) : piHistoryBubbleItems.length === 0 ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>{t("session.newPiTitle")}</h3>
                  <p>{t("session.newPiBody")}</p>
                </div>
              </div>
            ) : (
              <div className="messages">
                <Bubble.List
                  autoScroll
                  className="chat-bubble-list"
                  items={piHistoryBubbleItems}
                  role={bubbleRoles}
                />
                {error && <div className="error-banner">{error}</div>}
              </div>
            )}

            {activePanelView.kind === "pi" ? (
              <div className="composer">
                {selectedImage ? (
                  <div className="attachment-preview">
                    <img alt={selectedImage.name} src={getImageDataUrl(selectedImage)} />
                    <div>
                      <strong>{selectedImage.name}</strong>
                      <span>{t("composer.attachmentMeta", { size: Math.ceil(selectedImage.size / 1024) })}</span>
                    </div>
                    <button type="button" onClick={() => setSelectedImage(null)}>
                      {t("composer.remove")}
                    </button>
                  </div>
                ) : null}
                <input
                  className="composer-upload-input"
                  accept={supportedImageMimeTypes.join(",")}
                  onChange={handleImageChange}
                  type="file"
                />
                <Suggestion<SlashSuggestionInfo>
                  block
                  className="slash-command-suggestion"
                  items={(info) => getSlashSuggestionItems(t, skills, info)}
                  onSelect={handleSlashSelect}
                >
                  {({ onKeyDown, onTrigger }) => (
                    <Sender
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      className="chat-sender"
                      disabled={isStreaming || piSessionLoading || Boolean(piSessionError)}
                      loading={isStreaming}
                      onChange={(value) => {
                        setInput(value);
                        onTrigger(
                          shouldShowSlashSuggestions(value)
                            ? { query: value.slice(1) }
                            : false
                        );
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        onKeyDown(event);
                      }}
                      onSubmit={submitMessage}
                      placeholder={t("composer.continuePiSession")}
                      submitType="enter"
                      value={input}
                    />
                  )}
                </Suggestion>
              </div>
            ) : null}
          </section>
        )}
      </main>
      <input
        ref={projectFileInputRef}
        type="file"
        className="workspace-file-input"
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={handleBrowseChange}
      />
      <Modal
        centered
        open={isSettingsOpen}
        title={t("settings.title")}
        footer={
          <div className="settings-footer">
            <button className="settings-btn settings-btn-cancel" type="button" onClick={handleSettingsCancel}>
              {t("settings.cancel")}
            </button>
            <button className="settings-btn settings-btn-confirm" type="button" onClick={handleSettingsConfirm}>
              {t("settings.confirm")}
            </button>
          </div>
        }
        onCancel={handleSettingsCancel}
      >
        <div className="settings-modal-content">
          <label className="field">
            <span>{t("settings.model")}</span>
            <select value={settingsDraft.modelKey} onChange={(event) => setSettingsDraft((prev) => ({ ...prev, modelKey: event.target.value }))}>
              {modelOptions.map((preset) => (
                <option key={getModelKey(preset.provider, preset.model)} value={getModelKey(preset.provider, preset.model)}>
                  {preset.label}{preset.supportsImages ? " · vision" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t("settings.language")}</span>
            <select
              value={settingsDraft.locale}
              onChange={(event) => setSettingsDraft((prev) => ({ ...prev, locale: event.target.value as Locale }))}
            >
              {localeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small className="field-note">{t("settings.languageHelp")}</small>
          </label>

          <label className="field">
            <span>{t("settings.panelMode")}</span>
            <select
              value={settingsDraft.panelMode}
              onChange={(event) => setSettingsDraft((prev) => ({ ...prev, panelMode: event.target.value as PanelMode }))}
            >
              <option value="chat">{t("settings.chatMode")}</option>
              <option value="terminal">{t("settings.terminalMode")}</option>
            </select>
          </label>

          <label className="field">
            <span>{t("settings.thinkingLevel")}</span>
            <select
              value={settingsDraft.thinkingLevel}
              onChange={(event) => setSettingsDraft((prev) => ({ ...prev, thinkingLevel: event.target.value as ThinkingLevel }))}
            >
              <option value="off">{t("settings.thinkingOff")}</option>
              <option value="minimal">{t("settings.thinkingMinimal")}</option>
              <option value="low">{t("settings.thinkingLow")}</option>
              <option value="medium">{t("settings.thinkingMedium")}</option>
              <option value="high">{t("settings.thinkingHigh")}</option>
              <option value="xhigh">{t("settings.thinkingXhigh")}</option>
            </select>
            <small className="field-note">{t("settings.thinkingLevelHelp")}</small>
          </label>

          <label className="field">
            <span>{t("settings.systemPrompt")}</span>
            <textarea
              value={settingsDraft.systemPrompt}
              rows={7}
              onChange={(event) => setSettingsDraft((prev) => ({ ...prev, systemPrompt: event.target.value }))}
            />
          </label>
        </div>
      </Modal>

      <Modal
        centered
        open={renameTargetId !== null}
        title={t("session.renameTitle")}
        okText={t("actions.rename")}
        cancelText={t("settings.cancel")}
        onOk={() => { void confirmRename(); }}
        onCancel={closeRenameModal}
      >
        <Input
          autoFocus
          value={renameDraft}
          placeholder={t("session.renamePlaceholder")}
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void confirmRename();
            if (event.key === "Escape") closeRenameModal();
          }}
        />
      </Modal>

      <Modal
        centered
        open={launcherMode === "new"}
        title={t("launcher.newPiSession")}
        footer={null}
        onCancel={closeLauncher}
      >
        <div className="launcher-modal-body">
          <p className="workspace-description">{t("launcher.newPiSessionBody")}</p>
          <Input
            value={newSessionQuery}
            placeholder={t("launcher.searchProjects")}
            onChange={(event) => setNewSessionQuery(event.target.value)}
          />

          <div className="launcher-project-list">
            {filteredNewProjects.map((project) => (
              <button
                className="launcher-project-button"
                key={project.path}
                type="button"
                onClick={() => {
                  void createPiSessionInProject(project.path);
                }}
              >
                <span>{project.name}</span>
                <small>{formatMessageCount(locale, project.sessions.length)}</small>
              </button>
            ))}
            {filteredNewProjects.length === 0 ? (
              <div className="pi-sessions-empty">{t("launcher.noProjectsFound")}</div>
            ) : null}
          </div>

          <div className="launcher-add-project">
            <button
              className="workspace-browse-btn launcher-add-project-button"
              type="button"
              onClick={handleBrowseClick}
            >
              {t("launcher.addProject")}
            </button>
            {workspaceResolving ? (
              <span className="workspace-resolving-label">{t("workspace.resolving")}</span>
            ) : null}
            {workspaceResolvedPath && !workspaceResolving ? (
              <span className="workspace-resolved-label">
                ✓ <strong>{workspaceBrowseName}</strong>
                <small>{workspaceResolvedPath}</small>
              </span>
            ) : null}
          </div>

          {launcherError ? <div className="workspace-error">{launcherError}</div> : null}
        </div>
      </Modal>

      <Modal
        centered
        open={launcherMode === "select"}
        title={t("launcher.selectPiSession")}
        footer={null}
        onCancel={closeLauncher}
      >
        <div className="launcher-modal-body">
          <p className="workspace-description">{t("launcher.selectPiSessionBody")}</p>
          <Input
            value={selectSessionQuery}
            placeholder={t("launcher.searchProjects")}
            onChange={(event) => setSelectSessionQuery(event.target.value)}
          />

          <div className="launcher-project-list">
            {filteredSelectableProjects.map((project) => (
              <button
                className="launcher-project-button"
                key={project.path}
                type="button"
                onClick={() => {
                  void openNewestSessionForProject(project.path);
                }}
              >
                <span>{project.name}</span>
                <small>{project.sessions[0]?.name || project.sessions[0]?.firstMessage || t("chat.piSession")}</small>
              </button>
            ))}
            {filteredSelectableProjects.length === 0 ? (
              <div className="pi-sessions-empty">{t("launcher.noProjectsFound")}</div>
            ) : null}
          </div>

          {launcherError ? <div className="workspace-error">{launcherError}</div> : null}
        </div>
      </Modal>
    </XProvider>
  );
}
