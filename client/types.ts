export type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string;
};

export type UserMessage = {
  role: "user";
  content: string;
  images?: ImageAttachment[];
  timestamp: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  provider: string;
  model: string;
  timestamp: number;
};

export type ChatMessage = UserMessage | AssistantMessage;

export type StreamEvent =
  | { type: "delta"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; args?: string }
  | { type: "tool_delta"; toolName: string; toolCallId: string; delta: string }
  | { type: "tool_end"; toolName: string; toolCallId: string; content: string; isError: boolean }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; message?: AssistantMessage; error: string };

/* ───── Pi session types ───── */

export interface PiSessionSummary {
  id: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  created: string;
  modified: string;
}

export interface PiSessionProject {
  name: string;
  path: string;
  sessions: PiSessionSummary[];
}

export interface PiSessionsResponse {
  projects: PiSessionProject[];
}

export interface PiHistoryImage {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

export type PiHistoryMessage =
  | {
      id: string;
      role: "user";
      content: string;
      images?: PiHistoryImage[];
      timestamp: number;
    }
  | {
      id: string;
      role: "steering";
      content: string;
      timestamp: number;
    }
  | {
      id: string;
      role: "assistant";
      content: string;
      provider?: string;
      model?: string;
      timestamp: number;
    }
  | {
      id: string;
      role: "tool";
      toolName: string;
      content: string;
      isError: boolean;
      expandable: true;
      timestamp: number;
    }
  | {
      id: string;
      role: "local_result";
      title: string;
      content: string;
      status: "success" | "info" | "error";
      timestamp: number;
    }
  | {
      id: string;
      role: "summary";
      summaryType: "compaction" | "branch" | "custom";
      title: string;
      content: string;
      timestamp: number;
    };

export interface PiSessionDetail {
  id: string;
  name: string;
  cwd: string;
  projectName: string;
  created: string;
  modified: string;
}

export interface PiSessionDetailResponse {
  session: PiSessionDetail;
  messages: PiHistoryMessage[];
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
