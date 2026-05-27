import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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

type MessageContentPart =
  | { type: "text"; value: string }
  | { type: "code"; value: string; language: string };

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

function parseMessageContent(content: string): MessageContentPart[] {
  const parts: MessageContentPart[] = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of content.matchAll(fencePattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      parts.push({ type: "text", value: content.slice(lastIndex, matchIndex) });
    }

    parts.push({
      type: "code",
      language: match[1].trim(),
      value: match[2].replace(/\n$/, "")
    });
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) });
  }

  return parts.length ? parts : [{ type: "text", value: content }];
}

function renderInlineCode(text: string) {
  return text.split(/(`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="inline-code" key={`${part}-${index}`}>
          {part.slice(1, -1)}
        </code>
      );
    }

    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function isCommandLanguage(language: string) {
  return ["bash", "shell", "sh", "zsh", "fish", "powershell", "ps1", "cmd"].includes(
    language.toLowerCase()
  );
}

function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-content">
      {parseMessageContent(text).map((part, index) => {
        if (part.type === "code") {
          const label = isCommandLanguage(part.language) ? "Command" : "Code";

          return (
            <figure className="code-block" key={`${part.type}-${index}`}>
              <figcaption>
                <span>{label}</span>
                {part.language && <small>{part.language}</small>}
              </figcaption>
              <pre>
                <code>{part.value}</code>
              </pre>
            </figure>
          );
        }

        return part.value.split(/\n{2,}/).map((paragraph, paragraphIndex) => {
          if (!paragraph) return null;

          return (
            <p key={`${part.type}-${index}-${paragraphIndex}`}>
              {renderInlineCode(paragraph)}
            </p>
          );
        });
      })}
    </div>
  );
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const text = getMessageText(message);
  const meta =
    message.role === "assistant" ? `${message.provider}/${message.model}` : "You";

  return (
    <article className={`message message-${message.role}`}>
      <div className="message-meta">
        <span>{message.role === "assistant" ? "My Pi" : "You"}</span>
        <small>{meta}</small>
      </div>
      <MessageContent text={text} />
    </article>
  );
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
  const bottomRef = useRef<HTMLDivElement>(null);

  const selectedModel = useMemo(() => {
    const [provider, model] = modelKey.split(":");
    return { provider, model };
  }, [modelKey]);

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
          return currentExists ? current : `${body.models![0].provider}:${body.models![0].model}`;
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, draftAssistant]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
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
              <option key={`${preset.provider}:${preset.model}`} value={`${preset.provider}:${preset.model}`}>
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

        <div className="messages">
          {messages.length === 0 && !draftAssistant && (
            <div className="empty-state">
              <h3>Start with a task or question.</h3>
              <p>
                Try asking for a product plan, code review checklist, deployment runbook, or
                implementation strategy.
              </p>
            </div>
          )}

          {messages.map((message, index) => (
            <MessageBubble key={`${message.role}-${message.timestamp}-${index}`} message={message} />
          ))}

          {draftAssistant && (
            <article className="message message-assistant">
              <div className="message-meta">
                <span>My Pi</span>
                <small>streaming</small>
              </div>
              <MessageContent text={draftAssistant} />
            </article>
          )}

          {error && <div className="error-banner">{error}</div>}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={submitMessage}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask the agent to reason, plan, or draft..."
            rows={3}
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
