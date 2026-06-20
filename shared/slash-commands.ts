export type AppSlashCommandScope = "client" | "server";
export type AppSlashCommandSource = "app" | "pi";

export const appSlashCommands = [
  { name: "settings", descriptionKey: "slash.settings", scope: "client", source: "app" },
  { name: "model", descriptionKey: "slash.model", scope: "client", source: "app" },
  { name: "copy", descriptionKey: "slash.copy", scope: "client", source: "app" },
  { name: "session", descriptionKey: "slash.session", scope: "server", source: "pi" },
  { name: "export", descriptionKey: "slash.export", scope: "server", source: "pi" },
  { name: "name", descriptionKey: "slash.name", scope: "server", source: "pi" },
  { name: "compact", descriptionKey: "slash.compact", scope: "server", source: "pi" }
] as const;

export type AppSlashCommand = (typeof appSlashCommands)[number];
export type AppSlashCommandName = AppSlashCommand["name"];

export type ParsedSlashCommand = {
  name: string;
  normalizedName: string;
  args: string;
};

export function parseSlashCommandInput(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return null;

  const commandText = trimmed.slice(1).trim();
  if (!commandText) {
    return {
      name: "",
      normalizedName: "",
      args: ""
    };
  }

  const [name, ...rest] = commandText.split(/\s+/);
  return {
    name,
    normalizedName: name.toLowerCase(),
    args: rest.join(" ").trim()
  };
}

export function findAppSlashCommand(name: string): AppSlashCommand | null {
  const normalizedName = name.toLowerCase();
  return appSlashCommands.find((command) => command.name === normalizedName) || null;
}

export function isServerAppSlashCommand(
  command: AppSlashCommand
): command is Extract<AppSlashCommand, { scope: "server" }> {
  return command.scope === "server";
}
