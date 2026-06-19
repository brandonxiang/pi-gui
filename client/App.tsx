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
import type {
  AssistantMessage,
  ChatMessage,
  ImageAttachment,
  PiHistoryMessage,
  PiSessionDetailResponse,
  StreamEvent,
  UserMessage
} from "./types";
import { PiSessionSection } from "./PiSessionSection";

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
type ChatSession = {
  id: string;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};
type ActivePanelView = { kind: "local" } | { kind: "pi"; sessionId: string };

const defaultSystemPrompt =
  "You are My Pi, an online agent conversation assistant. Be concise, practical, and explicit about assumptions.";

const slashCommands: Array<{ name: string; descriptionKey: TranslationKey }> = [
  { name: "settings", descriptionKey: "slash.settings" },
  { name: "model", descriptionKey: "slash.model" },
  { name: "scoped-models", descriptionKey: "slash.scoped-models" },
  { name: "export", descriptionKey: "slash.export" },
  { name: "import", descriptionKey: "slash.import" },
  { name: "share", descriptionKey: "slash.share" },
  { name: "copy", descriptionKey: "slash.copy" },
  { name: "name", descriptionKey: "slash.name" },
  { name: "session", descriptionKey: "slash.session" },
  { name: "changelog", descriptionKey: "slash.changelog" },
  { name: "hotkeys", descriptionKey: "slash.hotkeys" },
  { name: "fork", descriptionKey: "slash.fork" },
  { name: "clone", descriptionKey: "slash.clone" },
  { name: "tree", descriptionKey: "slash.tree" },
  { name: "login", descriptionKey: "slash.login" },
  { name: "logout", descriptionKey: "slash.logout" },
  { name: "new", descriptionKey: "slash.new" },
  { name: "compact", descriptionKey: "slash.compact" },
  { name: "resume", descriptionKey: "slash.resume" },
  { name: "reload", descriptionKey: "slash.reload" },
  { name: "quit", descriptionKey: "slash.quit" }
];

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

