import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { readState, readEvents, type NextUnit } from "../state/index.js";
import { authorFamilyForSlice } from "../auto/reviewer-independence.js";
import { scopeDomainFor } from "../auto/scope-domain.js";
import { readModelsConfig } from "../auto/models-config.js";
import { getForgeAutoSession } from "../auto/session.js";
import { resolveModelForRole, type ResolveModelCtx } from "../auto/role.js";
import {
  productionReviewDispatcher,
  runReviewDialectic,
  type ReviewDispatcher,
  type ReviewDialecticResult,
} from "../review/index.js";
import { readReviewPrefs } from "../review/review-prefs.js";

/** Convert an operator supplied target into a single safe artifact filename component. */
export function slugify(target: string): string | null {
  const slug = target
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug.length > 0 ? slug : null;
}

export interface ReviewCommandOptions {
  /** Test seam; production always uses the command context's newSession. */
  dispatcher?: ReviewDispatcher;
  /** Test seam for deterministic model casting. */
  resolveContext?: ResolveModelCtx;
  now?: string;
}

function output(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" = "info"): void {
  const ui = ctx.ui as { mode?: string } | undefined;
  const headless = !ctx.hasUI || process.env.GSD_HEADLESS === "1" || ui?.mode === "rpc" || ui?.mode === "headless";
  if (headless) process.stdout.write(message + "\n");
  else ctx.ui.notify(message, level);
}

function usage(ctx: ExtensionCommandContext): void {
  output(ctx, "Uso: /forge review <alvo> — ex.: /forge review S03 ou /forge review auth-flow", "warning");
}

/**
 * Run the native dialectic on demand. The challenger is resolved before the
 * artifact path is built so the filename records the family that actually
 * reviewed the target; the dialectic resolves the same deterministic cast.
 */
export async function runReviewCommand(
  ctx: ExtensionCommandContext,
  target: string,
  options: ReviewCommandOptions = {},
): Promise<void> {
  const rawTarget = target.trim();
  if (!rawTarget) {
    usage(ctx);
    return;
  }
  const slug = slugify(rawTarget);
  if (!slug) {
    usage(ctx);
    return;
  }

  const state = readState(ctx.cwd);
  const slice = /^S\d+$/i.test(rawTarget) ? rawTarget.toUpperCase() : rawTarget;
  const authorFamily = /^S\d+$/i.test(rawTarget)
    ? authorFamilyForSlice(readEvents(ctx.cwd), slice)
    : null;
  const unit: NextUnit = { type: "complete-slice", slice };
  const session = getForgeAutoSession();
  // Standalone review starts from this fresh operator context. The dispatcher
  // reads this run-scoped value later because its captured ctx may be stale
  // after a prior replacement. Cleared in the `finally` below so this
  // singleton field never outlives the standalone command that set it
  // (S02/R3 review-fix).
  session.runRootSessionPath = ctx.sessionManager?.getSessionFile?.() ?? null;
  try {
    const resolveContext = options.resolveContext ?? {
      session,
      config: readModelsConfig(ctx.cwd),
    };
    // Keep the session cwd aligned even when this command is invoked outside auto.
    resolveContext.session.cwd = ctx.cwd;
    const reviewer = resolveModelForRole("reviewer", unit, { ...resolveContext, authorFamily });
    const family = reviewer.family ?? "unknown";
    const writePath = join(ctx.cwd, "docs", "forge", `${slug}-REVIEW-${family}.md`);
    const dialectic: ReviewDialecticResult = await runReviewDialectic({
      cwd: ctx.cwd,
      milestoneId: state.milestone,
      slice,
      sliceTitle: rawTarget,
      unit,
      ctxForResolve: resolveContext,
      dispatcher: options.dispatcher ?? productionReviewDispatcher(ctx),
      reviewedOn: (options.now ?? new Date().toISOString()).slice(0, 10),
      rounds: readReviewPrefs(ctx.cwd).rounds,
      authorFamily,
      artifactTarget: { writePath },
      domain: /^S\d+$/i.test(rawTarget) ? scopeDomainFor(ctx.cwd, state.milestone, slice) : undefined,
    });
    const counts = dialectic.result.counts;
    output(
      ctx,
      `⚖ Review de ${rawTarget} gravado em ${writePath} — ${counts.resolved} resolvido(s), ${counts.conceded} concedido(s), ${counts.open} aberto(s).`,
    );
  } finally {
    session.runRootSessionPath = null;
  }
}
