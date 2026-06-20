import { describe, expect, it } from "vitest";
import {
  appSlashCommands,
  findAppSlashCommand,
  isServerAppSlashCommand,
  parseSlashCommandInput
} from "../shared/slash-commands.js";

describe("parseSlashCommandInput", () => {
  it("parses a single-line slash command and its args", () => {
    expect(parseSlashCommandInput("/name sprint-plan")).toEqual({
      name: "name",
      normalizedName: "name",
      args: "sprint-plan"
    });
  });

  it("ignores non-slash text and multiline input", () => {
    expect(parseSlashCommandInput("hello")).toBeNull();
    expect(parseSlashCommandInput("/settings\nmore")).toBeNull();
  });

  it("keeps unknown slash commands parseable for agent passthrough", () => {
    expect(parseSlashCommandInput("/review branch-a")).toEqual({
      name: "review",
      normalizedName: "review",
      args: "branch-a"
    });
  });
});

describe("app slash command registry", () => {
  it("contains only the supported local app actions", () => {
    expect(appSlashCommands.map((command) => command.name)).toEqual([
      "settings",
      "model",
      "copy",
      "session",
      "export",
      "name"
    ]);
  });

  it("distinguishes server-backed actions from client actions", () => {
    expect(isServerAppSlashCommand(findAppSlashCommand("export")!)).toBe(true);
    expect(isServerAppSlashCommand(findAppSlashCommand("copy")!)).toBe(false);
  });
});
