import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readModelsConfig, type ModelsConfig } from "../auto/models-config.js";
import { writeModelsConfigLocal } from "../auto/models-config-writer.js";
import { isPrintHeadlessContext } from "./forge-command.js";

function output(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "success" = "info"): void {
  if (isPrintHeadlessContext(ctx)) process.stdout.write(`${message}\n`);
  else ctx.ui.notify(message, level);
}

function renderSection(title: string, entries: Record<string, string[]>): string[] {
  const lines = [`${title}:`];
  for (const [key, values] of Object.entries(entries)) lines.push(`  ${key}: ${values.join(", ") || "(vazio)"}`);
  if (lines.length === 1) lines.push("  (nenhum)");
  return lines;
}

function renderConfig(config: ModelsConfig): string {
  return [
    "Forge models (role×pool):",
    ...renderSection("Pools", config.pools),
    ...renderSection("Roles", config.roles),
    "Constraints:",
    ...Object.entries(config.constraints).map(([key, value]) => `  ${key}: ${value}`),
    ...(Object.keys(config.constraints).length === 0 ? ["  (nenhuma)"] : []),
  ].join("\n");
}

function cloneConfig(config: ModelsConfig): ModelsConfig {
  return {
    pools: Object.fromEntries(Object.entries(config.pools).map(([key, value]) => [key, [...value]])),
    roles: Object.fromEntries(Object.entries(config.roles).map(([key, value]) => [key, [...value]])),
    constraints: { ...config.constraints },
  };
}

function applyEdit(config: ModelsConfig, section: string, key: string, rawValue: string): ModelsConfig {
  const next = cloneConfig(config);
  if (section === "pools" || section === "roles") {
    next[section][key] = rawValue.split(",").map((value) => value.trim()).filter(Boolean);
  } else {
    next.constraints[key] = rawValue.trim();
  }
  return next;
}

export async function runModelsCommand(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const subcommand = rest[0] ?? "view";
  if (subcommand === "view") {
    output(ctx, renderConfig(readModelsConfig(ctx.cwd)));
    return;
  }
  if (subcommand !== "set") {
    output(ctx, "Uso: /forge models [view|set <pools|roles|constraints> <key> <value>]", "warning");
    return;
  }

  const section = rest[1];
  const key = rest[2];
  const rawValue = rest.slice(3).join(" ").trim();
  if (!section || !key || !rawValue || !["pools", "roles", "constraints"].includes(section)) {
    output(ctx, "Uso: /forge models set <pools|roles|constraints> <key> <value>", "warning");
    return;
  }

  writeModelsConfigLocal(ctx.cwd, (local) => applyEdit(local, section, key, rawValue));
  const updated = readModelsConfig(ctx.cwd);
  output(ctx, `Modelos atualizados na camada local.\n${renderConfig(updated)}`, "success");
}

export { renderConfig };
