import { describe, expect, it, vi } from "vitest";
import {
  executeServerLocalAction,
  formatSessionStats,
  normalizeExportFormat,
  type SessionStatsSnapshot
} from "./pi-local-actions.js";

const stats: SessionStatsSnapshot = {
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
  totalMessages: 4,
  userMessages: 2,
  assistantMessages: 2,
  toolCalls: 1,
  toolResults: 1,
  tokens: {
    input: 120,
    output: 240,
    cacheRead: 8,
    cacheWrite: 4
  },
  cost: 0.123456
};

describe("normalizeExportFormat", () => {
  it("defaults to html unless jsonl is explicitly requested", () => {
    expect(normalizeExportFormat("")).toBe("html");
    expect(normalizeExportFormat("jsonl")).toBe("jsonl");
    expect(normalizeExportFormat("JSONL")).toBe("jsonl");
  });
});

describe("formatSessionStats", () => {
  it("renders the session stats markdown table", () => {
    const formatted = formatSessionStats(stats);

    expect(formatted).toContain("| Metric | Value |");
    expect(formatted).toContain("session-1");
    expect(formatted).toContain("$0.123456");
  });
});

describe("executeServerLocalAction", () => {
  it("returns a structured export result", async () => {
    const result = await executeServerLocalAction("export", "jsonl", {
      exportToHtml: vi.fn(),
      exportToJsonl: vi.fn(() => "/tmp/export.jsonl"),
      getSessionName: vi.fn(),
      getSessionStats: vi.fn(() => stats),
      setSessionName: vi.fn()
    });

    expect(result).toEqual({
      title: "Export",
      content: "Exported the current session as `jsonl` to `/tmp/export.jsonl`.",
      status: "success"
    });
  });

  it("renames the session when /name receives args", async () => {
    const setSessionName = vi.fn();

    const result = await executeServerLocalAction("name", "Roadmap", {
      exportToHtml: vi.fn(),
      exportToJsonl: vi.fn(),
      getSessionName: vi.fn(async () => "Old"),
      getSessionStats: vi.fn(() => stats),
      setSessionName
    });

    expect(setSessionName).toHaveBeenCalledWith("Roadmap");
    expect(result.updatedSessionName).toBe("Roadmap");
    expect(result.refreshProjects).toBe(true);
  });
});
