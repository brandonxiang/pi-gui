// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiHistoryMessage } from "./types";

const mockState = vi.hoisted(() => ({
  projects: [] as Array<{
    name: string;
    path: string;
    sessions: Array<{
      id: string;
      name: string;
      firstMessage: string;
      messageCount: number;
      created: string;
      modified: string;
    }>;
  }>,
  sessionDetail: null as
    | {
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
    | null,
  pendingChatPromise: null as Promise<Response> | null
}));

vi.mock("@ant-design/x/es/x-provider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

vi.mock("@ant-design/x/es/bubble", () => {
  function BubbleList({
    items
  }: {
    items: Array<{
      key: string | number;
      role: string;
      header?: React.ReactNode;
      content?: React.ReactNode;
    }>;
  }) {
    return (
      <div className="ant-bubble-list-scroll-box" data-testid="bubble-list">
        <div className="ant-bubble-list-scroll-content">
          {items.map((item) => (
            <div
              className={item.role === "user" ? "chat-bubble-user" : item.role === "divider" ? "chat-bubble-divider" : "chat-bubble"}
              data-role={item.role}
              key={item.key}
            >
              {item.header}
              {item.content}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return {
    default: { List: BubbleList },
    __esModule: true
  };
});

vi.mock("@ant-design/x/es/sender", () => ({
  default: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    disabled,
    onSubmit,
    loading
  }: {
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    disabled?: boolean;
    onSubmit?: (value: string) => void;
    loading?: boolean;
  }) => (
    <div data-loading={loading ? "true" : "false"}>
      <textarea
        aria-label={placeholder || "sender"}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit?.(value);
          }
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSubmit?.(value)}
      >
        Submit
      </button>
    </div>
  )
}));

vi.mock("@ant-design/x/es/suggestion", () => ({
  default: ({
    children
  }: {
    children: (props: {
      onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
      onTrigger: (value: unknown) => void;
    }) => React.ReactNode;
  }) => <>{children({ onKeyDown: () => {}, onTrigger: () => {} })}</>
}));

vi.mock("antd/es/modal", () => ({
  default: ({
    open,
    title,
    children,
    footer
  }: {
    open: boolean;
    title?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={typeof title === "string" ? title : undefined}>
        {title ? <div>{title}</div> : null}
        {children}
        {footer}
      </div>
    ) : null
}));

vi.mock("antd/es/input", () => ({
  default: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    disabled,
    autoFocus
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder={placeholder}
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
      onKeyDown={onKeyDown}
    />
  )
}));

vi.mock("antd/es/select", () => ({
  default: ({
    value,
    onChange,
    options
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}));

vi.mock("antd/es/tabs", () => ({
  default: ({
    items
  }: {
    items: Array<{ key: string; children: React.ReactNode }>;
  }) => <>{items.map((item) => <div key={item.key}>{item.children}</div>)}</>
}));

vi.mock("./PiSessionSection", () => ({
  PiSessionSection: () => <div data-testid="pi-session-section" />
}));

vi.mock("./MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}));

vi.mock("./Minimap", () => ({
  default: () => <div data-testid="minimap" />
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: () => <div className="terminal-panel" data-testid="terminal-panel" tabIndex={0} />
}));

import App from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createJsonResponse(body: unknown, ok = true) {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createStreamResponse(events: Array<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    }
  });

  return new Response(stream, { status: 200 });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  );
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function seedSelectedPiSession() {
  mockState.projects = [
    {
      name: "workspace",
      path: "/tmp/workspace",
      sessions: [
        {
          id: "session-1",
          name: "Session 1",
          firstMessage: "First message",
          messageCount: 1,
          created: "2026-01-01T00:00:00.000Z",
          modified: "2026-01-01T00:00:00.000Z"
        }
      ]
    }
  ];
  mockState.sessionDetail = {
    session: {
      id: "session-1",
      name: "Session 1",
      cwd: "/tmp/workspace",
      projectName: "workspace",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z"
    },
    messages: []
  };
  localStorage.setItem("my-pi-active-session-id", "session-1");
  localStorage.setItem("my-pi-active-pi-project-path", "/tmp/workspace");
}

function dispatchSidebarShortcut(target: EventTarget = document, overrides?: { ctrlKey?: boolean; metaKey?: boolean }) {
  const event = new KeyboardEvent("keydown", {
    key: "b",
    bubbles: true,
    cancelable: true,
    ctrlKey: overrides?.ctrlKey ?? false,
    metaKey: overrides?.metaKey ?? true
  });
  target.dispatchEvent(event);
  return event;
}

describe("App sidebar shortcut", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockState.projects = [];
    mockState.sessionDetail = null;
    mockState.pendingChatPromise = null;
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/api/skills")) {
        return createJsonResponse({ skills: [] });
      }
      if (url.endsWith("/api/models")) {
        return createJsonResponse({ models: [] });
      }
      if (url.endsWith("/api/cwd")) {
        return createJsonResponse({ cwd: "/tmp/workspace" });
      }
      if (url.endsWith("/api/pi-sessions")) {
        return createJsonResponse({ projects: mockState.projects });
      }
      if (url.includes("/api/pi-sessions/")) {
        return createJsonResponse(mockState.sessionDetail);
      }
      if (url.endsWith("/api/chat/steer")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/chat")) {
        if (mockState.pendingChatPromise) {
          return mockState.pendingChatPromise;
        }
        return createJsonResponse({});
      }

      throw new Error(`Unhandled fetch: ${url}`);
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("toggles the left sidebar from a standard app context with Cmd+B", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();

    const shell = container.querySelector(".app-shell");
    expect(shell?.className).not.toContain("app-shell-collapsed");

    await act(async () => {
      dispatchSidebarShortcut();
    });

    expect(shell?.className).toContain("app-shell-collapsed");
  });

  it("toggles the left sidebar while the Session composer is focused", async () => {
    seedSelectedPiSession();

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const shell = container.querySelector(".app-shell");
    const composer = container.querySelector("textarea");
    expect(composer).toBeInstanceOf(HTMLTextAreaElement);

    composer?.focus();
    expect(document.activeElement).toBe(composer);

    await act(async () => {
      dispatchSidebarShortcut(composer!);
    });

    expect(shell?.className).toContain("app-shell-collapsed");
    expect(document.activeElement).toBe(composer);
  });

  it("does not toggle the left sidebar while a modal dialog is open", async () => {
    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();

    const shell = container.querySelector(".app-shell");
    const settingsButton = container.querySelector('button[title="Settings"]');
    expect(settingsButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      dispatchSidebarShortcut();
    });

    expect(shell?.className).not.toContain("app-shell-collapsed");
  });

  it("does not toggle the left sidebar while the Terminal panel is focused", async () => {
    seedSelectedPiSession();
    localStorage.setItem("my-pi-panel-mode", "terminal");

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const shell = container.querySelector(".app-shell");
    const terminalPanel = container.querySelector('[data-testid="terminal-panel"]');
    expect(terminalPanel).toBeInstanceOf(HTMLDivElement);

    (terminalPanel as HTMLDivElement).focus();
    expect(document.activeElement).toBe(terminalPanel);

    await act(async () => {
      dispatchSidebarShortcut(terminalPanel!);
    });

    expect(shell?.className).not.toContain("app-shell-collapsed");
  });

  it("queues a following-up message and clears the composer during streaming", async () => {
    seedSelectedPiSession();
    mockState.pendingChatPromise = new Promise((resolve) => {
      void resolve;
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const composer = container.querySelector("textarea");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Submit"
    );

    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "First prompt");
    });

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect((composer as HTMLTextAreaElement).disabled).toBe(false);

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "Second prompt");
    });

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(container.textContent).toContain("Following up");
    expect(container.textContent).toContain("Second prompt");
  });

  it("sends steering immediately from Cmd+Enter and renders it inside the transcript", async () => {
    seedSelectedPiSession();
    mockState.pendingChatPromise = new Promise((resolve) => {
      void resolve;
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const composer = container.querySelector("textarea");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Submit"
    );

    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "First prompt");
    });

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "Steer now");
    });

    await act(async () => {
      composer?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true
      }));
    });

    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(container.textContent).toContain("Steering");
    expect(container.textContent).toContain("Steer now");
    expect(container.textContent).not.toContain("Active Steering");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/api/chat/steer"))).toBe(true);
  });

  it("removes any queued following-up message from the sender queue", async () => {
    seedSelectedPiSession();
    mockState.pendingChatPromise = new Promise((resolve) => {
      void resolve;
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const composer = container.querySelector("textarea");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Submit"
    );

    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "First prompt");
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "Second prompt");
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "Third prompt");
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Second prompt");
    expect(container.textContent).toContain("Third prompt");

    const removeThirdButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Remove queued follow-up: Third prompt"
    );
    expect(removeThirdButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      removeThirdButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Second prompt");
    expect(container.textContent).not.toContain("Third prompt");
  });

  it("delivers queued following-up messages as normal user bubbles after streaming finishes", async () => {
    seedSelectedPiSession();

    let chatCallCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/api/skills")) {
        return createJsonResponse({ skills: [] });
      }
      if (url.endsWith("/api/models")) {
        return createJsonResponse({ models: [] });
      }
      if (url.endsWith("/api/cwd")) {
        return createJsonResponse({ cwd: "/tmp/workspace" });
      }
      if (url.endsWith("/api/pi-sessions")) {
        return createJsonResponse({ projects: mockState.projects });
      }
      if (url.includes("/api/pi-sessions/")) {
        return createJsonResponse(mockState.sessionDetail);
      }
      if (url.endsWith("/api/chat/steer")) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith("/api/chat")) {
        chatCallCount += 1;

        if (chatCallCount === 1) {
          mockState.sessionDetail = {
            session: mockState.sessionDetail!.session,
            messages: [
              {
                id: "first-user",
                role: "user",
                content: "First prompt",
                timestamp: Date.now()
              },
              {
                id: "first-assistant",
                role: "assistant",
                content: "First answer",
                provider: "openai",
                model: "gpt-4o-mini",
                timestamp: Date.now() + 1
              }
            ]
          };

          return createStreamResponse([
            {
              type: "done",
              message: {
                role: "assistant",
                content: "First answer",
                provider: "openai",
                model: "gpt-4o-mini",
                timestamp: Date.now() + 1
              }
            }
          ]);
        }

        mockState.sessionDetail = {
          session: mockState.sessionDetail!.session,
          messages: [
            {
              id: "first-user",
              role: "user",
              content: "First prompt",
              timestamp: Date.now()
            },
            {
              id: "first-assistant",
              role: "assistant",
              content: "First answer",
              provider: "openai",
              model: "gpt-4o-mini",
              timestamp: Date.now() + 1
            },
            {
              id: "second-user",
              role: "user",
              content: "Second prompt",
              timestamp: Date.now() + 2
            },
            {
              id: "second-assistant",
              role: "assistant",
              content: "Second answer",
              provider: "openai",
              model: "gpt-4o-mini",
              timestamp: Date.now() + 3
            }
          ]
        };

        return createStreamResponse([
          {
            type: "done",
            message: {
              role: "assistant",
              content: "Second answer",
              provider: "openai",
              model: "gpt-4o-mini",
              timestamp: Date.now() + 3
            }
          }
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    await act(async () => {
      root.render(<App />);
    });
    await flushEffects();
    await flushEffects();

    const composer = container.querySelector("textarea");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Submit"
    );

    expect(composer).toBeInstanceOf(HTMLTextAreaElement);
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "First prompt");
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      setTextareaValue(composer as HTMLTextAreaElement, "Second prompt");
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flushEffects();
    await flushEffects();

    expect(chatCallCount).toBe(2);
    expect(container.textContent).toContain("First prompt");
    expect(container.textContent).toContain("Second prompt");
    expect(container.textContent).toContain("Second answer");
    expect(container.textContent).not.toContain("Following up");
  });
});
