import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "antd";
import Bubble, { type BubbleItemType, type BubbleListProps } from "@ant-design/x/es/bubble";
import Sender from "@ant-design/x/es/sender";
import Suggestion, { type SuggestionItem } from "@ant-design/x/es/suggestion";
import XProvider from "@ant-design/x/es/x-provider";
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

const STORAGE_KEY = "my-pi-chat-session";
const SESSIONS_STORAGE_KEY = "my-pi-chat-sessions";
const ACTIVE_SESSION_KEY = "my-pi-active-session-id";
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

const slashCommands = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Enable or disable model cycling" },
  { name: "export", description: "Export session" },
  { name: "import", description: "Import a JSONL session" },
  { name: "share", description: "Share session as a private gist" },
  { name: "copy", description: "Copy last assistant message" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork from a previous message" },
  { name: "clone", description: "Duplicate current session branch" },
  { name: "tree", description: "Navigate session tree" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload resources" },
  { name: "quit", description: "Quit pi" }
];

const bubbleRoles: BubbleListProps["role"] = {
  assistant: {
    placement: "start",
    variant: "outlined",
    shape: "default",
    className: "chat-bubble chat-bubble-assistant"
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

function getSessionTitleFromMessages(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage?.content.trim()) return "Untitled session";
  return firstUserMessage.content.trim().slice(0, 48);
}

function readStoredSessions(): ChatSession[] {
  try {
    const rawSessions = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (rawSessions) {
      const parsed = JSON.parse(rawSessions) as ChatSession[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.some((session) => !session.archived) ? parsed : [createSession(), ...parsed];
      }
    }

    const legacyMessages = readStoredMessages();
    if (legacyMessages.length > 0) {
      return [createSession(getSessionTitleFromMessages(legacyMessages), legacyMessages)];
    }
  } catch {
    // Fall through to a clean session if local storage is unavailable or corrupted.
  }

  return [createSession()];
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
  message
}: {
  message: Extract<PiHistoryMessage, { role: "tool" }>;
}) {
  return (
    <details className={message.isError ? "pi-tool-card pi-tool-card-error" : "pi-tool-card"}>
      <summary>
        <span>{message.toolName}</span>
        <small>Click to expand</small>
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

function createBubbleItem(message: ChatMessage, index: number): BubbleItemType {
  const isAssistant = message.role === "assistant";

  return {
    key: `${message.role}-${message.timestamp}-${index}`,
    role: isAssistant ? "assistant" : "user",
    content: isAssistant ? getMessageText(message) : <UserMessageContent message={message} />,
    header: (
      <MessageHeader
        label={isAssistant ? "My Pi" : "You"}
        meta={isAssistant ? `${message.provider}/${message.model}` : "You"}
      />
    )
  };
}

function createPiHistoryBubbleItem(message: PiHistoryMessage, index: number): BubbleItemType {
  if (message.role === "user") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "user",
      content: <PiHistoryUserMessageContent message={message} />,
      header: <MessageHeader label="Pi Session" meta="User" />
    };
  }

  if (message.role === "assistant") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "assistant",
      content: message.content,
      header: (
        <MessageHeader
          label="Pi Session"
          meta={message.provider && message.model ? `${message.provider}/${message.model}` : "Assistant"}
        />
      )
    };
  }

  if (message.role === "tool") {
    return {
      key: `${message.role}-${message.timestamp}-${index}`,
      role: "assistant",
      content: <PiToolMessageContent message={message} />,
      header: <MessageHeader label="Tool" meta={message.toolName} />
    };
  }

  return {
    key: `${message.role}-${message.timestamp}-${index}`,
    role: "assistant",
    content: <PiSummaryMessageContent message={message} />,
    header: <MessageHeader label={message.title} meta="Pi session summary" />
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

function getSlashSuggestionItems(info?: SlashSuggestionInfo): SuggestionItem[] {
  const query = info?.query.toLowerCase() || "";
  const matchedCommands = slashCommands.filter((command) =>
    command.name.toLowerCase().includes(query)
  );

  return matchedCommands.map((command) => ({
    label: (
      <div className="slash-command-option">
        <span>/{command.name}</span>
        <small>{command.description}</small>
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
  const initialSessions = useMemo(() => readStoredSessions(), []);
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
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [draftAssistant, setDraftAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activePanelView, setActivePanelView] = useState<ActivePanelView>({ kind: "local" });
  const [piSessionDetail, setPiSessionDetail] = useState<PiSessionDetailResponse | null>(null);
  const [piPendingMessages, setPiPendingMessages] = useState<PiHistoryMessage[]>([]);
  const [piSessionError, setPiSessionError] = useState<string | null>(null);
  const [piSessionLoading, setPiSessionLoading] = useState(false);
  const [draftToolMessages, setDraftToolMessages] = useState<Map<string, { toolName: string; content: string; isError: boolean }>>(new Map());
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
            <small>Running…</small>
          </summary>
          <pre>{entry.content || "(waiting for output…)"}</pre>
        </details>
      ),
      header: <MessageHeader label="Tool" meta={entry.toolName} />
    }));
  }, [draftToolMessages]);

  const streamingBubbleItem = useMemo<BubbleItemType | null>(() => {
    if (!draftAssistant && draftToolMessages.size === 0) return null;
    if (!draftAssistant) return null;

    return {
      key: "assistant-streaming",
      role: "assistant",
      content: draftAssistant,
      streaming: isStreaming,
      status: "updating",
      header: <MessageHeader label="My Pi" meta="streaming" />
    };
  }, [draftAssistant, draftToolMessages, isStreaming]);

  const localBubbleItems = useMemo<BubbleItemType[]>(() => {
    const storedItems = messages.map(createBubbleItem);
    if (!streamingBubbleItem && draftToolBubbleItems.length === 0) return storedItems;

    return [
      ...storedItems,
      ...draftToolBubbleItems,
      ...(streamingBubbleItem ? [streamingBubbleItem] : [])
    ];
  }, [draftToolBubbleItems, messages, streamingBubbleItem]);

  const piHistoryBubbleItems = useMemo<BubbleItemType[]>(() => {
    const items = [...piHistoryMessages, ...piPendingMessages].map(createPiHistoryBubbleItem);
    if (!streamingBubbleItem && draftToolBubbleItems.length === 0) return items;

    return [
      ...items,
      ...draftToolBubbleItems,
      ...(streamingBubbleItem ? [streamingBubbleItem] : [])
    ];
  }, [draftToolBubbleItems, piHistoryMessages, piPendingMessages, streamingBubbleItem]);

  const isPiHistoryView = activePanelView.kind === "pi";
  const panelTitle = isPiHistoryView
    ? piSessionDetail?.session.name || "Pi session"
    : activeSession?.title || "Agent dialogue";
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
      setError("Removed the attached image because the selected model does not support image input.");
    }
  }, [selectedImage, selectedModelSupportsImages]);

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
    const nextSession = createSession();
    setSessions((current) => [nextSession, ...current]);
    setActiveSessionId(nextSession.id);
    setActivePanelView({ kind: "local" });
    setInput("");
    setSelectedImage(null);
    setDraftAssistant("");
    setError(null);
    setPiPendingMessages([]);
  }

  function beginRenameSession(session: ChatSession) {
    setRenameSessionId(session.id);
    setRenameDraft(session.title);
  }

  function saveSessionName(sessionId: string) {
    const nextTitle = renameDraft.trim() || "Untitled session";
    updateSession(sessionId, (session) => ({ ...session, title: nextTitle }));
    setRenameSessionId(null);
    setRenameDraft("");
  }

  function archiveSession(sessionId: string) {
    updateSession(sessionId, (session) => ({ ...session, archived: true }));
    if (activePanelView.kind === "local" && activeSessionId === sessionId) {
      const nextActive = visibleSessions.find((session) => session.id !== sessionId) || createSession();
      if (!sessions.some((session) => session.id === nextActive.id)) {
        setSessions((current) => [nextActive, ...current]);
      }
      setActiveSessionId(nextActive.id);
      setActivePanelView({ kind: "local" });
      setDraftAssistant("");
      setInput("");
      setSelectedImage(null);
      setPiPendingMessages([]);
    }
  }

  function restoreSession(sessionId: string) {
    updateSession(sessionId, (session) => ({ ...session, archived: false }));
    setActiveSessionId(sessionId);
    setActivePanelView({ kind: "local" });
    setPiPendingMessages([]);
  }

  function selectLocalSession(sessionId: string) {
    piSessionRequestIdRef.current += 1;
    setActiveSessionId(sessionId);
    setActivePanelView({ kind: "local" });
    setPiSessionLoading(false);
    setPiSessionError(null);
    setError(null);
    setDraftAssistant("");
    setPiPendingMessages([]);
  }

  async function selectPiSession(sessionId: string) {
    if (isStreaming) return;

    const requestId = piSessionRequestIdRef.current + 1;
    piSessionRequestIdRef.current = requestId;
    setActivePanelView({ kind: "pi", sessionId });
    setPiSessionLoading(true);
    setPiSessionError(null);
    setError(null);
    setDraftAssistant("");
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

  async function submitMessage(messageText: string) {
    const trimmed = messageText.trim();
    if ((!trimmed && !selectedImage) || isStreaming) return;

    if (selectedImage && !selectedModelSupportsImages) {
      setError("The selected model does not support image input. Choose a vision-capable model.");
      return;
    }

    const userMessage: UserMessage = {
      role: "user",
      content: trimmed || "Please analyze this image.",
      images: selectedImage ? [selectedImage] : undefined,
      timestamp: Date.now()
    };

    if (activePanelView.kind === "local") {
      if (!activeSession) return;

      const conversationId = activeSession.id;
      const nextMessages = [...activeSession.messages, userMessage];

      updateSession(conversationId, (session) => ({
        ...session,
        title: session.messages.length === 0 ? getSessionTitleFromMessages([userMessage]) : session.title,
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
      setError(err instanceof Error ? err.message : "Unexpected chat error");
      if (activePanelView.kind === "pi") {
        setPiPendingMessages([]);
      }
    } finally {
      setDraftAssistant("");
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
      setError("The selected model does not support image input. Choose a vision-capable model.");
      return;
    }
    if (!supportedImageMimeTypes.includes(file.type)) {
      setError("Upload a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > maxImageBytes) {
      setError("Image must be smaller than 5 MB.");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read image file");
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
              <button className="icon-button" disabled={isStreaming} type="button" onClick={createNewSession} title="New session">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <button className="icon-button" type="button" onClick={() => setIsSettingsOpen(true)} title="Settings">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
          </div>

          <div className="session-manager">
            <div className="session-section-heading">
              <span>Conversations</span>
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
                  {renameSessionId === session.id ? (
                    <input
                      autoFocus
                      className="session-rename-input"
                      value={renameDraft}
                      onBlur={() => saveSessionName(session.id)}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveSessionName(session.id);
                        if (event.key === "Escape") {
                          setRenameSessionId(null);
                          setRenameDraft("");
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="session-select"
                      disabled={isStreaming}
                      type="button"
                      onClick={() => selectLocalSession(session.id)}
                    >
                      <span>{session.title}</span>
                      <small>{session.messages.length} messages</small>
                    </button>
                  )}

                  <div className="session-row-actions">
                    <button
                      disabled={isStreaming}
                      type="button"
                      onClick={() => beginRenameSession(session)}
                    >
                      Rename
                    </button>
                    <button
                      disabled={isStreaming}
                      type="button"
                      onClick={() => archiveSession(session.id)}
                    >
                      Archive
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {archivedSessions.length > 0 ? (
              <div className="archived-sessions">
                <div className="session-section-heading">
                  <span>Archived</span>
                  <small>{archivedSessions.length}</small>
                </div>
                {archivedSessions.map((session) => (
                  <div className="session-row session-row-archived" key={session.id}>
                    <button
                      className="session-select"
                      disabled={isStreaming}
                      type="button"
                      onClick={() => restoreSession(session.id)}
                    >
                      <span>{session.title}</span>
                      <small>Archived · restore</small>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <PiSessionSection
            isStreaming={isStreaming}
            selectedSessionId={activePanelView.kind === "pi" ? activePanelView.sessionId : null}
            onSelectSession={(sessionId) => {
              void selectPiSession(sessionId);
            }}
          />

          <button
            className="sidebar-collapse-btn"
            type="button"
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </aside>

        {sidebarCollapsed && (
          <button
            className="sidebar-expand-btn"
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        )}

        <section className="chat-panel" aria-label="Agent conversation">
          <header className="chat-header">
            <div className="chat-header-copy">
              <span className="chat-header-title">{panelTitle}</span>
              {panelMeta ? <small className="chat-header-meta">{panelMeta}</small> : null}
            </div>
            {isPiHistoryView ? <span className="chat-mode-pill">Pi Session</span> : null}
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
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
            ) : !piSessionDetail ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>Loading Pi session history…</h3>
                  <p>Fetching the active branch from your local Pi session store.</p>
                </div>
              </div>
            ) : piHistoryBubbleItems.length === 0 ? (
              <div className="messages messages-empty">
                <div className="empty-state">
                  <h3>New Pi session.</h3>
                  <p>Start a new conversation in this project by typing a message below.</p>
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
                <h3>Start with a task or question.</h3>
                <p>
                  Try asking for a product plan, code review checklist, deployment runbook, or
                  implementation strategy.
                </p>
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

          {isPiHistoryView ? (
            !piSessionLoading && !piSessionError ? (
              <div className="composer">
                {selectedImage ? (
                  <div className="attachment-preview">
                    <img alt={selectedImage.name} src={getImageDataUrl(selectedImage)} />
                    <div>
                      <strong>{selectedImage.name}</strong>
                      <span>{Math.ceil(selectedImage.size / 1024)} KB · image analysis</span>
                    </div>
                    <button type="button" onClick={() => setSelectedImage(null)}>
                      Remove
                    </button>
                  </div>
                ) : null}
                <Suggestion<SlashSuggestionInfo>
                  block
                  className="slash-command-suggestion"
                  items={getSlashSuggestionItems}
                  onSelect={handleSlashSelect}
                >
                  {({ onKeyDown, onTrigger }) => (
                    <Sender
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      className="chat-sender"
                      disabled={isStreaming}
                      footer={
                        <div className="composer-footer">
                          <input
                            ref={fileInputRef}
                            accept={supportedImageMimeTypes.join(",")}
                            onChange={handleImageChange}
                            type="file"
                          />
                          <button
                            disabled={isStreaming || !selectedModelSupportsImages}
                            title={
                              selectedModelSupportsImages
                                ? "Upload image"
                                : "Selected model does not support image input"
                            }
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            Upload image
                          </button>
                        </div>
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
                      placeholder="Continue this Pi session..."
                      submitType="enter"
                      value={input}
                    />
                  )}
                </Suggestion>
              </div>
            ) : null
          ) : (
            <div className="composer">
              {selectedImage ? (
                <div className="attachment-preview">
                  <img alt={selectedImage.name} src={getImageDataUrl(selectedImage)} />
                  <div>
                    <strong>{selectedImage.name}</strong>
                    <span>{Math.ceil(selectedImage.size / 1024)} KB · image analysis</span>
                  </div>
                  <button type="button" onClick={() => setSelectedImage(null)}>
                    Remove
                  </button>
                </div>
              ) : null}
              <Suggestion<SlashSuggestionInfo>
                block
                className="slash-command-suggestion"
                items={getSlashSuggestionItems}
                onSelect={handleSlashSelect}
              >
                {({ onKeyDown, onTrigger }) => (
                  <Sender
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    className="chat-sender"
                    disabled={isStreaming}
                    footer={
                      <div className="composer-footer">
                        <input
                          ref={fileInputRef}
                          accept={supportedImageMimeTypes.join(",")}
                          onChange={handleImageChange}
                          type="file"
                        />
                        <button
                          disabled={isStreaming || !selectedModelSupportsImages}
                          title={
                            selectedModelSupportsImages
                              ? "Upload image"
                              : "Selected model does not support image input"
                          }
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Upload image
                        </button>
                      </div>
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
                    placeholder="Ask the agent to reason, plan, or draft..."
                    submitType="enter"
                    value={input}
                  />
                )}
              </Suggestion>
            </div>
          )}
        </section>
      </main>
      <Modal
        centered
        open={isSettingsOpen}
        title="Settings"
        footer={null}
        onCancel={() => setIsSettingsOpen(false)}
      >
        <div className="settings-modal-content">
          <label className="field">
            <span>Model</span>
            <select value={modelKey} onChange={(event) => setModelKey(event.target.value)}>
              {modelOptions.map((preset) => (
                <option key={getModelKey(preset.provider, preset.model)} value={getModelKey(preset.provider, preset.model)}>
                  {preset.label}{preset.supportsImages ? " · vision" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>System prompt</span>
            <textarea
              value={systemPrompt}
              rows={7}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>
        </div>
      </Modal>
    </XProvider>
  );
}
