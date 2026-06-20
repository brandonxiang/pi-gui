export type AppSlashCommandScope = "client" | "server";

export const appSlashCommands = [
  { name: "settings", descriptionKey: "slash.settings", scope: "client" },
  { name: "model", descriptionKey: "slash.model", scope: "client" },
  { name: "copy", descriptionKey: "slash.copy", scope: "client" },
  { name: "session", descriptionKey: "slash.session", scope: "server" },
  { name: "export", descriptionKey: "slash.export", scope: "server" },
  { name: "name", descriptionKey: "slash.name", scope: "server" }
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
