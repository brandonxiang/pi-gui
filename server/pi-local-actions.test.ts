import { describe, expect, it, vi } from "vitest";
import {
  executeServerLocalAction,
  formatCompactionResult,
  formatSessionStats,
  normalizeExportFormat,
  type SessionCompactionResult,
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

const compactionResult: SessionCompactionResult = {
  summary: "Kept the recent implementation work and summarized the older planning discussion.",
  tokensBefore: 54321,
  details: {
    readFiles: ["src/App.tsx"],
    modifiedFiles: ["server/index.ts"]
  }
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

describe("formatCompactionResult", () => {
  it("renders compaction summary metadata as markdown", () => {
    const formatted = formatCompactionResult(compactionResult);

    expect(formatted).toContain("Compacted the current session context.");
    expect(formatted).toContain("54,321");
    expect(formatted).toContain("src/App.tsx");
    expect(formatted).toContain("server/index.ts");
  });
});

describe("executeServerLocalAction", () => {
  it("returns a structured export result", async () => {
    const result = await executeServerLocalAction("export", "jsonl", {
      compactSession: vi.fn(),
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
      compactSession: vi.fn(),
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

  it("runs SDK compaction and requests a session detail refresh", async () => {
    const result = await executeServerLocalAction("compact", "Keep the latest debugging context", {
      compactSession: vi.fn(async () => compactionResult),
      exportToHtml: vi.fn(),
      exportToJsonl: vi.fn(),
      getSessionName: vi.fn(),
      getSessionStats: vi.fn(() => stats),
      setSessionName: vi.fn()
    });

    expect(result.title).toBe("Compact");
    expect(result.status).toBe("success");
    expect(result.refreshSessionDetail).toBe(true);
    expect(result.content).toContain(compactionResult.summary);
  });
});
