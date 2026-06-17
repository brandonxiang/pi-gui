import Fastify from "fastify";
import FastifyVite from "@fastify/vite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { spawn } from "node-pty";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";
import {
  getModelSupportsImages,
  getPromptOrDefault,
  parseImages,
  type ImageContent
} from "./chat-validation.js";
import {
  findSessionById,
  groupSessionsByProject,
  loadPiSessionContextById,
  loadPiSessionDetailById
} from "./pi-sessions.js";

interface ChatRequest {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  images?: ChatImage[];
}

interface AgentSessionRecord {
  session: AgentSession;
  provider: string;
  model: string;
  systemPrompt: string;
}

interface PiAgentSessionRecord {
  session: AgentSession;
  provider: string;
  modelId: string;
}

interface ChatImage {
  name?: string;
  mimeType?: string;
  data?: string;
  size?: number;
}

const commandCodeProviderBaseUrl =
  process.env.COMMANDCODE_API_BASE || "https://api.commandcode.ai/provider";
const commandCodeModelsUrl =
  process.env.COMMANDCODE_MODELS_URL || "https://api.commandcode.ai/provider/v1/models";
const commandCodeOpenAiBaseUrl = `${commandCodeProviderBaseUrl.replace(/\/$/, "")}/v1`;
const commandCodeAnthropicBaseUrl = commandCodeProviderBaseUrl.replace(/\/$/, "");
const commandCodeDefaultMaxTokens = 65_536;

interface CommandCodeApiModel {
  id: string;
  name: string;
  context_length: number;
}

const port = Number(process.env.PORT || 8787);
const sessions = new Map<string, AgentSessionRecord>();
// Cache Pi agent sessions keyed by Pi session ID so they persist across requests.
const piSessions = new Map<string, PiAgentSessionRecord>();

/* ───── WebSocket terminal state ───── */
const terminalPtyMap = new Map<import("ws").WebSocket, import("node-pty").IPty>();
let terminalWss: WebSocketServer | null = null;

function sendEvent(res: import("node:http").ServerResponse, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function buildResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
}

function configureRuntimeAuth(authStorage: AuthStorage) {
  const commandCodeApiKey = readCommandCodeApiKey();
  if (commandCodeApiKey) authStorage.setRuntimeApiKey("commandcode", commandCodeApiKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readCommandCodeCredential(value: unknown) {
  if (!isRecord(value)) return undefined;

  if (value.type === "api") return readStringField(value, "key");
  if (value.type === "oauth") return readStringField(value, "access");

  return readStringField(value, "key") || readStringField(value, "access");
}

function readCommandCodeApiKey() {
  const authPaths = [
    path.join(homedir(), ".commandcode", "auth.json"),
    path.join(homedir(), ".pi", "agent", "auth.json")
  ];

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue;
      const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
      if (!isRecord(parsed)) continue;

      const apiKey =
        readStringField(parsed, "apiKey") ||
        readStringField(parsed, "commandcode") ||
        readCommandCodeCredential(parsed.commandcode) ||
        readCommandCodeCredential(parsed["command-code"]);

      if (apiKey) return apiKey;
    } catch {
      // Ignore malformed local auth files and let the normal missing-key path explain auth.
    }
  }

  return undefined;
}

function getMissingAuthMessage(provider: string) {
  if (provider === "commandcode") {
    return "Missing local Command Code auth. Sign in with Command Code CLI or add ~/.commandcode/auth.json.";
  }

  return `Missing local ${provider} auth. Sign in with Pi CLI or add credentials to ~/.pi/agent/auth.json.`;
}

function parseCommandCodeModels(value: unknown) {
  if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data)) {
    throw new Error("Unexpected Command Code model list response.");
  }

  return value.data
    .filter((model): model is CommandCodeApiModel => {
      if (!isRecord(model)) return false;
      return (
        typeof model.id === "string" &&
        typeof model.name === "string" &&
        typeof model.context_length === "number"
      );
    })
    .map((model) => {
      const isClaude = model.id.toLowerCase().startsWith("claude");

      return {
        id: model.id,
        name: `${model.name} (Command Code)`,
        api: isClaude ? "anthropic-messages" : "openai-completions",
        baseUrl: isClaude ? commandCodeAnthropicBaseUrl : commandCodeOpenAiBaseUrl,
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_length,
        maxTokens: Math.min(model.context_length, commandCodeDefaultMaxTokens),
        compat: isClaude
          ? undefined
          : {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens" as const
            }
      };
    });
}

