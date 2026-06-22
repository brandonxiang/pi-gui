type AssistantStreamMessage = {
  role: "assistant";
  content: string;
  provider: string;
  model: string;
  timestamp: number;
};

export type ChatStreamTerminalEvent =
  | {
      type: "done";
      message: AssistantStreamMessage;
    }
  | {
      type: "error";
      error: string;
      message?: AssistantStreamMessage;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function findAssistantError(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;

    const stopReason = readStringField(message, "stopReason");
    const errorMessage = readStringField(message, "errorMessage");

    if (stopReason === "error" && errorMessage) {
      return errorMessage;
    }
  }

  return null;
}

export function buildAgentEndStreamEvent(args: {
  messages: unknown[];
  finalText: string;
  provider: string;
  model: string;
  timestamp?: number;
}): ChatStreamTerminalEvent {
  const timestamp = args.timestamp ?? Date.now();
  const message = {
    role: "assistant" as const,
    content: args.finalText,
    provider: args.provider,
    model: args.model,
    timestamp
  };
  const errorMessage = findAssistantError(args.messages);

  if (errorMessage) {
    return args.finalText
      ? { type: "error", error: errorMessage, message }
      : { type: "error", error: errorMessage };
  }

  return {
    type: "done",
    message
  };
}
