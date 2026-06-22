import { describe, expect, it } from "vitest";
import { buildAgentEndStreamEvent } from "./chat-streaming.js";

describe("buildAgentEndStreamEvent", () => {
  it("returns an error event when the assistant finished with stopReason error", () => {
    expect(
      buildAgentEndStreamEvent({
        messages: [
          {
            role: "assistant",
            content: [],
            provider: "openai-codex",
            model: "gpt-5.2",
            stopReason: "error",
            errorMessage: "No API key for provider: openai-codex"
          }
        ],
        finalText: "",
        provider: "openai-codex",
        model: "gpt-5.2",
        timestamp: 123
      })
    ).toEqual({
      type: "error",
      error: "No API key for provider: openai-codex"
    });
  });

  it("preserves partial assistant text when the turn ends in error", () => {
    expect(
      buildAgentEndStreamEvent({
        messages: [
          {
            role: "assistant",
            content: [],
            provider: "openai-codex",
            model: "gpt-5.2",
            stopReason: "error",
            errorMessage: "Provider auth failed"
          }
        ],
        finalText: "Partial answer",
        provider: "openai-codex",
        model: "gpt-5.2",
        timestamp: 123
      })
    ).toEqual({
      type: "error",
      error: "Provider auth failed",
      message: {
        role: "assistant",
        content: "Partial answer",
        provider: "openai-codex",
        model: "gpt-5.2",
        timestamp: 123
      }
    });
  });

  it("returns a done event for successful turns", () => {
    expect(
      buildAgentEndStreamEvent({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop"
          }
        ],
        finalText: "Done",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        timestamp: 123
      })
    ).toEqual({
      type: "done",
      message: {
        role: "assistant",
        content: "Done",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        timestamp: 123
      }
    });
  });
});
