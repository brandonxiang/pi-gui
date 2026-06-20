import type { AppSlashCommandName } from "../shared/slash-commands.js";

export type LocalResultStatus = "success" | "info" | "error";

export type SessionStatsSnapshot = {
  sessionId: string;
  sessionFile?: string;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: number;
};

export type ServerLocalActionResult = {
  title: string;
  content: string;
  status: LocalResultStatus;
  updatedSessionName?: string;
  refreshProjects?: boolean;
};

export interface ServerLocalActionContext {
  exportToHtml(): Promise<string>;
  exportToJsonl(): string;
  getSessionName(): Promise<string>;
  getSessionStats(): SessionStatsSnapshot;
  setSessionName(name: string): Promise<void>;
}

export function normalizeExportFormat(args: string): "html" | "jsonl" {
  return args.trim().toLowerCase() === "jsonl" ? "jsonl" : "html";
}

export function formatSessionStats(stats: SessionStatsSnapshot): string {
  return `| Metric | Value |
|--------|-------|
| ID | \`${stats.sessionId}\` |
| File | \`${stats.sessionFile || "(in-memory)"}\` |
| Messages | ${stats.totalMessages} (${stats.userMessages} user / ${stats.assistantMessages} assistant) |
| Tool calls | ${stats.toolCalls} / results: ${stats.toolResults} |
| Token in | ${stats.tokens.input} |
| Token out | ${stats.tokens.output} |
| Cache (r/w) | ${stats.tokens.cacheRead} / ${stats.tokens.cacheWrite} |
| Cost | $${stats.cost.toFixed(6)} |`;
}

export async function executeServerLocalAction(
  action: Extract<AppSlashCommandName, "session" | "export" | "name">,
  args: string,
  context: ServerLocalActionContext
): Promise<ServerLocalActionResult> {
  switch (action) {
    case "session":
      return {
        title: "Session",
        content: formatSessionStats(context.getSessionStats()),
        status: "info"
      };

    case "export": {
      const format = normalizeExportFormat(args);
      const filePath =
        format === "html" ? await context.exportToHtml() : context.exportToJsonl();
      return {
        title: "Export",
        content: `Exported the current session as \`${format}\` to \`${filePath}\`.`,
        status: "success"
      };
    }

    case "name": {
      const nextName = args.trim();
      if (!nextName) {
        const currentName = await context.getSessionName();
        return {
          title: "Name",
          content: `Current session name: **${currentName || "(unnamed)"}**`,
          status: "info",
          updatedSessionName: currentName || "(unnamed)"
        };
      }

      await context.setSessionName(nextName);
      return {
        title: "Name",
        content: `Renamed the current session to **${nextName}**.`,
        status: "success",
        updatedSessionName: nextName,
        refreshProjects: true
      };
    }
  }
}