function createPiHistoryBubbleItem(message: PiHistoryMessage, index: number, t: Translator): BubbleItemType {
  if (message.role === "user") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "user",
      content: <PiHistoryUserMessageContent message={message} />,
      header: <MessageHeader label={t("chat.piSession")} meta={t("chat.user")} />
    };
  }

  if (message.role === "assistant") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "assistant",
      content: message.content,
      header: (
        <MessageHeader
          label={t("chat.piSession")}
          meta={message.provider && message.model ? `${message.provider}/${message.model}` : t("chat.assistant")}
        />
      )
    };
  }

  if (message.role === "tool") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "assistant",
      content: <PiToolMessageContent t={t} message={message} />,
      header: <MessageHeader label={t("chat.tool")} meta={message.toolName} />
    };
  }

  return {
    key: `${message.role}-${message.timestamp}-${index}`,
    role: "assistant",
    content: <PiSummaryMessageContent message={message} />,
    header: <MessageHeader label={message.title} meta={t("chat.piSessionSummary")} />
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

function getSlashSuggestionItems(t: Translator, info?: SlashSuggestionInfo): SuggestionItem[] {
  const query = info?.query.toLowerCase() || "";
  const matchedCommands = slashCommands.filter((command) =>
    command.name.toLowerCase().includes(query)
  );

  return matchedCommands.map((command) => ({
    label: (
      <div className="slash-command-option">
        <span>/{command.name}</span>
        <small>{t(command.descriptionKey)}</small>
      </div>
    ),
    value: `/${command.name}`,
    extra: <span className="slash-command-source">pi</span>
  }));
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
  const initialSessions = useMemo(() => readStoredSessions(locale), []);
  const [sessions, setSessions] = useState<ChatSession[]>(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
    return initialSessions.some((session) => session.id === stored) ? stored! : initialSessions[0].id;
  });
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
    locale
  });
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [piRefreshKey, setPiRefreshKey] = useState(0);
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    try {
      const stored = localStorage.getItem(PANEL_MODE_STORAGE_KEY);
      if (stored === "terminal" || stored === "chat") return stored;
    } catch {}
    return "chat";
  });
  const [serverCwd, setServerCwd] = useState("");
  const [activePanelView, setActivePanelView] = useState<ActivePanelView>({ kind: "local" });
  const [piSessionDetail, setPiSessionDetail] = useState<PiSessionDetailResponse | null>(null);
  const [piPendingMessages, setPiPendingMessages] = useState<PiHistoryMessage[]>([]);
  const [piSessionError, setPiSessionError] = useState<string | null>(null);
  const [piSessionLoading, setPiSessionLoading] = useState(false);
  const [draftToolMessages, setDraftToolMessages] = useState<Map<string, { toolName: string; content: string; isError: boolean }>>(new Map());

  /* ───── Resolve cwd for terminal panel ───── */
  const terminalCwd = useMemo(() => {
    if (activePanelView.kind === "pi" && piSessionDetail) {
      return piSessionDetail.session.cwd;
    }
    return serverCwd || "";
  }, [activePanelView, piSessionDetail, serverCwd]);

  /* ───── Resolve initial command for terminal panel ───── */
  // In terminal mode with a Pi session selected, auto-launch pi into that session.
  // Uses activePanelView directly so it works immediately without waiting for piSessionDetail.
  const terminalInitialCommand = useMemo(() => {
    if (activePanelView.kind === "pi") {
      return `pi --session ${activePanelView.sessionId}`;
    }
    return undefined;
  }, [activePanelView]);

  /* ───── Persist panel mode ───── */
  useEffect(() => {
    localStorage.setItem(PANEL_MODE_STORAGE_KEY, panelMode);
  }, [panelMode]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage errors and keep the current in-memory preference.
    }
    document.documentElement.lang = locale;
  }, [locale]);

  const sessionIdRef = useRef<string>("");
  const piSessionRequestIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeSession = useMemo(() => {
    return sessions.find((session) => session.id === activeSessionId) || sessions[0];
  }, [activeSessionId, sessions]);

  const messages = activeSession?.messages ?? [];
  const piHistoryMessages = piSessionDetail?.messages ?? [];

  const visibleSessions = useMemo(() => {
    return sessions
      .filter((session) => !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions]);

  const archivedSessions = useMemo(() => {
    return sessions
      .filter((session) => session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions]);

  const selectedModel = useMemo(() => {
    return parseModelKey(modelKey);
  }, [modelKey]);

  const selectedModelOption = useMemo(() => {
    return modelOptions.find(
      (option) => getModelKey(option.provider, option.model) === modelKey
    );
  }, [modelKey, modelOptions]);

  const selectedModelSupportsImages = selectedModelOption?.supportsImages ?? false;

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

  const streamingBubbleItem = useMemo<BubbleItemType | null>(() => {
    if (!draftAssistant && !draftThinking && draftToolMessages.size === 0) return null;
    if (!draftAssistant && !draftThinking) return null;

    const content = draftThinking ? (
      <div>
        {draftThinking ? (
          <details className="thinking-block" open>
            <summary>{t("chat.thinking")}</summary>
            <div className="thinking-content">{draftThinking}</div>
          </details>
        ) : null}
        {draftAssistant ? <RenderMarkdown content={draftAssistant} /> : null}
      </div>
    ) : (
      draftAssistant
    );

    return {
      key: "assistant-streaming",
      role: "assistant",
      content,
      streaming: isStreaming,
      status: "updating" as const,
      header: <MessageHeader label={t("chat.myPi")} meta={t("chat.streaming")} />
    };
  }, [draftAssistant, draftThinking, draftToolMessages, isStreaming, t]);

  const localBubbleItems = useMemo<BubbleItemType[]>(() => {
    const storedItems = messages.map((message, index) => createBubbleItem(message, index, locale, t));
    if (!streamingBubbleItem && draftToolBubbleItems.length === 0) return storedItems;

    return [
      ...storedItems,
      ...draftToolBubbleItems,
      ...(streamingBubbleItem ? [streamingBubbleItem] : [])
    ];
  }, [draftToolBubbleItems, locale, messages, streamingBubbleItem, t]);

  const piHistoryBubbleItems = useMemo<BubbleItemType[]>(() => {
    const items = [...piHistoryMessages, ...piPendingMessages].map((message, index) =>
      createPiHistoryBubbleItem(message, index, t)
    );
    if (!streamingBubbleItem && draftToolBubbleItems.length === 0) return items;

    return [
      ...items,
      ...draftToolBubbleItems,
      ...(streamingBubbleItem ? [streamingBubbleItem] : [])
    ];
  }, [draftToolBubbleItems, piHistoryMessages, piPendingMessages, streamingBubbleItem, t]);

  const isPiHistoryView = activePanelView.kind === "pi";
  const panelTitle = isPiHistoryView
    ? piSessionDetail?.session.name || t("chat.piSession")
    : activeSession?.title || t("chat.agentDialogue");
  const panelMeta =
    isPiHistoryView && piSessionDetail
      ? `${piSessionDetail.session.projectName} · ${piSessionDetail.session.cwd}`
      : null;

  useEffect(() => {
    sessionIdRef.current = activeSessionId;
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  }, [activeSessionId]);

  // Persist model selection
  useEffect(() => {
    localStorage.setItem("my-pi-model", modelKey);
  }, [modelKey]);

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

    loadModels();

    // Load server cwd for terminal panel
    fetch("/api/cwd")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.cwd) {
          setServerCwd(data.cwd);
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (selectedImage && !selectedModelSupportsImages) {
      setSelectedImage(null);
      setError(t("errors.removedImageUnsupported"));
    }
  }, [selectedImage, selectedModelSupportsImages, t]);

  function updateSession(sessionId: string, updater: (session: ChatSession) => ChatSession) {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...updater(session),
              updatedAt: Date.now()
            }
          : session
      )
    );
  }

  function createNewSession() {
    const nextSession = createSession(t("session.untitled"));
    setSessions((current) => [nextSession, ...current]);
    setActiveSessionId(nextSession.id);
    setActivePanelView({ kind: "local" });
    setInput("");
    setSelectedImage(null);
    setDraftAssistant("");
    setDraftThinking("");
    setError(null);
    setPiPendingMessages([]);
  }

  function openRenameModal(sessionId: string) {
    const localSession = sessions.find((s) => s.id === sessionId);
    const piName =
      piSessionDetail && piSessionDetail.session.id === sessionId
        ? piSessionDetail.session.name
        : undefined;
    setRenameTargetId(sessionId);
    setRenameDraft(localSession?.title || piName || "");
  }

  function closeRenameModal() {
    setRenameTargetId(null);
    setRenameDraft("");
  }

  async function confirmRename() {
    const targetId = renameTargetId;
    if (!targetId) return;

    const newName = renameDraft.trim() || t("session.untitled");

    // Update local session title immediately.
    updateSession(targetId, (session) => ({ ...session, title: newName }));

    // Update Pi session header immediately if this is the active Pi session.
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

    // Persist to disk via API.
    try {
      await fetch(`/api/sessions/${encodeURIComponent(targetId)}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName })
      });
    } catch {
      // Ignore API errors for local-only sessions.
    }

    // Refresh Pi session sidebar after rename.
    setPiRefreshKey((k) => k + 1);

    closeRenameModal();
  }

  function archiveLocalSession(sessionId: string) {
    updateSession(sessionId, (session) => ({ ...session, archived: true }));
    if (activePanelView.kind === "local" && activeSessionId === sessionId) {
      const nextActive =
        visibleSessions.find((session) => session.id !== sessionId) ||
        createSession(t("session.untitled"));
      if (!sessions.some((session) => session.id === nextActive.id)) {
        setSessions((current) => [nextActive, ...current]);
      }
      setActiveSessionId(nextActive.id);
      setActivePanelView({ kind: "local" });
      setDraftAssistant("");
      setDraftThinking("");
      setInput("");
      setSelectedImage(null);
      setPiPendingMessages([]);
    }
  }

  function restoreLocalSession(sessionId: string) {
    updateSession(sessionId, (session) => ({ ...session, archived: false }));
    setActiveSessionId(sessionId);
    setActivePanelView({ kind: "local" });
    setPiPendingMessages([]);
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

  function selectLocalSession(sessionId: string) {
    piSessionRequestIdRef.current += 1;
    setActiveSessionId(sessionId);
    setActivePanelView({ kind: "local" });
    setPiSessionLoading(false);
    setPiSessionError(null);
    setError(null);
    setDraftAssistant("");
    setDraftThinking("");
    setPiPendingMessages([]);
  }

  async function selectPiSession(sessionId: string) {
    if (isStreaming) return;

    const requestId = piSessionRequestIdRef.current + 1;
    piSessionRequestIdRef.current = requestId;
    setActivePanelView({ kind: "pi", sessionId });
    setPiSessionDetail(null);
    setPiSessionLoading(true);
    setPiSessionError(null);
    setError(null);
    setDraftAssistant("");
    setDraftThinking("");
    setPiPendingMessages([]);

    try {
      const response = await fetch(`/api/pi-sessions/${encodeURIComponent(sessionId)}`);
      const body = (await response.json().catch(() => null)) as
        | PiSessionDetailResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(body && "error" in body && body.error ? body.error : `Request failed with ${response.status}`);
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

  function handleSettingsConfirm() {
    setModelKey(settingsDraft.modelKey);
    setPanelMode(settingsDraft.panelMode);
    setSystemPrompt(settingsDraft.systemPrompt);
    setLocale(settingsDraft.locale);
    setIsSettingsOpen(false);
  }

  function handleSettingsCancel() {
    setIsSettingsOpen(false);
  }

  async function submitMessage(messageText: string) {
    const trimmed = messageText.trim();
    if ((!trimmed && !selectedImage) || isStreaming) return;

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

    if (activePanelView.kind === "local") {
      if (!activeSession) return;

      const conversationId = activeSession.id;
      const nextMessages = [...activeSession.messages, userMessage];

      updateSession(conversationId, (session) => ({
        ...session,
        title:
          session.messages.length === 0
            ? getSessionTitleFromMessages([userMessage], t("session.untitled"))
            : session.title,
        messages: nextMessages
      }));
    } else {
      setPiPendingMessages([
        {
          id: `pi-user-${userMessage.timestamp}`,
          role: "user",
          content: userMessage.content,
          images: userMessage.images,
          timestamp: userMessage.timestamp
        }
      ]);
    }

    setInput("");
    setSelectedImage(null);
    setDraftAssistant("");
    setDraftThinking("");
    setDraftToolMessages(new Map());
    setError(null);
    setIsStreaming(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(activePanelView.kind === "local"
            ? { "x-session-id": activeSession!.id }
            : { "x-pi-session-id": activePanelView.sessionId })
        },
        body: JSON.stringify({
          ...selectedModel,
          ...(activePanelView.kind === "local" ? { systemPrompt } : {}),
          prompt: userMessage.content,
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

      let finalMessage: (AssistantMessage & { content: string; provider: string; model: string; timestamp: number }) | null = null;
      // Collect intermediate tool messages that appeared during streaming.
      const intermediateToolMessages: Array<{ toolName: string; content: string; isError: boolean }> = [];
      await readEventStream(response, (streamEvent) => {
        if (streamEvent.type === "delta") {
          setDraftAssistant((current) => current + streamEvent.delta);
        }

        if (streamEvent.type === "thinking") {
          setDraftThinking((current) => current + streamEvent.delta);
        }

        if (streamEvent.type === "tool_start") {
          setDraftToolMessages((prev) => {
            const next = new Map(prev);
            next.set(streamEvent.toolCallId, { toolName: streamEvent.toolName, content: "", isError: false });
            return next;
          });
        }

        if (streamEvent.type === "tool_delta") {
          setDraftToolMessages((prev) => {
            const next = new Map(prev);
            const existing = next.get(streamEvent.toolCallId);
            if (existing) {
              next.set(streamEvent.toolCallId, { ...existing, content: existing.content + streamEvent.delta });
            }
            return next;
          });
        }

        if (streamEvent.type === "tool_end") {
          const entry = { toolName: streamEvent.toolName, content: streamEvent.content, isError: streamEvent.isError };
          intermediateToolMessages.push(entry);
          setDraftToolMessages((prev) => {
            const next = new Map(prev);
            next.delete(streamEvent.toolCallId);
            return next;
          });
        }

        if (streamEvent.type === "done") {
          finalMessage = streamEvent.message;
        }

        if (streamEvent.type === "error") {
          finalMessage = streamEvent.message || null;
          setError(streamEvent.error);
        }
      });

      if (finalMessage) {
        // Build the assistant message with intermediate tool results embedded.
        const fm = finalMessage! as AssistantMessage;
        const finalAssistantMsg: AssistantMessage = {
          role: "assistant",
          content: fm.content,
          provider: fm.provider,
          model: fm.model,
          timestamp: fm.timestamp
        };

        if (activePanelView.kind === "local") {
          updateSession(activeSession!.id, (session) => ({
            ...session,
            messages: [
              ...session.messages,
              ...intermediateToolMessages.map(
                (t, i) =>
                  ({
                    role: "tool" as const,
                    toolName: t.toolName,
                    content: t.content,
                    isError: t.isError,
                    expandable: true as const,
                    timestamp: finalAssistantMsg.timestamp + i
                  }) as unknown as ChatMessage
              ),
              finalAssistantMsg
            ]
          }));
        } else {
          const pendingUserMsg: PiHistoryMessage = {
            id: `pi-user-${Date.now()}`,
            role: "user",
            content: userMessage.content,
            images: userMessage.images,
            timestamp: userMessage.timestamp
          };
          const toolMsgs: Extract<PiHistoryMessage, { role: "tool" }>[] = intermediateToolMessages.map(
            (t, i) =>
              ({
                id: `tool-${Date.now()}-${i}`,
                role: "tool",
                toolName: t.toolName,
                content: t.content,
                isError: t.isError,
                expandable: true,
                timestamp: finalAssistantMsg.timestamp + i
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
      } else if (activePanelView.kind === "pi") {
        setPiPendingMessages([]);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "No response stream returned.") {
        setError(t("errors.streamMissing"));
      } else {
        setError(err instanceof Error ? err.message : t("errors.unexpectedChat"));
      }
      if (activePanelView.kind === "pi") {
        setPiPendingMessages([]);
      }
    } finally {
      setDraftAssistant("");
      setDraftThinking("");
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

  return (
    <XProvider theme={xTheme}>
      <main className={`app-shell${sidebarCollapsed ? " app-shell-collapsed" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-top-row">
            <div className="sidebar-brand-icon">
              <svg width="28" height="28" viewBox="0 0 128 128" fill="none">
                <rect x="8" y="8" width="112" height="112" rx="22" fill="var(--canvas)" stroke="var(--sidebar-border)" stroke-width="3"/>
                <g transform="translate(64, 44)">
                  <line x1="-30" y1="0" x2="30" y2="0" stroke="var(--primary)" stroke-width="10" stroke-linecap="round"/>
                  <line x1="-18" y1="0" x2="-18" y2="34" stroke="var(--primary)" stroke-width="10" stroke-linecap="round"/>
                  <line x1="18" y1="0" x2="18" y2="34" stroke="var(--primary)" stroke-width="10" stroke-linecap="round"/>
                </g>
              </svg>
            </div>
            <div className="sidebar-actions">
              <button
                className="icon-button"
                disabled={isStreaming}
                type="button"
                title={t("sidebar.newSession")}
                onClick={createNewSession}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
              <button
                className="icon-button"
                type="button"
                title={t("settings.title")}
                onClick={() => {
                  setSettingsDraft({ modelKey, panelMode, systemPrompt, locale });
                  setIsSettingsOpen(true);
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
            <button
              className="sidebar-collapse-btn"
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              title={t("sidebar.collapse")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
          </div>
          </div>

          <div className="session-manager">
            <div className="session-section-heading">
              <span>{t("sidebar.conversations")}</span>
              <small>{visibleSessions.length}</small>
            </div>

            <div className="session-list">
              {visibleSessions.map((session) => (
                <div
                  className={
                    activePanelView.kind === "local" && session.id === activeSessionId
                      ? "session-row session-row-active"
                      : "session-row"
                  }
                  key={session.id}
                >
                  <button
                    className="session-select"
                    disabled={isStreaming}
                    type="button"
                    onClick={() => selectLocalSession(session.id)}
                  >
                    <span>{session.title}</span>
                    <small>{formatMessageCount(locale, session.messages.length)}</small>
                  </button>

                  <span className="session-menu-trigger" onClick={(e) => e.stopPropagation()}>
                    <Dropdown
                      menu={{
                        items: [
                          { key: "rename", label: t("actions.rename"), onClick: () => openRenameModal(session.id) },
                          { key: "archive", label: t("actions.archive"), onClick: () => archiveLocalSession(session.id) }
                        ]
                      }}
                      placement="bottomRight"
                      trigger={["click"]}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2"/>
                        <circle cx="12" cy="12" r="2"/>
                        <circle cx="12" cy="19" r="2"/>
                      </svg>
                    </Dropdown>
                  </span>
                </div>
              ))}
            </div>

            {archivedSessions.length > 0 ? (
              <div className="archived-sessions">
                <div className="session-section-heading">
                  <span>{t("sidebar.archived")}</span>
                  <small>{archivedSessions.length}</small>
                </div>
                {archivedSessions.map((session) => (
                  <div className="session-row session-row-archived" key={session.id}>
                    <button
                      className="session-select"
                      disabled={isStreaming}
                      type="button"
                      onClick={() => restoreLocalSession(session.id)}
                    >
                      <span>{session.title}</span>
                      <small>{t("session.archivedRestore")}</small>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <PiSessionSection
            isStreaming={isStreaming}
            locale={locale}
            selectedSessionId={activePanelView.kind === "pi" ? activePanelView.sessionId : null}
            onSelectSession={(sessionId) => {
              void selectPiSession(sessionId);
            }}
            onRename={openRenameModal}
            archivedSessionIds={archivedPiSessionIds}
            onArchive={archivePiSession}
            onRestore={restorePiSession}
            refreshKey={piRefreshKey}
          />
        </aside>

        {sidebarCollapsed && (
          <button
            className="sidebar-expand-btn"
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            title={t("sidebar.expand")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
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
            {activePanelView.kind === "pi" && !piSessionDetail ? (
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
                  sessionId={activePanelView.kind === "pi" ? activePanelView.sessionId : activeSessionId}
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
            {isPiHistoryView ? <span className="chat-mode-pill">{t("panel.piSessionPill")}</span> : null}
          </header>

          {isPiHistoryView ? (
            piSessionError ? (
              <div className="messages messages-empty">
                <div className="error-banner">
                  <p>{piSessionError}</p>
                  {activePanelView.kind === "pi" ? (
                    <button
                      className="inline-action-button"
                      type="button"
                      onClick={() => {
                        void selectPiSession(activePanelView.sessionId);
                      }}
                    >
                      {t("panel.retry")}
                    </button>
                  ) : null}
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
            )
          ) : localBubbleItems.length === 0 ? (
            <div className="messages messages-empty">
              <div className="empty-state">
                <h3>{t("sidebar.startTitle")}</h3>
                <p>{t("sidebar.startBody")}</p>
              </div>
              {error && <div className="error-banner">{error}</div>}
            </div>
          ) : (
            <div className="messages">
              <Bubble.List
                autoScroll
                className="chat-bubble-list"
                items={localBubbleItems}
                role={bubbleRoles}
              />
              {error && <div className="error-banner">{error}</div>}
            </div>
          )}

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
              ref={fileInputRef}
              className="composer-upload-input"
              accept={supportedImageMimeTypes.join(",")}
              onChange={handleImageChange}
              type="file"
            />
            <Suggestion<SlashSuggestionInfo>
              block
              className="slash-command-suggestion"
              items={(info) => getSlashSuggestionItems(t, info)}
              onSelect={handleSlashSelect}
            >
              {({ onKeyDown, onTrigger }) => (
                <Sender
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  className="chat-sender"
                  disabled={
                    isStreaming ||
                    (isPiHistoryView && (piSessionLoading || Boolean(piSessionError)))
                  }
                  loading={isStreaming}
                  onChange={(value) => {
                    setInput(value);
                    onTrigger(
                      shouldShowSlashSuggestions(value)
                        ? { query: value.slice(1) }
                        : false
                    );
                  }}
                  onKeyDown={(e) => {
                    // Stop propagation to prevent parent BaseSelect
                    // from intercepting space key (and others)
                    e.stopPropagation();
                    onKeyDown(e);
                  }}
                  onSubmit={submitMessage}
                  placeholder={
                    isPiHistoryView
                      ? t("composer.continuePiSession")
                      : t("composer.placeholder")
                  }
                  submitType="enter"
                  value={input}
                />
              )}
            </Suggestion>
          </div>
        </section>
        )}
      </main>
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
    </XProvider>
  );
}
