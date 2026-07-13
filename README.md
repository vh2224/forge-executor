# ⚒ Forge Executor

**Harness de engenharia autônoma multi-LLM.** Você descreve a milestone; o Forge planeja, executa, revisa com modelos de famílias diferentes se confrontando, tria as objeções com você e encerra — com cada decisão auditável em markdown, e cada unidade de trabalho roteada para o modelo mais apto àquele domínio.

> An autonomous multi-LLM engineering harness: milestone lifecycle, adversarial cross-family reviews, aptitude-based model routing (Claude · GPT · Grok) — with markdown-as-truth state that survives any restart.

---

## Por quê

Agentes de código presos a um único provedor desperdiçam o melhor de cada família: há modelo melhor para planejar, outro para executar barato, outro para revisar com olhos que o autor não tem. E loops autônomos que guardam estado "na conversa" morrem no primeiro restart.

O Forge Executor resolve os dois problemas de raiz:

- **Multi-LLM de verdade** — Claude (assinatura, via Claude Code SDK), ChatGPT/Codex (OAuth da assinatura), xAI/Grok e outros, no mesmo loop, escolhidos **por papel e por aptidão de domínio**, task a task.
- **Markdown como fonte de verdade** — todo o estado vive em `.gsd/` (STATE, ROADMAP, PLANs, REVIEWs, KNOWLEDGE, LEDGER). Mate o terminal, troque de conta, volte amanhã: `forge` retoma do ponto exato, porque o disco é a memória.

## Instalação

```bash
npm install -g forge-executor
cd seu-projeto
forge            # abre a TUI
/forge init      # bootstrap do .gsd/ (detecta a stack, gera templates comentados)
```

Provedores: faça `/login` uma vez por provedor na TUI (Claude via Claude Code, ChatGPT/Codex via OAuth da assinatura, xAI via API key). Modelos custom entram em `~/.forge/agent/models.json`.

## O ciclo de vida completo

```bash
/forge milestone "dashboard de custos por modelo"   # nasce: worker faz recon do repo e AUTORA o CONTEXT
# → você lapida o CONTEXT.md no editor (decisões, fora-de-escopo)
/forge milestone start M-<id>                        # ativa: planner decompõe em slices/tasks (ROADMAP)
/forge auto                                          # executa a milestone inteira, autônomo
# → finale com overview do que foi construído + pendências de review
/forge fix S02                                       # tria as objeções do review com um executor dedicado
```

Cada **task** roda em sessão isolada (contexto fresco), com modelo e profundidade de raciocínio escolhidos para ela. Cada **slice** fecha com um **review dialético**: um *challenger* de família diferente do autor levanta objeções; um *advocate* da família autora defende, concede ou marca trade-offs; uma réplica fecha o confronto. O que os dois não resolvem sobe para você — nada morre em silêncio.

## Roteamento por aptidão — cerca × julgamento

Duas superfícies, dois papéis:

| | Arquivo | Papel |
|---|---|---|
| **Cerca** | `.gsd/models.md` | *Quem pode concorrer* — pools de modelos por papel (planner, executor, reviewer, advocate…) |
| **Julgamento** | `.gsd/CAPABILITIES.md` | *Quem vence* — matriz domínio × modelo com score e fontes, alimentada por `/forge research-models` (pesquisa web com citações) e pela sua curadoria (`locked` = a pesquisa nunca sobrescreve) |

```yaml
# .gsd/models.md
models:
  pools:
    planners:  [claude-code/claude-fable-5, openai-codex/gpt-5.6-sol]
    executors: [claude-code/claude-sonnet-5, openai-codex/gpt-5.6-luna, openai-codex/gpt-5.6-terra]
    reviewers: [openai-codex/gpt-5.6-terra, claude-code/claude-opus-4-8]
  roles:
    planner: [planners]
    executor: [executors]
    reviewer: [reviewers]
  constraints:
    reviewer_not_author: family     # reviewer nunca é da família do autor — fail-closed
```

