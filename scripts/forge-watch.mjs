#!/usr/bin/env node
/**
 * forge-watch — vigia externo do loop, para um SEGUNDO terminal.
 *
 * Responde as três perguntas que a TUI ainda não responde (operador, 2026-07-11,
 * 4ª ocorrência do "está stale e eu sem reação"):
 *   1. Está rodando ou parou?    → linha de status ao vivo, idade do último evento
 *   2. Stale ou só demorado?     → tempo da unidade em voo vs teto de timeout
 *   3. O que EU faço agora?      → o comando exato, impresso quando há ação
 *
 * Uso:  node scripts/forge-watch.mjs   (no diretório do repo; Ctrl+C para sair)
 * Lê APENAS .gsd/ (journal + STATE) — nunca escreve, nunca toca na sessão.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const CWD = process.cwd();
const JOURNAL = join(CWD, ".gsd", "forge", "events.jsonl");
const STATE = join(CWD, ".gsd", "STATE.md");
const TIMEOUT_MS = Number(process.env.FORGE_UNIT_TIMEOUT_MS || 1_200_000);
const TICK_MS = 2_000;

function readState() {
  try {
    const raw = readFileSync(STATE, "utf8");
    const milestone = raw.match(/^milestone:\s*(\S+)/m)?.[1] ?? "";
    const phase = raw.match(/^phase:\s*(\S+)/m)?.[1] ?? "";
    return { milestone, phase };
  } catch {
    return { milestone: "", phase: "" };
  }
}

function readEvents(milestone) {
  try {
    const lines = readFileSync(JOURNAL, "utf8").trimEnd().split("\n");
    const out = [];
    // Últimas ~400 linhas bastam para o estado corrente.
    for (const l of lines.slice(-400)) {
      try {
        const e = JSON.parse(l);
        if (!milestone || e.milestone === milestone) out.push(e);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

const C = {
  dim: (t) => `\x1b[2m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
};

let lastBannerKey = "";

function render() {
  const now = Date.now();
  const { milestone, phase } = readState();
  const events = readEvents(milestone);
  const last = events[events.length - 1];
  const lastAge = last ? now - Date.parse(last.ts) : Infinity;

  // Unidade em voo: último dispatched sem result/timeout posterior para a mesma key.
  let inFlight = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "unit_result" || e.kind === "unit_timeout") break;
    if (e.kind === "unit_dispatched") { inFlight = e; break; }
  }

  // Terminal mais recente do loop (pausa/bloqueio) sem retomada posterior.
  let terminal = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "unit_dispatched" || e.kind === "unit_result") break;
    if (e.kind === "loop_paused" || e.kind === "loop_stuck") { terminal = e; break; }
  }

  let line = "";
  let banner = null;

  if (phase === "complete") {
    line = `${C.green("🏁 COMPLETO")} ${C.dim(milestone)} — nada a fazer`;
  } else if (terminal) {
    const unit = terminal.unit ?? "";
    line = `${C.red("⏸ PAUSADO")} ${C.bold(unit)} (${terminal.status ?? ""}) — ação necessária`;
    banner = [
      C.red(`⏸ Loop PAUSADO em ${unit} — ${terminal.status ?? ""}`),
      C.dim((terminal.summary ?? "").slice(0, 110)),
      `${C.bold("→ Para retomar:")} ${C.cyan(`/forge unblock ${unit}`)} na TUI (ou avalie o motivo antes), depois ${C.cyan("/forge auto")}`,
    ].join("\n");
  } else if (inFlight) {
    const elapsed = now - Date.parse(inFlight.ts);
    const remain = TIMEOUT_MS - elapsed;
    const quiet = fmtAge(lastAge);
    if (remain > 0) {
      const tone = lastAge > 180_000 ? C.yellow : C.green;
      line = `${tone("▶ RODANDO")} ${C.bold(inFlight.unit)} há ${fmtAge(elapsed)} ${C.dim(`· último evento ${quiet} atrás · timeout em ${fmtAge(remain)}`)} — ${lastAge > 180_000 ? "quieto mas dentro do teto: AGUARDE" : "saudável"}`;
    } else {
      line = `${C.red("⚠ POSSÍVEL TRAVAMENTO")} ${C.bold(inFlight.unit)} estourou o teto há ${fmtAge(-remain)} sem evento de timeout`;
      banner = [
        C.red(`⚠ ${inFlight.unit} passou do teto (${fmtAge(TIMEOUT_MS)}) e o loop não registrou timeout.`),
        `${C.bold("→ Ação:")} na TUI, ${C.cyan("Esc")} para interromper e ${C.cyan("/forge auto")} para retomar (estado em disco é seguro).`,
      ].join("\n");
    }
  } else if (events.length > 0) {
    line = `${C.yellow("· ENTRE UNIDADES")} ${C.dim(`último evento ${fmtAge(lastAge)} atrás`)} — housekeeping/derive; se passar de 2m assim, ${C.cyan("Esc + /forge auto")}`;
  } else {
    line = C.dim("sem eventos para o milestone ativo — loop não iniciado? rode /forge auto na TUI");
  }

  process.stdout.write(`\r\x1b[2K${line}`);

  const key = banner ? banner.slice(0, 60) : "";
  if (banner && key !== lastBannerKey) {
    process.stdout.write(`\n${banner}\n`);
    lastBannerKey = key;
  }
  if (!banner) lastBannerKey = "";
}

if (!existsSync(JOURNAL)) {
  console.error("forge-watch: .gsd/forge/events.jsonl não encontrado — rode no diretório do repo.");
  process.exit(1);
}
console.log(C.dim(`forge-watch · teto de unidade ${fmtAge(TIMEOUT_MS)} · atualiza a cada ${TICK_MS / 1000}s · Ctrl+C sai`));
render();
setInterval(render, TICK_MS);
