# PROJECT — Forge 2.0 (nome provisório)

## O que é o Forge 2.0

O Forge 2.0 é um fork do [gsd-pi](https://github.com/open-gsd/gsd-pi) reduzido ao harness
core (agent loop + suporte multi-provider + TUI + sistema de extensões) para receber a
metodologia Forge como uma extensão nativa nova, escrita em TypeScript, em vez de depender do
orquestrador externo em Python (o "forge 1.0"). O objetivo do programa é que o próprio 2.0
passe a gerir seus milestones — planejamento, dispatch, verificação, review, memória — sem
processo externo, rodando dentro do mesmo binário (`dist/loader.js`) que hospeda o agente.

Este repo NÃO é o gsd-pi: a extensão GSD legada (`src/resources/extensions/gsd/`) e os
subsistemas web/studio/daemon do fork original estão condenados à remoção (M0-S02) — código
útil é colhido depois via histórico git, nunca reimportado diretamente da árvore condenada.
Linhagem completa e atribuição em `NOTICE`: gsd-pi © Open GSD (MIT) → pi © Mario Zechner
(MIT) → metodologia Forge © Vinicius Almeida (MIT, [forge-agent](https://github.com/vh2224/forge-agent)).

Durante a transição (M0-M2), o forge 1.0 (Python) segue gerindo o `.gsd/` deste repo —
decisão D14 em `docs/forge/FORGE2-DECISIONS.md` — enquanto o 2.0 constrói, slice a slice, a
máquina nativa que vai substituí-lo. Essa dogfood dupla é intencional: mantém a metodologia
viva durante a transição e testa o 1.0 em um projeto TypeScript grande e real.

## Estado pós-M2 (máquina nativa completa)

Ao final de M2 (`M-20260709234644-paridade-auto-hospedagem`), o loop nativo do Forge 2.0
cobre planejamento, dispatch, gates, review, verificação, memória e resume — ponta a ponta,
sem depender do orquestrador Python para a lógica de decisão. Estado por slice:

- **S01** — extensão `forge` bundled (tier core) + comandos `/forge status|help|auto|next`
  (stubs honestos) + cascata de prefs de 4 camadas + limpeza de resíduo de skills legadas.
- **S02** — núcleo puro de estado: parsers/serializers read-compat com o 1.0
  (`state/parse.ts`, `state/serialize.ts`), modelo `StateDoc`/`RoadmapSlice`/`PlanDoc`, e
  `state/store.ts` (mutação atômica single-writer de `STATE.md` + journal de eventos).
- **S03** — o loop em si: `forge_unit_result` como único ponto de commit, prompts
  plan-slice/execute-task portados, `applyUnitResult`/`reconcileCompletion`/
  `decideNextAction`, `runForgeLoop` sobre um `SessionDriver` injetável, e
  `/forge auto`/`/forge next` como handlers reais.
- **S04** — fecha o caminho real de `newSession` (closes S03-R1/R1-b), e-e2e real-path
  provando o turno do worker de ponta a ponta, widgets de progresso no footer/painel
  colapsável, e e2e de binário real cobrindo complete-milestone e resiliência a `kill -9`.
- **S05** — CI enxuto (`ci.yml`), guarda anti-import de árvore condenada
  (`verify-no-deleted-imports.cjs`), smoke real de conversa fake-provider, runbooks de
  operador, e remoção do subsistema web (28 arquivos + 62 testes órfãos).
- **S06** — verificação nativa: `verifyArtifact` (L1-3, faithful port do
  `forge-verifier.js`), `auditTestQuality` (L4), `runSliceVerification`
  (`S##-VERIFICATION.md` nativo), `enforceMustHaves` (o único predicado que bloqueia),
  auditoria de arquivos advisory, e captura de evidência por instância.
- **S07** — memória emergente: fragment store `.gsd/memory/<unit>.md`, ranking puro
  (`decayFactor`/`scoreFact`/`selectMemoryFacts`), projeção `AUTO-MEMORY.md` idempotente
  no merger de estado, injeção de "Project Memory" no prompt, e footprint advisory de
  memória no journal.
- **S08** — a virada de auto-hospedagem: runner nativo desacoplado da árvore condenada
  (T01), regressões provando operação real sobre `.gsd/` histórico do 1.0 (T02), gaps de
  status/depends/resume fechados com regressão própria (T03), e o harness de aceite
  (`docs/forge/FORGE2-S08-ACCEPTANCE.md` + `S08-UAT.md`) que documenta a cerimônia de troca
  de guarda (T04) — e este próprio documento condicional (T05).

## Aposentadoria do forge 1.0 (condicional)

**A aposentadoria do forge 1.0 neste repo é sempre condicional — nunca fato consumado.** No
momento deste commit, o forge 1.0 (Python) segue gerindo o `.gsd/` deste repositório (regra
de ferro 3 do `CLAUDE.md`). O texto canônico, fixado em `S08-PLAN.md § B4`, é:

> A partir da primeira execução verde do S08-UAT (a virada), o forge 1.0 sai do loop deste
> repo e o M3 é criado pelo próprio 2.0.

Quando essa condição disparar (reporte do operador de uma cerimônia S08-UAT verde), o que
muda:

1. O forge 1.0 (Python) para de despachar unidades contra este `.gsd/`; toda invocação
   passa a vir do binário 2.0 (`dist/loader.js`, comando `/forge auto`/`/forge next`).
2. O milestone M3 (roteamento por papel — decisão D15) passa a ser criado pelo próprio
   Forge 2.0, não mais planejado/despachado pelo 1.0.
3. A decisão D14 em `docs/forge/FORGE2-DECISIONS.md` — hoje `proposta (M0)` com a anotação
   da condição de fechamento — vira `locked`, ato do operador pós-cerimônia, fora deste
   commit e fora deste slice.

O roteiro exato da cerimônia (pré-requisitos, comando exato, critérios de pass/fail
observáveis) está em [`docs/forge/FORGE2-S08-ACCEPTANCE.md`](docs/forge/FORGE2-S08-ACCEPTANCE.md)
e no script executável [`S08-UAT.md`](.gsd/milestones/M-20260709234644-paridade-auto-hospedagem/slices/S08/S08-UAT.md)
(runtime, gitignored — mirror do formato de `S01-UAT.md`).

## Comandos

```bash
pnpm install --frozen-lockfile              # Node >=22, pnpm 10.12.1
GSD_NATIVE_DISABLE=1 pnpm run build:pi      # build do harness (9 alvos ordenados)
pnpm --filter @gsd/<pkg> test               # testes por pacote
node scripts/verify-pi-patches.cjs          # integridade do vendoring pi
```