async function registerCommandCodeProvider(authStorage: AuthStorage, modelRegistry: ModelRegistry) {
  if (!authStorage.hasAuth("commandcode")) return;

  const response = await fetch(commandCodeModelsUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Command Code models: ${response.status} ${response.statusText}`
    );
  }

  const models = parseCommandCodeModels(await response.json());
  modelRegistry.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: commandCodeOpenAiBaseUrl,
    apiKey: "local-commandcode-auth",
    authHeader: true,
    api: "openai-completions",
    headers: {
      "x-cli-environment": "production"
    },
    models
  });
}

async function createLocalModelRegistry() {
  const authStorage = AuthStorage.create();
  configureRuntimeAuth(authStorage);
  const modelRegistry = ModelRegistry.create(authStorage);
  await registerCommandCodeProvider(authStorage, modelRegistry);

  return {
    authStorage,
    modelRegistry
  };
}

async function getOrCreateSession(
  sessionId: string,
  provider: string,
  modelId: string,
  systemPrompt: string
) {
  const existing = sessions.get(sessionId);
  if (
    existing &&
    existing.provider === provider &&
    existing.model === modelId &&
    existing.systemPrompt === systemPrompt
  ) {
    return existing.session;
  }

  existing?.session.dispose();

  const { authStorage, modelRegistry } = await createLocalModelRegistry();
  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(getMissingAuthMessage(provider));
  }

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: path.join(process.cwd(), ".my-pi-agent"),
    authStorage,
    modelRegistry,
    model,
    resourceLoader: buildResourceLoader(systemPrompt),
    sessionManager: SessionManager.create(process.cwd()),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 1 }
    })
  });

  sessions.set(sessionId, {
    session,
    provider,
    model: modelId,
    systemPrompt
  });

  return session;
}

async function createPersistedPiSession(
  piSessionId: string,
  provider?: string,
  modelId?: string
) {
  // Reuse a cached Pi agent session if available.
  const cached = piSessions.get(piSessionId);
  if (cached) return cached;

  const context = await loadPiSessionContextById(piSessionId);
  if (!context) return null;

  const { authStorage, modelRegistry } = await createLocalModelRegistry();
  const resolvedProvider = provider || context.model?.provider;
  const resolvedModelId = modelId || context.model?.modelId;
  const model =
    resolvedProvider && resolvedModelId
      ? modelRegistry.find(resolvedProvider, resolvedModelId)
      : undefined;

  if (model && !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(getMissingAuthMessage(model.provider));
  }

  const { session } = await createAgentSession({
    cwd: context.session.cwd,
    authStorage,
    modelRegistry,
    model,
    sessionManager: context.sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 1 }
    })
  });

  const record: PiAgentSessionRecord = {
    session,
    provider: model?.provider || resolvedProvider || "unknown",
    modelId: model?.id || resolvedModelId || "unknown"
  };

  piSessions.set(piSessionId, record);
  return record;
}

async function buildServer() {
  const server = Fastify({
    bodyLimit: 8 * 1024 * 1024
  });

  await server.register(FastifyVite, {
    root: path.resolve(import.meta.dirname, ".."),
    dev: process.argv.includes("--dev"),
    spa: true
  });

  // ──────── API routes ────────

  server.get("/api/health", async (_request, _reply) => {
    return { ok: true };
  });

  server.get("/api/cwd", async (_request, _reply) => {
    return { cwd: process.cwd() };
  });

  server.post("/api/pi-sessions", async (request, reply) => {
    const { cwd } = request.body as { cwd?: string };
    if (!cwd?.trim()) {
      reply.code(400);
      return { error: "cwd is required" };
    }

    try {
      const sm = SessionManager.create(cwd.trim());
      // Force-write the session header to disk so listAll() finds it.
      // SessionManager.create() defers writes until an assistant message appears.
      (sm as unknown as { _rewriteFile(): void })._rewriteFile();
      const sessions = await SessionManager.listAll();
      const projects = groupSessionsByProject(sessions);
      return { projects };
    } catch (error) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Failed to create Pi session"
      };
    }
  });

  server.get("/api/pi-sessions", async (_request, reply) => {
    try {
      const sessions = await SessionManager.listAll();
      const projects = groupSessionsByProject(sessions);
      return { projects };
    } catch (error) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Failed to list Pi sessions"
      };
    }
  });

  server.get("/api/pi-sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId?: string };
    if (!sessionId?.trim()) {
      reply.code(400);
      return { error: "sessionId is required" };
    }

    try {
      const detail = await loadPiSessionDetailById(sessionId);
      if (!detail) {
        reply.code(404);
        return { error: "Pi session not found" };
      }

      return detail;
    } catch (error) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Failed to load Pi session"
      };
    }
  });

  server.put("/api/sessions/:sessionId/name", async (request, reply) => {
    const { sessionId } = request.params as { sessionId?: string };
    const { name } = request.body as { name?: string };

    if (!sessionId?.trim()) {
      reply.code(400);
      return { error: "sessionId is required" };
    }
    if (!name?.trim()) {
      reply.code(400);
      return { error: "name is required" };
    }

    // Check local sessions (cached in sessions Map).
    const localSession = sessions.get(sessionId);
    if (localSession) {
      localSession.session.sessionManager.appendSessionInfo(name.trim());
      return { ok: true };
    }

    // Check persistent Pi sessions.
    try {
      const allSessions = await SessionManager.listAll();
      const match = findSessionById(allSessions, sessionId);
      if (!match) {
        reply.code(404);
        return { error: "Session not found" };
      }
      const sm = SessionManager.open(match.path);
      sm.appendSessionInfo(name.trim());
      return { ok: true };
    } catch (error) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Failed to rename session"
      };
    }
  });

  server.get("/api/models", async (_request, reply) => {
    try {
      const { modelRegistry } = await createLocalModelRegistry();
      const models = modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        model: model.id,
        label: `${model.name || model.id} (${model.provider})`,
        supportsImages: getModelSupportsImages(model)
      }));

      return { models };
    } catch (error) {
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : "Failed to load models"
      };
    }
  });

  server.post("/api/chat", async (request, reply) => {
    const body = request.body as ChatRequest;
    const requestedProvider = body.provider;
    const requestedModelId = body.model;
    let images: ImageContent[];
    try {
      images = parseImages(body.images);
    } catch (error) {
      reply.code(400);
      return {
        error: error instanceof Error ? error.message : "Invalid image attachment"
      };
    }
    const prompt = getPromptOrDefault(body.prompt, images);
    const sessionId =
      (request.headers["x-session-id"] as string | undefined) || "default";
    const piSessionId = request.headers["x-pi-session-id"] as string | undefined;
    const systemPrompt =
      body.systemPrompt?.trim() ||
      "You are My Pi, a concise online agent assistant. Ask clarifying questions when requirements are incomplete.";

    if (!prompt) {
      reply.code(400);
      return { error: "prompt is required" };
    }

    if (images.length > 0) {
      try {
        if (piSessionId) {
          const persistedSession = await createPersistedPiSession(
            piSessionId,
            requestedProvider,
            requestedModelId
          );
          persistedSession?.session.dispose();

          if (!persistedSession) {
            reply.code(404);
            return { error: "Pi session not found" };
          }

          if (
            persistedSession.provider !== "unknown" &&
            persistedSession.modelId !== "unknown"
          ) {
            const { modelRegistry } = await createLocalModelRegistry();
            const model = modelRegistry.find(
              persistedSession.provider,
              persistedSession.modelId
            );
            if (!model || !getModelSupportsImages(model)) {
              reply.code(400);
              return {
                error: `Model ${persistedSession.provider}/${persistedSession.modelId} does not support image input`
              };
            }
          }
        } else {
          const provider = requestedProvider || "openai";
          const modelId = requestedModelId || "gpt-4o-mini";
          const { modelRegistry } = await createLocalModelRegistry();
          const model = modelRegistry.find(provider, modelId);
          if (!model || !getModelSupportsImages(model)) {
            reply.code(400);
            return {
              error: `Model ${provider}/${modelId} does not support image input`
            };
          }
        }
      } catch (error) {
        reply.code(500);
        return {
          error:
            error instanceof Error ? error.message : "Failed to validate image model support"
        };
      }
    }

    // ── SSE streaming via raw response ──
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    try {
      const persistedSession = piSessionId
        ? await createPersistedPiSession(piSessionId, requestedProvider, requestedModelId)
        : null;

      if (piSessionId && !persistedSession) {
        sendEvent(raw, {
          type: "error",
          error: "Pi session not found"
        });
        return;
      }

      const provider = persistedSession?.provider || requestedProvider || "openai";
      const modelId = persistedSession?.modelId || requestedModelId || "gpt-4o-mini";
      const session =
        persistedSession?.session ||
        (await getOrCreateSession(
          sessionId,
          provider,
          modelId,
          systemPrompt
        ));
      let finalText = "";

      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          finalText += event.assistantMessageEvent.delta;
          sendEvent(raw, { type: "delta", delta: event.assistantMessageEvent.delta });
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_delta"
        ) {
          sendEvent(raw, { type: "thinking", delta: event.assistantMessageEvent.delta });
        }

        if (event.type === "tool_execution_start") {
          sendEvent(raw, {
            type: "tool_start",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {})
          });
        }

        if (event.type === "tool_execution_update") {
          sendEvent(raw, {
            type: "tool_delta",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            delta: typeof event.partialResult === "string" ? event.partialResult : JSON.stringify(event.partialResult ?? "")
          });
        }

        if (event.type === "tool_execution_end") {
          sendEvent(raw, {
            type: "tool_end",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            content: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
            isError: event.isError
          });
        }

        if (event.type === "agent_end") {
          sendEvent(raw, {
            type: "done",
            message: {
              role: "assistant",
              content: finalText,
              provider,
              model: modelId,
              timestamp: Date.now()
            }
          });
        }
      });

      try {
        await session.prompt(prompt, images.length > 0 ? { images } : undefined);
      } finally {
        unsubscribe();
        // Pi sessions are cached in piSessions map, so do NOT dispose() here.
        // Only dispose in-memory (local) sessions that were created per-request.
        if (!piSessionId) {
          persistedSession?.session.dispose();
        }
      }
    } catch (error) {
      sendEvent(raw, {
        type: "error",
        error: error instanceof Error ? error.message : "Unexpected server error"
      });
    } finally {
      raw.end();
    }
  });

  // SPA catch-all: serve index.html for any non-API route
  server.setNotFoundHandler((_request, reply) => {
    return reply.html();
  });

  await server.vite.ready();
  return server;
}

/**
 * Auto-launch a Pi CLI command in the terminal.
 * Accepts a `cmd` query param — executes it ~600ms after shell starts.
 */
function setupTerminalWebSocket(httpServer: import("node:http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/api/terminal") return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const cwd = url.searchParams.get("cwd") || process.cwd();
    const cmd = url.searchParams.get("cmd") || "";
    const shell = process.env.SHELL || "/bin/zsh";

    let pty: import("node-pty").IPty | null = null;

    try {
      pty = spawn(shell, [], {
        cwd,
        name: "xterm-256color",
        env: { ...process.env } as Record<string, string>
      });
    } catch (err) {
      ws.close(1011, `Failed to spawn PTY: ${err instanceof Error ? err.message : err}`);
      return;
    }

    terminalPtyMap.set(ws, pty);

    pty.onData((data) => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
    });

    // Auto-execute initial command after shell prompt appears
    if (cmd) {
      let cmdSent = false;
      const cmdTimer = setTimeout(() => {
        if (pty && !cmdSent) {
          cmdSent = true;
          pty.write(cmd + "\n");
        }
      }, 600);
      // Clear on WS close
      ws.on("close", () => clearTimeout(cmdTimer));
      ws.on("error", () => clearTimeout(cmdTimer));
    }

    ws.on("message", (raw) => {
      if (!pty) return;

      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          pty.resize(parsed.cols, parsed.rows);
        } else if (parsed.type === "input" && typeof parsed.data === "string") {
          pty.write(parsed.data);
        }
      } catch {
        // If parsing fails, treat as raw input (plain text from non-JSON clients)
        pty.write(raw.toString());
      }
    });

    ws.on("close", () => {
      terminalPtyMap.delete(ws);
      if (pty) {
        try {
          pty.kill();
        } catch {
          // PTY already dead
        }
      }
      pty = null;
    });

    ws.on("error", () => {
      terminalPtyMap.delete(ws);
      if (pty) {
        try {
          pty.kill();
        } catch {}
      }
      pty = null;
    });
  });

  return wss;
}

async function startWithRetry(
  fastify: Awaited<ReturnType<typeof buildServer>>,
  retries: number,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const address = await new Promise<string>((resolve, reject) => {
        fastify.listen({ port, host: "127.0.0.1" }, (err, addr) => {
          if (err) reject(err);
          else resolve(addr);
        });
      });

      // Attach WebSocket terminal server to the underlying HTTP server
      terminalWss = setupTerminalWebSocket(fastify.server);
      console.log(`My Pi server listening on ${address}`);
      return;
    } catch (error) {
      const isPortInUse =
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "EADDRINUSE";

      if (isPortInUse && attempt < retries) {
        console.log(`Port ${port} is in use, retrying in 1s (attempt ${attempt}/${retries - 1})…`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        console.error("Failed to start server:", error);
        process.exit(1);
      }
    }
  }
}

const server = await buildServer();

// Graceful shutdown on SIGTERM (from node --watch or dev.mjs)
// so the port is released promptly for the next process.
process.on("SIGTERM", async () => {
  // Kill all terminal PTY processes
  for (const pty of terminalPtyMap.values()) {
    try {
      pty.kill();
    } catch {}
  }
  terminalPtyMap.clear();
  terminalWss?.close();

  try {
    await server.close();
  } catch {}
  process.exit(0);
});

await startWithRetry(server, 5);
