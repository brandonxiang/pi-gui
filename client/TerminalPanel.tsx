import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

interface TerminalPanelProps {
  cwd: string;
  sessionId?: string;
  initialCommand?: string;
}

function getWebSocketUrl(cwd: string, cmd?: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let url = `${protocol}//${location.host}/api/terminal?cwd=${encodeURIComponent(cwd)}`;
  if (cmd) {
    url += `&cmd=${encodeURIComponent(cmd)}`;
  }
  return url;
}

export function TerminalPanel({ cwd, initialCommand }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // ── Initialize xterm ──
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 14,
      fontFamily: 'Menlo, "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#4ec9b0",
        brightYellow: "#dcdcaa",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#9cdcfe",
        brightWhite: "#ffffff"
      },
      allowProposedApi: true,
      cols: 80,
      rows: 24
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(terminalRef.current);

    // ── Fit after a small delay to let the layout settle ──
    const initialFitTimer = setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {
        // Container may not be visible yet
      }
    }, 50);

    // ── Connect WebSocket ──
    let closed = false;
    function connect() {
      const ws = new WebSocket(getWebSocketUrl(cwd, initialCommand));
      wsRef.current = ws;

      ws.onopen = () => {
        if (fitAddonRef.current) {
          try {
            const dims = fitAddonRef.current.proposeDimensions();
            if (dims) {
              ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
            }
          } catch {
            // ignore
          }
        }
      };

      ws.onmessage = (event) => {
        if (closed) return;
        if (typeof event.data === "string") {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        if (closed) return;
        term.write("\r\n\x1b[31m[Connection closed. Refresh or switch sessions to reconnect.]\x1b[0m\r\n");
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    connect();

    // ── xterm input handler ──
    const disposable = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    // ── Resize observer for container size changes ──
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch {
          // ignore
        }
      }
    });
    resizeObserver.observe(terminalRef.current);

    // ── Cleanup ──
    return () => {
      closed = true;
      clearTimeout(initialFitTimer);
      disposable.dispose();
      resizeObserver.disconnect();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      term.dispose();
      fitAddonRef.current = null;
    };
  }, [cwd, initialCommand]);

  return <div ref={terminalRef} className="terminal-panel" />;
}
