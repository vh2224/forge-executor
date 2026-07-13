import { getAuthPath } from "@gsd/pi-coding-agent/config.js";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { OAuthLoginCallbacks } from "@gsd/pi-ai";
import { CredentialRotator } from "@forge/agent-core/credential-rotation.js";
import {
  addAccount,
  describeAccountStatus,
  listAccounts,
  removeAccount,
} from "@forge/agent-core/account-store.js";
import { isPrintHeadlessContext } from "./forge-command.js";

function output(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "success" = "info"): void {
  if (isPrintHeadlessContext(ctx)) process.stdout.write(`${message}\n`);
  else ctx.ui.notify(message, level);
}

function authStorage(ctx: ExtensionCommandContext) {
  return ctx.modelRegistry?.authStorage;
}

/** Render only redacted account projections; credential material never reaches output. */
// Cooldown labels are derived from the same rotator/backoff state as the loop.
function renderAccounts(ctx: ExtensionCommandContext): string {
  const storage = authStorage(ctx);
  if (!storage) return "Nenhum armazenamento de credenciais disponível.";
  const rotator = new CredentialRotator(storage);
  const providers = storage.list();
  if (providers.length === 0) return "Nenhuma conta configurada.";
  const lines: string[] = ["Contas Forge:"];
  for (const provider of providers) {
    const views = listAccounts(storage, provider);
    const statuses = describeAccountStatus(
      rotator,
      storage.getProviderBackoffRemaining(provider),
      provider,
      views,
      Date.now(),
    );
    for (const account of statuses) {
      const cooldown = account.cooldown === "ready"
        ? "pronto"
        : account.cooldown === "cooling"
          ? `cooldown${account.cooldownMsRemaining ? ` (${account.cooldownMsRemaining}ms)` : ""}`
          : `backoff${account.cooldownMsRemaining ? ` (${account.cooldownMsRemaining}ms)` : ""}`;
      lines.push(`  ${provider} [${account.index}] — ${account.label} — ${cooldown}`);
    }
  }
  return lines.join("\n");
}

function callbacks(ctx: ExtensionCommandContext): OAuthLoginCallbacks {
  return {
    onAuth: (info) => ctx.ui.notify(`Autenticação: ${info.url}${info.instructions ? `\n${info.instructions}` : ""}`, "info"),
    onDeviceCode: (info) => ctx.ui.notify(`Código: ${info.userCode}\nAbra: ${info.verificationUri}`, "info"),
    onProgress: (message) => ctx.ui.notify(message, "info"),
    onPrompt: (prompt) => ctx.ui.input(prompt.message, prompt.placeholder).then((value) => value ?? ""),
    onManualCodeInput: () => ctx.ui.input("Código de autorização", "Cole o código aqui")
      .then((value) => value ?? ""),
    onSelect: async (prompt) => {
      const selected = await ctx.ui.select(prompt.message, prompt.options.map((option) => `${option.id}: ${option.label}`));
      if (Array.isArray(selected)) return selected[0]?.split(":", 1)[0];
      return selected?.split(":", 1)[0];
    },
    signal: ctx.signal,
  };
}

async function add(ctx: ExtensionCommandContext, providerId: string | undefined): Promise<void> {
  const storage = authStorage(ctx);
  if (!storage) return output(ctx, "Não foi possível acessar as credenciais.", "warning");
  if (!providerId) return output(ctx, "Uso: /forge accounts add <provider>", "warning");
  const provider = storage ? (storage.getOAuthProviders().find((candidate) => candidate.id === providerId)) : undefined;
  if (!provider) return output(ctx, `Provider OAuth desconhecido ou sem login nativo: ${providerId}`, "warning");
  try {
    const credentials = await provider.login(callbacks(ctx));
    addAccount(getAuthPath(), providerId, { type: "oauth", ...credentials });
    storage.reload();
    output(ctx, `Conta adicionada: ${providerId}.`, "success");
  } catch (error) {
    output(ctx, `Falha ao adicionar conta: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

async function remove(ctx: ExtensionCommandContext, provider: string | undefined, rawIndex: string | undefined): Promise<void> {
  const storage = authStorage(ctx);
  if (!storage) return output(ctx, "Não foi possível acessar as credenciais.", "warning");
  const index = Number(rawIndex);
  if (!provider || !Number.isInteger(index)) return output(ctx, "Uso: /forge accounts remove <provider> <index>", "warning");
  const accounts = listAccounts(storage, provider);
  const account = accounts[index];
  if (!account) return output(ctx, `Conta não encontrada: ${provider} [${index}].`, "warning");
  const confirmed = await ctx.ui.confirm("Remover conta", `Remover ${provider} [${index}] (${account.label})?`);
  if (!confirmed) return output(ctx, "Remoção cancelada.");
  try {
    removeAccount(getAuthPath(), provider, index);
    storage.reload();
    output(ctx, `Conta removida: ${provider} [${index}].`, "success");
  } catch (error) {
    output(ctx, `Falha ao remover conta: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

export async function runAccountsCommand(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const subcommand = rest[0] ?? "list";
  if (subcommand === "list") return output(ctx, renderAccounts(ctx));
  if (subcommand === "add") return add(ctx, rest[1]);
  if (subcommand === "remove") return remove(ctx, rest[1], rest[2]);
  output(ctx, "Uso: /forge accounts [list|add <provider>|remove <provider> <index>]", "warning");
}
