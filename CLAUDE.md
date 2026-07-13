# Forge 2.0 (nome provisório) — fork do gsd-pi

Este repo é o **Forge 2.0**: fork do [gsd-pi](https://github.com/open-gsd/gsd-pi) sendo
reduzido ao harness core (agent loop + multi-provider + TUI + extension system) para
receber a metodologia Forge como extensão nova. **Não é** o gsd-pi — a extensão GSD e
os subsistemas web/studio/daemon estão condenados à remoção (M0-S02).

## Estado atual

- **A VIRADA ACONTECEU (2026-07-10).** M2 consumado + review-fix aplicado + A1 real-provider
  VERDE + cerimônia S08 PASSOU. O binário 2.0 assumiu o `.gsd/` real deste repo e corrigiu o
  próprio banner ponta a ponta (milestone `M-20260710223352-fix-banner-forge-forge`, commit
  `6e14b2a9`, 4/4 unit_results, 0 timeouts, exit 0) — exibindo autonomamente a própria
  metodologia (verificou baseline pré-existente antes de commitar, escreveu teste de regressão).
- **D14 LOCKED — forge 1.0 APOSENTADO neste repo.** Daqui em diante o desenvolvimento é gerido
  pelo binário 2.0 (`dist/loader.js`), não mais pelo orquestrador 1.0. Ver
  `docs/forge/FORGE2-S08-ACCEPTANCE.md §6`.
- **M2R-1 fechado** por 4 commits (`85c16adb..a4e3c753`, 12 takes de debugging ao vivo): a
  ponte MCP entrega em produção; os defeitos reais eram contrato de paths do planner, critério
  done/partial, mandato de commit, teardown do SDK (bug upstream `claude-agent-sdk` 0.2.83 —
  reportar `/feedback`) e contrato de exit estruturado. Detalhe: `.gsd/KNOWLEDGE.md`.
- **Próxima ação:** criar o M3 PELO PRÓPRIO 2.0 (critério #6 da cerimônia — o pós-teste
  definitivo da troca de guarda), importando do `.gsd/KNOWLEDGE.md`: M2R-3..9, D15 G1/G2
  (re-plantar — dropados no M2), fake-driver turn race (e2es diagnosticados), build-DX
  dist-test. Pendente do operador: Q1 (nome/publicação). **Gotcha:** edições em
  `packages/forge-agent-*` só valem no binário após `pnpm run test:compile` (runtime resolve
  via dist-test, não `packages/*/dist`).

## Leitura obrigatória (ordem)
1. `.gsd/STATE.md` — posição atual e próxima ação (se existir; runtime, gitignored)
2. `docs/forge/FORGE2-DECISIONS.md` — decisões D1–D14 travadas + questões Q1–Q5
3. `docs/forge/FORGE2-ROADMAP.md` — programa M0–M4
4. `docs/forge/FORGE2-ARCH-REVIEW.md` — análise arquitetural completa (referência)
5. `PROJECT.md` — identidade do projeto + estado pós-M2 + plano condicional de aposentadoria do 1.0
6. `docs/forge/FORGE2-S08-ACCEPTANCE.md` — roteiro da cerimônia de virada (condição de aposentadoria do 1.0)

## Regras de ferro
1. **`packages/pi-*` é fonte vendorizada** do upstream [earendil-works/pi](https://github.com/earendil-works/pi)
   (pin: `scripts/pi-upstream.json`). Mudanças só via patch-allowlist
   (`node scripts/verify-pi-patches.cjs` valida). Na dúvida, o lugar certo do código é
   `packages/gsd-agent-*` (futuros `forge-agent-*`) ou uma extensão.
2. **`src/resources/extensions/gsd/` está condenada** — proibido criar novas
   dependências/imports para ela. Módulos úteis serão colhidos depois via histórico git.
3. **`.gsd/` é gitignored aqui** (estado runtime do forge 1.0 gerindo este repo).
   Inteligência durável do programa → `docs/forge/`. O 1.0 gere o `.gsd/` até a primeira
   execução verde do S08-UAT (a virada) — ver `PROJECT.md`.
4. **Sem `git push`** até existir remote `origin` (decisão Q1 pendente). Branches locais.
5. **Deleções em massa:** commit atômico por subsistema, build verde antes de cada commit.
6. Rust nativo desligado: builds e CI usam `GSD_NATIVE_DISABLE=1`.
7. **Doutrina anti-`--print` aninhado.** Forge-dentro-de-forge NUNCA via `--print`
   em background: jamais lance o binário (`gsd`/forge) em modo `--print`/`-p` como
   job em background (`&`, `nohup`, `run_in_background`, etc.) de dentro de uma
   sessão forge ou de um assistente — isso cria um job opaco com zero
   visibilidade (sem strip, sem painel, sem como interromper; incidente 2026-07-12).
   Caminhos legítimos: rodar `/forge auto`/`/forge next` NA sessão TUI corrente;
   headless é decisão do operador humano, em foreground com stdout visível.

## Comandos
```bash
pnpm install --frozen-lockfile              # Node >=22, pnpm 10.12.1
GSD_NATIVE_DISABLE=1 pnpm run build:pi      # build do harness (9 alvos ordenados)
pnpm --filter @gsd/<pkg> test               # testes por pacote
node scripts/verify-pi-patches.cjs          # integridade do vendoring pi
```

## Convenções
- Conventional commits em inglês; escopo `(forge)` para trabalho do programa 2.0.
- TS estrito, ESM; seguir padrão dos arquivos vizinhos (imports `.js`, sem default exports novos).
- UI/mensagens ao usuário: português (pt-BR); código/comentários: inglês.

## Linhagem e atribuição
Ver `NOTICE`. gsd-pi © Open GSD (MIT) → pi © Mario Zechner (MIT) → metodologia Forge ©
Vinicius Almeida (MIT, [forge-agent](https://github.com/vh2224/forge-agent)).
