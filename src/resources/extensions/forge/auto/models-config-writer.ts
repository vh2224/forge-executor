import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  emptyConfig,
  modelsConfigSources,
  parseModelsConfig,
  type ModelsConfig,
} from "./models-config.js";

function serializeListSection(section: Record<string, string[]>): string[] {
  return Object.entries(section).map(([key, values]) => {
    // The project parser intentionally treats values as opaque strings and
    // does not unquote YAML scalars; emit the same plain scalar form used by
    // the repository models.md so round-trips preserve values exactly.
    const items = values.join(", ");
    return `    ${key}: [${items}]`;
  });
}

function serializeFlatSection(section: Record<string, string>): string[] {
  return Object.entries(section).map(([key, value]) => `    ${key}: ${value}`);
}

/**
 * Serializes the intentionally closed role×pool shape understood by
 * parseModelsConfig. Keeping the fence and indentation here makes the output
 * suitable for both the committed and local models layers.
 */
export function serializeModelsConfig(config: ModelsConfig): string {
  return [
    "```yaml",
    "models:",
    "  pools:",
    ...serializeListSection(config.pools),
    "  roles:",
    ...serializeListSection(config.roles),
    "  constraints:",
    ...serializeFlatSection(config.constraints),
    "```",
    "",
  ].join("\n");
}

function localPath(cwd: string): string {
  return modelsConfigSources(cwd).find((source) => source.label === "local")!.path;
}

function readLocalConfig(cwd: string): ModelsConfig {
  const file = localPath(cwd);
  if (!existsSync(file)) return emptyConfig();
  try {
    return parseModelsConfig(readFileSync(file, "utf8"));
  } catch {
    return emptyConfig();
  }
}

/** Atomically replaces the gitignored local layer after applying a mutation. */
export function writeModelsConfigLocal(
  cwd: string,
  mutate: (config: ModelsConfig) => ModelsConfig,
): void {
  const target = localPath(cwd);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const next = mutate(readLocalConfig(cwd));
  const temporary = path.join(directory, `.models.local.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, serializeModelsConfig(next), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}
