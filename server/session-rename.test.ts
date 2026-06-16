import { describe, expect, it } from "vitest";
import { applySessionRename } from "./session-rename.js";

function makePiSessionDetail(name: string) {
  return {
    session: {
      id: "pi-session-1",
      name,
      cwd: "/Users/test/project",
      projectName: "project",
      created: "2026-06-01T00:00:00.000Z",
      modified: "2026-06-13T12:00:00.000Z"
    },
    messages: []
  };
}

describe("applySessionRename", () => {
  it("updates piSessionDetail.session.name when renaming the active Pi session", () => {
    const detail = makePiSessionDetail("Old name");

    const result = applySessionRename(detail, { kind: "pi", sessionId: "pi-session-1" }, "pi-session-1", "New name");

    expect(result?.session.name).toBe("New name");
    expect(result?.session.id).toBe("pi-session-1");
    // Other fields should remain unchanged
    expect(result?.session.projectName).toBe("project");
    expect(result?.session.cwd).toBe("/Users/test/project");
  });

  it("returns unchanged detail when renaming a different session than the active Pi session", () => {
    const detail = makePiSessionDetail("Active session");

    const result = applySessionRename(detail, { kind: "pi", sessionId: "pi-session-123" }, "other-session-id", "New name");

    expect(result?.session.name).toBe("Active session");
  });

  it("returns null when piSessionDetail is null", () => {
    const result = applySessionRename(null, { kind: "pi", sessionId: "pi-session-1" }, "pi-session-1", "New name");

    expect(result).toBeNull();
  });

  it("returns null when viewing a local session", () => {
    const detail = makePiSessionDetail("Should not change");

    const result = applySessionRename(detail, { kind: "local" }, "some-session-id", "New name");

    expect(result).toBeNull();
  });
});