O rank compara **a união dos pools do papel**: aptidão no domínio da task é o fator principal, custo desempata entre scores próximos, e o porquê de cada escolha vai para o journal (`rank_reason`). O planner emite `domain:` e `effort:` no frontmatter de cada plano — *quem* executa e *com quanta profundidade* são eixos independentes, e clamps de raciocínio são registrados, nunca silenciosos.

## Confiança verificável, não auto-relato

- **Autoria G1**: o journal (`.gsd/forge/events.jsonl`) registra o modelo que **de fato** executou cada unidade — verificado contra a sessão real, não contra a intenção.
- **Gates advisory**: must-haves estruturados por plano, verificação de artefatos (existe → substantivo → wired), auditoria de arquivos, plan-checker de 10 dimensões, gate de suíte no encerramento — documentam sem travar o loop.
- **Detectores de enforcement**: scope-drop (escopo prometido que some do plano), compliance de frontmatter, through-the-driver (nenhum trabalho fora do dispatch auditado).
- **Review por confronto**: 3 ciclos de review cross-família encontraram bugs verificados que a família autora não viu — inclusive no código do próprio harness.

## Cockpit

- Strip viva: `⚒ executor · sonnet-5 · S02/T03 — corrigindo write-back` (papel · modelo · unidade · ação corrente); painel expandido no `Ctrl+B`
- `/forge status` — dashboard: milestone, slices, pendências de review, próxima ação
- Finale de milestone com o que foi construído por slice, autoria por modelo, resultado da suíte e digest de triagem
- `--continue` / `--resume` — retome sessões; transcript narrativo sem paredes de tool-dump

## Comandos

| Comando | Faz |
|---|---|
| `/forge init` | Bootstrap do `.gsd/` num projeto virgem (idempotente, doctor-lite com `--repair`) |
| `/forge milestone "…"` · `start` | Nascimento com CONTEXT autorado por worker + ativação |
| `/forge auto` · `next` | Loop autônomo da milestone · uma unidade por vez |
| `/forge task "…"` | Task solta sem milestone (plan → execute → review dialético) |
| `/forge fix [S## \| T-id]` | Triagem: lista pendências de review e despacha correções |
| `/forge review <alvo>` | Review dialético on-demand sobre qualquer diff |
| `/forge research-models` | Atualiza a matriz de aptidão com pesquisa web citada |
| `/forge models` · `accounts` · `status` · `migrate` | Config da cerca · contas · dashboard · migração 1.0 → 2.0 |

## Arquitetura em um parágrafo

Um fork enxuto do [gsd-pi](https://github.com/open-gsd/gsd-pi) (por sua vez sobre o [pi](https://github.com/earendil-works/pi)) reduzido ao harness core, com a metodologia Forge escrita como extensão nativa: orquestrador determinístico em TypeScript (não prosa interpretada), workers em sessões isoladas com rendezvous tokenizado, ponte MCP para o resultado de unidade, e todo estado em markdown auditável. A metodologia veio do [forge-agent 1.0](https://github.com/vh2224/forge-agent) (orquestração sobre Claude Code) — o 2.0 é a mesma doutrina com músculo próprio.

## Documentação

- [`docs/forge/OPERATOR-GUIDE.md`](docs/forge/OPERATOR-GUIDE.md) — guia do operador (comece por aqui; §5.0 explica cerca × julgamento)
- [`docs/forge/FORGE2-ROUTING-CONFIG.md`](docs/forge/FORGE2-ROUTING-CONFIG.md) — referência profunda do roteamento
- [`docs/forge/FORGE2-CAPABILITIES-FORMAT.md`](docs/forge/FORGE2-CAPABILITIES-FORMAT.md) — formato da matriz de aptidão
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — migrando projetos do forge-agent 1.0

## Roadmap próximo

- **Fio da conversa** (em curso): sessões de um run ligadas por linhagem, picker sem ruído de workers, `--continue` retomando a conversa do operador, memória conversacional destilada e operação por linguagem natural ("continua a m12") via tool sancionada

## Créditos e licença

MIT. Construído sobre o trabalho excelente de [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi) e [earendil-works/pi](https://github.com/earendil-works/pi) — a licença e os créditos originais estão preservados em [`LICENSE`](LICENSE).

*Forge Executor: você decide o quê e por quê; ele resolve quem, como e com quanta força.*
