import { describe, expect, it } from "vitest";
import {
  appSlashCommands,
  findAppSlashCommand,
  findMatchingAppSlashCommands,
  getSlashAutocompleteValue,
  isServerAppSlashCommand,
  parseSlashCommandInput,
  shouldShowSlashSuggestions
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
      "name",
      "compact"
    ]);
  });

  it("distinguishes server-backed actions from client actions", () => {
    expect(isServerAppSlashCommand(findAppSlashCommand("export")!)).toBe(true);
    expect(isServerAppSlashCommand(findAppSlashCommand("copy")!)).toBe(false);
  });

  it("tracks where each supported slash command comes from", () => {
    expect(findAppSlashCommand("settings")?.source).toBe("app");
    expect(findAppSlashCommand("compact")?.source).toBe("pi");
  });

  it("matches slash suggestions from app commands in registry order", () => {
    expect(findMatchingAppSlashCommands("co").map((command) => command.name)).toEqual([
      "copy",
      "compact"
    ]);
  });
});

describe("slash autocomplete helpers", () => {
  it("shows suggestions only for single-line slash prefixes", () => {
    expect(shouldShowSlashSuggestions("/co")).toBe(true);
    expect(shouldShowSlashSuggestions("/compact now")).toBe(false);
    expect(shouldShowSlashSuggestions("compact")).toBe(false);
  });

  it("prefers app commands when tab-completing", () => {
    expect(getSlashAutocompleteValue("/co", ["compact-helper"])).toBe("/copy");
  });

  it("falls back to skills when no app command matches", () => {
    expect(getSlashAutocompleteValue("/gr", ["grill-me", "diagnose"])).toBe("/grill-me");
  });

  it("returns null when the current input should not trigger suggestions", () => {
    expect(getSlashAutocompleteValue("/compact now", ["compact-helper"])).toBeNull();
  });
});
