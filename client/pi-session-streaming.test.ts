import { describe, expect, it } from "vitest";
import {
  applyPiSessionStreamingEvent,
  createPiSessionStreamingState,
  flushPiSessionThinking,
  getPiSessionStreamingDisplayItems
} from "./pi-session-streaming";

function getDisplayKinds(state: ReturnType<typeof createPiSessionStreamingState>) {
  return getPiSessionStreamingDisplayItems(state).map((item) => item.kind);
}

describe("Pi Session streaming transcript state", () => {
  it("shows a thinking bubble immediately in chat panel mode", () => {
    const state = createPiSessionStreamingState("chat");

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "thinking",
        content: ""
      }
    ]);
  });

  it("keeps streaming tools hidden in chat panel mode while thinking updates flush", () => {
    let state = createPiSessionStreamingState("chat");

    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: "Inspecting the workspace"
    });
    state = flushPiSessionThinking(state);
    state = applyPiSessionStreamingEvent(state, {
      type: "tool_start",
      toolCallId: "tool-1",
      toolName: "read_file"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "tool_delta",
      toolCallId: "tool-1",
      toolName: "read_file",
      delta: "partial output"
    });

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "thinking",
        content: "Inspecting the workspace"
      }
    ]);
  });

  it("freezes visible thinking when assistant text starts in chat panel mode", () => {
    let state = createPiSessionStreamingState("chat");

    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: "Plan A"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: " + Plan B"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "delta",
      delta: "Here is the answer"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: " + hidden tail"
    });
    state = flushPiSessionThinking(state);

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "thinking",
        content: "Plan A + Plan B"
      },
      {
        kind: "assistant",
        content: "Here is the answer"
      }
    ]);
  });

  it("removes the temporary thinking bubble after successful completion and keeps final tools", () => {
    let state = createPiSessionStreamingState("chat");

    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: "Plan A"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "delta",
      delta: "Final answer"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "tool_end",
      toolCallId: "tool-1",
      toolName: "read_file",
      content: "file content",
      isError: false
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "done",
      message: {
        role: "assistant",
        content: "Final answer",
        provider: "openai",
        model: "gpt-4o-mini",
        timestamp: 1
      }
    });

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "assistant",
        content: "Final answer"
      }
    ]);
    expect(state.completedToolMessages).toEqual([
      {
        toolName: "read_file",
        content: "file content",
        isError: false
      }
    ]);
  });

  it("clears the thinking bubble on streaming error", () => {
    let state = createPiSessionStreamingState("chat");

    state = applyPiSessionStreamingEvent(state, {
      type: "thinking",
      delta: "Plan A"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "error",
      error: "Agent failed"
    });

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "error",
        content: "Agent failed"
      }
    ]);
    expect(state.error).toBe("Agent failed");
  });

  it("keeps partial assistant output visible when the stream ends in error", () => {
    let state = createPiSessionStreamingState("chat");

    state = applyPiSessionStreamingEvent(state, {
      type: "delta",
      delta: "Partial answer"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "error",
      error: "Provider auth failed"
    });

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "assistant",
        content: "Partial answer"
      },
      {
        kind: "error",
        content: "Provider auth failed"
      }
    ]);
  });

  it("keeps terminal-mode streaming tool visibility intact", () => {
    let state = createPiSessionStreamingState("terminal");

    state = applyPiSessionStreamingEvent(state, {
      type: "tool_start",
      toolCallId: "tool-1",
      toolName: "read_file"
    });
    state = applyPiSessionStreamingEvent(state, {
      type: "tool_delta",
      toolCallId: "tool-1",
      toolName: "read_file",
      delta: "partial output"
    });

    expect(getPiSessionStreamingDisplayItems(state)).toEqual([
      {
        kind: "tool",
        streaming: true,
        toolName: "read_file",
        content: "partial output",
        isError: false
      }
    ]);
  });
});
