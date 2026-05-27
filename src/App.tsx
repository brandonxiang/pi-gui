import { useEffect, useMemo, useRef, useState } from "react";
import Bubble, { type BubbleItemType, type BubbleListProps } from "@ant-design/x/es/bubble";
import Sender from "@ant-design/x/es/sender";
import XProvider from "@ant-design/x/es/x-provider";
import type { AssistantMessage, ChatMessage, StreamEvent, UserMessage } from "./types";

const STORAGE_KEY = "my-pi-chat-session";

const modelPresets = [
  { provider: "openai", model: "gpt-4o-mini", label: "OpenAI GPT-4o mini" },
  { provider: "openai", model: "gpt-4.1-mini", label: "OpenAI GPT-4.1 mini" },
  { provider: "anthropic", model: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small" }
];

type ModelOption = (typeof modelPresets)[number];

const defaultSystemPrompt =
  "You are My Pi, an online agent conversation assistant. Be concise, practical, and explicit about assumptions.";

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
    colorPrimary: "#5645d4",
    borderRadius: 8,
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  }
};

function createSessionId() {
  const stored = localStorage.getItem("my-pi-session-id");
  if (stored) return stored;
  const next = crypto.randomUUID();
  localStorage.setItem("my-pi-session-id", next);
  return next;
}

function getMessageText(message: ChatMessage) {
  return message.content;
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

function createBubbleItem(message: ChatMessage, index: number): BubbleItemType {
  const isAssistant = message.role === "assistant";

  return {
    key: `${message.role}-${message.timestamp}-${index}`,
    role: isAssistant ? "assistant" : "user",
    content: getMessageText(message),
    header: (
      <MessageHeader
        label={isAssistant ? "My Pi" : "You"}
        meta={isAssistant ? `${message.provider}/${message.model}` : "You"}
      />
    )
  };
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
  const [messages, setMessages] = useState<ChatMessage[]>(readStoredMessages);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  const [modelKey, setModelKey] = useState("openai:gpt-4o-mini");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(modelPresets);
  const [draftAssistant, setDraftAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef<string>("");

  const selectedModel = useMemo(() => {
    return parseModelKey(modelKey);
  }, [modelKey]);

  const bubbleItems = useMemo<BubbleItemType[]>(() => {
    const storedItems = messages.map(createBubbleItem);
    if (!draftAssistant) return storedItems;

    return [
      ...storedItems,
      {
        key: "assistant-streaming",
        role: "assistant",
        content: draftAssistant,
        streaming: isStreaming,
        status: "updating",
        header: <MessageHeader label="My Pi" meta="streaming" />
      }
    ];
  }, [draftAssistant, isStreaming, messages]);

  useEffect(() => {
    sessionIdRef.current = createSessionId();
  }, []);

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
          return currentExists ? current : getModelKey(body.models![0].provider, body.models![0].model);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  async function submitMessage(messageText: string) {
    const trimmed = messageText.trim();
    if (!trimmed || isStreaming) return;

    const userMessage: UserMessage = {
      role: "user",
      content: trimmed,
      timestamp: Date.now()
    };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setInput("");
    setDraftAssistant("");
    setError(null);
    setIsStreaming(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionIdRef.current
        },
        body: JSON.stringify({
          ...selectedModel,
          systemPrompt,
          prompt: trimmed
        })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Request failed with ${response.status}`);
      }

      let finalMessage: AssistantMessage | null = null;
      await readEventStream(response, (streamEvent) => {
        if (streamEvent.type === "delta") {
          setDraftAssistant((current) => current + streamEvent.delta);
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
        setMessages((current) => [...current, finalMessage as AssistantMessage]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected chat error");
    } finally {
      setDraftAssistant("");
      setIsStreaming(false);
    }
  }

  function clearConversation() {
    setMessages([]);
    setDraftAssistant("");
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <XProvider theme={xTheme}>
      <main className="app-shell">
        <aside className="sidebar">
          <div>
            <p className="eyebrow">Online agent console</p>
            <h1>My Pi Agent</h1>
            <p className="sidebar-copy">
              A browser-based conversation layer powered by the pi AI provider runtime.
            </p>
          </div>

          <label className="field">
            <span>Model</span>
            <select value={modelKey} onChange={(event) => setModelKey(event.target.value)}>
              {modelOptions.map((preset) => (
                <option key={getModelKey(preset.provider, preset.model)} value={getModelKey(preset.provider, preset.model)}>
                  {preset.label}
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

          <button className="secondary-button" type="button" onClick={clearConversation}>
            Clear conversation
          </button>

          <div className="status-panel">
            <span className="status-dot" />
            <p>Backend streams through `@earendil-works/pi-coding-agent`; API keys stay server-side.</p>
          </div>
        </aside>

        <section className="chat-panel" aria-label="Agent conversation">
          <header className="chat-header">
            <div>
              <p className="eyebrow">Session</p>
              <h2>Agent dialogue</h2>
            </div>
            <span className={isStreaming ? "pill pill-live" : "pill"}>{isStreaming ? "Streaming" : "Ready"}</span>
          </header>

          {bubbleItems.length === 0 ? (
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
                items={bubbleItems}
                role={bubbleRoles}
              />
              {error && <div className="error-banner">{error}</div>}
            </div>
          )}

          <div className="composer">
            <Sender
              autoSize={{ minRows: 2, maxRows: 8 }}
              className="chat-sender"
              disabled={isStreaming}
              loading={isStreaming}
              onChange={setInput}
              onSubmit={submitMessage}
              placeholder="Ask the agent to reason, plan, or draft..."
              submitType="enter"
              value={input}
            />
          </div>
        </section>
      </main>
    </XProvider>
  );
}
