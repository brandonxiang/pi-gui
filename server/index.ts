import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

interface ChatRequest {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
}

interface AgentSessionRecord {
  session: AgentSession;
  provider: string;
  model: string;
  systemPrompt: string;
}

const providerApiKeyEnv: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  commandcode: "COMMANDCODE_API_KEY"
};

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

const app = express();
const port = Number(process.env.PORT || 8787);
const sessions = new Map<string, AgentSessionRecord>();

app.use(express.json({ limit: "1mb" }));

function sendEvent(res: express.Response, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

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
  for (const [provider, envName] of Object.entries(providerApiKeyEnv)) {
    const value = process.env[envName];
    if (value) authStorage.setRuntimeApiKey(provider, value);
  }

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
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY;

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
    apiKey: "COMMANDCODE_API_KEY",
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

app.get("/api/models", async (_req, res) => {
  try {
    const { modelRegistry } = await createLocalModelRegistry();
    const models = modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      model: model.id,
      label: `${model.name || model.id} (${model.provider})`
    }));

    res.json({ models });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load models"
    });
  }
});

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
    const envName = providerApiKeyEnv[provider] || `${provider.toUpperCase()}_API_KEY`;
    throw new Error(`Missing ${envName}`);
  }

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: path.join(process.cwd(), ".my-pi-agent"),
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    noTools: "all",
    resourceLoader: buildResourceLoader(systemPrompt),
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
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

app.post("/api/chat", async (req, res) => {
  const body = req.body as ChatRequest;
  const provider = body.provider || "openai";
  const modelId = body.model || "gpt-4o-mini";
  const prompt = body.prompt?.trim();
  const sessionId = req.headers["x-session-id"]?.toString() || "default";
  const systemPrompt =
    body.systemPrompt?.trim() ||
    "You are My Pi, a concise online agent assistant. Ask clarifying questions when requirements are incomplete.";

  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    const session = await getOrCreateSession(sessionId, provider, modelId, systemPrompt);
    let finalText = "";

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        finalText += event.assistantMessageEvent.delta;
        sendEvent(res, { type: "delta", delta: event.assistantMessageEvent.delta });
      }

      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        sendEvent(res, { type: "thinking", delta: event.assistantMessageEvent.delta });
      }

      if (event.type === "agent_end") {
        sendEvent(res, {
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
      await session.prompt(prompt);
    } finally {
      unsubscribe();
    }
  } catch (error) {
    sendEvent(res, {
      type: "error",
      error: error instanceof Error ? error.message : "Unexpected server error"
    });
  } finally {
    res.end();
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../dist");

if (process.env.NODE_ENV === "production" && existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`My Pi server listening on http://127.0.0.1:${port}`);
});
