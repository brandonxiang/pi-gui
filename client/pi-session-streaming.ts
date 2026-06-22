import type { AssistantMessage, StreamEvent } from "./types";

export type PiSessionStreamingPanelMode = "chat" | "terminal";

export type PiSessionStreamingToolMessage = {
  toolName: string;
  content: string;
  isError: boolean;
};

export type PiSessionStreamingDisplayItem =
  | {
      kind: "thinking";
      content: string;
    }
  | {
      kind: "assistant";
      content: string;
    }
  | {
      kind: "error";
      content: string;
    }
  | ({
      kind: "tool";
      streaming: true;
    } & PiSessionStreamingToolMessage);

export type PiSessionStreamingState = {
  panelMode: PiSessionStreamingPanelMode;
  thinkingVisible: boolean;
  visibleThinking: string;
  bufferedThinking: string;
  acceptsThinking: boolean;
  assistant: string;
  activeToolMessages: Map<string, PiSessionStreamingToolMessage>;
  completedToolMessages: PiSessionStreamingToolMessage[];
  finalMessage: AssistantMessage | null;
  error: string | null;
};

export function createPiSessionStreamingState(
  panelMode: PiSessionStreamingPanelMode
): PiSessionStreamingState {
  return {
    panelMode,
    thinkingVisible: panelMode === "chat",
    visibleThinking: "",
    bufferedThinking: "",
    acceptsThinking: panelMode === "chat",
    assistant: "",
    activeToolMessages: new Map(),
    completedToolMessages: [],
    finalMessage: null,
    error: null
  };
}

export function flushPiSessionThinking(
  state: PiSessionStreamingState
): PiSessionStreamingState {
  if (!state.bufferedThinking) return state;

  return {
    ...state,
    visibleThinking: state.visibleThinking + state.bufferedThinking,
    bufferedThinking: ""
  };
}

export function applyPiSessionStreamingEvent(
  state: PiSessionStreamingState,
  event: StreamEvent
): PiSessionStreamingState {
  if (event.type === "thinking") {
    if (!state.acceptsThinking) return state;

    return {
      ...state,
      bufferedThinking: state.bufferedThinking + event.delta
    };
  }

  if (event.type === "delta") {
    const nextState =
      state.panelMode === "chat" && state.acceptsThinking
        ? flushPiSessionThinking({
            ...state,
            acceptsThinking: false
          })
        : state;

    return {
      ...nextState,
      assistant: nextState.assistant + event.delta
    };
  }

  if (event.type === "tool_start") {
    if (state.panelMode === "chat") return state;

    const activeToolMessages = new Map(state.activeToolMessages);
    activeToolMessages.set(event.toolCallId, {
      toolName: event.toolName,
      content: "",
      isError: false
    });

    return {
      ...state,
      activeToolMessages
    };
  }

  if (event.type === "tool_delta") {
    if (state.panelMode === "chat") return state;

    const existing = state.activeToolMessages.get(event.toolCallId);
    if (!existing) return state;

    const activeToolMessages = new Map(state.activeToolMessages);
    activeToolMessages.set(event.toolCallId, {
      ...existing,
      content: existing.content + event.delta
    });

    return {
      ...state,
      activeToolMessages
    };
  }

  if (event.type === "tool_end") {
    const completedToolMessages = [
      ...state.completedToolMessages,
      {
        toolName: event.toolName,
        content: event.content,
        isError: event.isError
      }
    ];

    if (state.panelMode === "chat") {
      return {
        ...state,
        completedToolMessages
      };
    }

    const activeToolMessages = new Map(state.activeToolMessages);
    activeToolMessages.delete(event.toolCallId);

    return {
      ...state,
      activeToolMessages,
      completedToolMessages
    };
  }

  if (event.type === "done") {
    return {
      ...state,
      thinkingVisible: false,
      bufferedThinking: "",
      finalMessage: event.message
    };
  }

  return {
    ...state,
    thinkingVisible: false,
    bufferedThinking: "",
    finalMessage: event.message || null,
    error: event.error
  };
}

export function getPiSessionStreamingDisplayItems(
  state: PiSessionStreamingState
): PiSessionStreamingDisplayItem[] {
  const items: PiSessionStreamingDisplayItem[] = [];

  if (state.thinkingVisible) {
    items.push({
      kind: "thinking",
      content: state.visibleThinking
    });
  }

  if (state.assistant) {
    items.push({
      kind: "assistant",
      content: state.assistant
    });
  }

  if (state.error) {
    items.push({
      kind: "error",
      content: state.error
    });
  }

  for (const toolMessage of state.activeToolMessages.values()) {
    items.push({
      kind: "tool",
      streaming: true,
      ...toolMessage
    });
  }

  return items;
}
