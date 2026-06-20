// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const websocketInstances: Array<{
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    url: string;
  }> = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    url: string;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.(new Event("close") as CloseEvent);
    });

    constructor(url: string) {
      this.url = url;
      websocketInstances.push(this);
    }
  }

  class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
  }

  return { MockResizeObserver, MockWebSocket, websocketInstances };
});

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
  }

  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  }

  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.websocketInstances.length = 0;
    vi.stubGlobal("ResizeObserver", mocks.MockResizeObserver);
    vi.stubGlobal("WebSocket", mocks.MockWebSocket);
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

  it("keeps the terminal websocket alive across unrelated rerenders", async () => {
    await act(async () => {
      root.render(React.createElement(TerminalPanel, { cwd: "/tmp/pi", locale: "en" }));
    });

    const [firstConnection] = mocks.websocketInstances;
    expect(mocks.websocketInstances).toHaveLength(1);

    await act(async () => {
      root.render(React.createElement(TerminalPanel, { cwd: "/tmp/pi", locale: "en" }));
    });

    expect(mocks.websocketInstances).toHaveLength(1);
    expect(firstConnection?.close).not.toHaveBeenCalled();
  });

  it("reconnects when the terminal target changes", async () => {
    await act(async () => {
      root.render(React.createElement(TerminalPanel, { cwd: "/tmp/pi-a", locale: "en" }));
    });

    const [firstConnection] = mocks.websocketInstances;

    await act(async () => {
      root.render(React.createElement(TerminalPanel, { cwd: "/tmp/pi-b", locale: "en" }));
    });

    expect(mocks.websocketInstances).toHaveLength(2);
    expect(firstConnection?.close).toHaveBeenCalledTimes(1);
    expect(mocks.websocketInstances[1]?.url).toContain(encodeURIComponent("/tmp/pi-b"));
  });
});
