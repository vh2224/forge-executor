# Forge 2.0 — Routing config (role×pool)

> Superfície de config **declarada e travada** na S03 do milestone
> `M-20260711031733-multi-llm-roteamento`. Decisão registrada em
> `S03-PLAN.md §Config surface`; este doc é a referência operador+dev que
> cumpre a exigência de ROADMAP §Notas de escopo ("documentar como plugar
> credencial real").

## 1. Onde o arquivo vive

Cascata de 2 camadas, mesmo eixo do `prefs` (`prefs.ts:33` `prefsSources`),
mas com parser próprio (`auto/models-config.ts`) — **não** estende
`parsePrefsBlock` (D3, `session.ts:218`: prefs é flat-only e não deve virar
YAML nested):

| Ordem (menor → maior precedência) | Caminho              | Escopo                  |
|------------------------------------|-----------------------|--------------------------|
| 1                                   | `.gsd/models.md`       | repo, committed          |
| 2                                   | `.gsd/models.local.md` | repo, **gitignored**     |

Ausência de qualquer camada (arquivo inexistente, ilegível, malformado)
degrada silenciosamente essa camada para "não contribuiu nada" — nunca
lança. Se **nenhuma** camada existir, `readModelsConfig` retorna um
`ModelsConfig` vazio (`{ pools: {}, roles: {}, constraints: {} }`), que
`resolveModelForRole` trata como idêntico ao baseline pool-of-one do S02
(`effectiveModelFor` + `familyOf`) — o comportamento legado nunca regride.

O merge entre camadas é raso, por seção, last-wins: uma chave definida em
`models.local.md` sobrescreve a mesma chave de `models.md`; chaves que a
camada local não menciona passam intactas.

## 2. Forma travada (contrato do parser)

O conteúdo é um bloco fenced ` ```yaml ` embutido no `.md` (mesma disciplina
de `prefs.md` sendo Markdown), contendo **exatamente** esta forma nested —
o parser (`auto/models-config.ts parseModelsConfig`) reconhece **apenas**
isto, não é YAML de propósito geral (regra de ferro do repo: sem nova
dependência YAML, `prefs.ts:13`):

```yaml
models:
  pools:
    claude: [claude-code/claude-opus-4-8, claude-code/claude-sonnet-5]
    gpt: [openai/gpt-5.5, openai/gpt-5-mini]
  roles:
    planner: [claude, gpt]      # listas ORDENADAS de nomes de pool candidatos
    executor: [claude, gpt]
    completer: [claude]
    reviewer: [gpt]             # consumido a partir de S04 — ver §8
  constraints:
    reviewer_not_author: family # filtro runtime implementado em S04 — ver §8
    on_missing_pool: degrade+warn   # ou "block"
```

- `pools` — mapa `nome-do-pool → [provider/model-id, ...]`, lista ordenada.
- `roles` — mapa `role → [nome-do-pool-candidato, ...]`, lista ordenada; a
  ordem É a prioridade de fallback.
- `constraints` — mapa flat `key: value`.
- Linhas fora dessa forma fechada são ignoradas, tolerante — mesma disciplina
  do parser de prefs.
- **Roles reconhecidos pelo dispatch em S03:** `planner | executor |
  completer` (o union atual de `Role`, S02). `reviewer`/`advocate` são
  parseados e preservados pela config, mas o dispatch S03 nunca os deriva
  (isso é S04) — `Role` não é widened aqui.
- `constraints.reviewer_not_author` é parseado e preservado desde S03; o
  filtro runtime que o consome foi implementado em S04 — ver §8.

## 3. Semântica de resolução: filtrar → rankear → escolher

`resolveModelForRole(role, unit, ctx)` (`auto/role.ts`), o seam único
(S02), resolve assim quando há config:

1. **Filtrar:** para o `role`, lê `config.roles[role]` — a lista ordenada de
   pools candidatos. Para cada pool, cada ref é testado por
   `isModelAvailable(ref, ctx.availabilityProbe)` (`auto/availability.ts`).
2. **Rankear (mínimo em S03):** a ordem já É o rank — ordem dos pools
   candidatos do papel, depois ordem dos refs dentro de cada pool. **Não** há
   tier/capability/custo aqui; isso é **S05**, que preenche o mesmo passo
   "rankear" por dentro sem mudar a assinatura do seam.
3. **Escolher:** o primeiro ref que passa no filtro de disponibilidade,
   varrendo pools na ordem do papel e refs na ordem do pool. `provider` é o
   prefixo antes de `/`; `family` vem de `familyOf` (`state/family.ts`, o
   único site de derivação — nunca re-derivado).

Se a varredura não encontra nenhum ref disponível (papel sem entrada em
`roles`, pool vazio, ou todo candidato indisponível), decide
`constraints.on_missing_pool`.

## 4. `on_missing_pool`

| Valor                    | Comportamento                                                                 |
|---------------------------|--------------------------------------------------------------------------------|
| `degrade+warn` (default)  | Cai no baseline pool-of-one S02 (`effectiveModelFor` + `familyOf`), loga um `console.warn` nomeando o papel. Nunca lança. |
| `block`                   | Retorna `{ model: null, provider: null, family: null }` — nunca `""`/`"null"` (G1). Não cai no baseline. |

O default (`degrade+warn` quando `on_missing_pool` está ausente) é o que
mantém o caso "sem config no disco" byte-idêntico ao comportamento S02: uma
config ausente/vazia não tem `roles[role]`, então a varredura sempre esgota
e sempre degrada.

## 5. Disponibilidade: sintética, injetável, fork-side (não credencial real)

`AvailabilityProbe` (`auto/availability.ts`) é um predicado puro
`(ref: string) => boolean`, **não** uma consulta a `forge-agent-core` /
`AuthStorage`. Sem probe injetado, todo ref é tratado como disponível — o
caminho sem config permanece idêntico ao S02, que nunca filtra nada. Os
testes sintéticos (`tests/role-pool.test.ts`, `tests/role.test.ts`) injetam
`unavailableRefsProbe([...])` para simular 2 famílias fake e esgotamento sem
nenhuma credencial real, rede, ou dependência de conta.

Isso é deliberado (S03-PLAN §Availability): alcançar
`forge-agent-core` (`isProviderAvailable`/`getCredentialsForProvider`,
`fallback-resolver.ts:144`) cruzaria a fronteira de build
(`test:compile`/dist-test) que S03 não toca — o gate desta slice builda só
via `build:core`. Esse acoplamento real é o gap de **S06** (multi-conta,
handoff sobre `AuthStorage`).

## 6. Credencial real (não exercida no gate)

Este é o caminho **documentado, não exercido** exigido por
ROADMAP §Ambiente / §Notas de escopo: "todas as provas de S03–S06 usam
providers sintéticos / fake driver; o gate NUNCA exige credencial gpt
real."

Quando uma `AvailabilityProbe` real (fora do escopo de S03) precisar
consultar credenciais de fato, o ponto de entrada é
`AuthStorage.getCredentialsForProvider(provider)`
(`packages/pi-coding-agent/src/core/auth-storage.ts:266`):

```ts
getCredentialsForProvider(provider: string): AuthCredential[]
```

- Recebe o slug do provider (ex.: `"openai"`, o prefixo antes de `/` num
  ref de pool) e retorna um array de `AuthCredential` (`api_key` ou
  `oauth`) — **já suporta múltiplas credenciais por provider**, hoje só
  consumidas via `[0]` nos callers existentes.
- Uma `AvailabilityProbe` real, fork-side, poderia chamar isso para decidir
  se `provider` tem ao menos uma credencial não-esgotada — sem tocar
  `packages/pi-coding-agent` (vendorizado, regra de ferro #1 do repo).
- **Rotação/handoff entre credenciais do array (esgotamento → próxima conta,
  in-process, sem relaunch) é escopo de S06**, não desta slice. S03 só
  documenta o ponto de entrada; não o implementa nem o exercita.
- Nenhum teste desta slice (`role.test.ts`, `role-pool.test.ts`,
  `models-config.test.ts`, `availability.test.ts`) importa
  `auth-storage.ts` ou qualquer módulo de `packages/pi-coding-agent` — a
  extensão `forge` builda via `build:core`, sem `test:compile`, e o gate
  de S03 nunca precisa de uma chave `openai` real no ambiente.

## 7. Ausência de config = comportamento S02

Sem `.gsd/models.md` nem `.gsd/models.local.md` no disco, e sem `ctx.config`
injetado, `resolveModelForRole` se comporta exatamente como o seam S02
(pool-of-one via `effectiveModelFor` + `familyOf`) — provado em
`tests/role.test.ts` (`describe("resolveModelForRole — no config on disk ==
S02 degenerate baseline")`). Isso garante que ligar o roteamento role×pool é
estritamente aditivo: nenhum projeto existente regride ao não ter o arquivo.

## 8. `reviewer_not_author: family` — invariante adversarial (S04)

Instalado na S04 do milestone `M-20260711031733-multi-llm-roteamento` como um
**filtro em runtime** dentro do mesmo corpo filtrar→rankear→escolher de §3 —
nenhuma mudança de assinatura, nenhum novo seam.

**(a) Referente — a família autora.** É a autoria G1 gravada por S01 no
journal (`.gsd/forge/events.jsonl`, `ForgeEvent.family`): o campo já derivado
uma vez por `familyOf` no caminho real de dispatch (`unit_dispatched`/
`unit_result` de um `execute-task`), nunca re-derivado aqui. O helper puro
`authorFamilyForSlice(events, slice)` (`auto/reviewer-independence.ts`, T01)
varre os eventos de um slice de trás para frente e devolve a família do
`execute-task` mais recente que carrega uma — `null` se nenhum carrega. O
call-site resolve isso a partir de `readEvents(cwd)` (`state/store.ts:106`,
síncrono, tolerante) e injeta o resultado já pronto em `ctx.authorFamily`; o
seam (`resolveModelForRole`) nunca lê o journal por conta própria.

**(b) `reviewer` exclui, `advocate` resolve-para.** Quando o filtro está
ativo (ver (c)), cada pool candidato do papel é estreitado ANTES do filtro de
disponibilidade de §3, compondo com ele (interseção, não substituição):

- **`reviewer`** — `excludeAuthorFamily(pool, authorFamily)` remove todo ref
  cuja `familyOf(ref)` é a família autora. O reviewer nunca recebe de volta o
  próprio trabalho do autor para revisar.
- **`advocate`** — `onlyAuthorFamily(pool, authorFamily)` mantém só os refs
  cuja `familyOf(ref)` é a família autora. O advogado defende o código do
  próprio autor.

Um pool esvaziado pelo filtro cai para o próximo pool candidato do papel
exatamente como um pool todo indisponível já fazia em S03; se todos os pools
esvaziarem, `constraints.on_missing_pool` decide como em §4 — o filtro
adversarial só reduz o conjunto elegível, nunca toca a mecânica de degradação.

**(c) Gate.** O filtro só é aplicado quando as DUAS condições valem:
`constraints.reviewer_not_author === "family"` (checado por
`reviewerIndependenceActive`, `auto/reviewer-independence.ts`) **e**
`ctx.authorFamily` é uma string conhecida (não `null`/`undefined`). Faltando
qualquer uma, `reviewer`/`advocate` degradam para o corpo role×pool puro de
§3 — sem filtro adversarial, aditivo, nunca regride S03. `tests/
reviewer-independence-e2e.test.ts` prova as duas metades desse gate: um caso
constraint-off (config sem `reviewer_not_author`) e um caso sem autoria
conhecida (`authorFamily: null`), ambos revertendo ao pick de pool order puro.

**(d) Decisão (B) — nenhum unit-type de review no loop.** `Role`
(`auto/role.ts`) foi widened com `"reviewer" | "advocate"`, mas
`unitTypeToRole`/`deriveNextUnit` (`state/dispatch.ts`) **não mudaram** —
nenhum `NextUnit["type"]` deriva para esses papéis. O invariante é entregue
como **capacidade do router**, provada inteiramente por
`tests/reviewer-independence-e2e.test.ts`: o teste grava autoria sintética
(`family: 'gpt'`) e dispara `resolveModelForRole("reviewer"|"advocate", ...)`
diretamente, sem passar por `deriveNextUnit`. `review/resolve.ts`
(`resolveReview`, a truth table dialética challenger→advocate→rebuttal) segue
portado e testado mas **não despachado** — fica disponível para a slice
futura que decidir portar o review dialético para o loop (adicionando o
unit-type e o mapeamento em `unitTypeToRole`; o filtro instalado aqui já está
pronto para consumi-lo sem mudança). S04 **não** estende `deriveNextUnit` nem
o dispatch table — essa decisão está travada em `S04-PLAN.md §Decisão
estrutural`.

## 9. Rank interno D6 (S05) — tier × capability × custo

Instalado na S05 do milestone `M-20260711031733-multi-llm-roteamento`
preenchendo por dentro o passo **"rankear"** de §3 — nenhuma mudança de
assinatura, nenhum novo seam. Até S04, "rankear" era só a ordem declarada
(pool candidato do papel, depois ref dentro do pool). S05 substitui esse
passo por um **rank puro** (`auto/model-rank.ts rankPool`, T02) composto
sobre uma tabela de dados também pura e fork-side
(`auto/model-capabilities.ts`, T01): tier ordinal, capability score, custo
relativo e a flag flat-rate, por `provider/model-id`. Nenhum dos dois módulos
importa `pi-ai`/`forge-agent-core`; nenhum faz I/O.

**(a) Ordem de composição — o rank entra DEPOIS dos filtros de §3/§8.** Para
cada pool candidato, o filtro adversarial de §8 (se ativo) narrowa o pool
primeiro; o filtro de disponibilidade de §3 narrowa em seguida; só então
`rankPool(eligible, { tierHint, budgetPressure })` escolhe o vencedor dentro
do conjunto já filtrado (família-ok ∩ disponível). `rankPool` **nunca**
re-filtra por família ou disponibilidade — esse invariante de ordem é o que
mantém `reviewer_not_author` (§8) intacto sob rank: a família autora
permanece excluída mesmo sob pressão de budget, porque ela nunca chega ao
conjunto elegível que o rank enxerga.

**(b) A semântica do rank, em 5 passos** (`model-rank.ts rankPool`,
`S05-PLAN §Semântica do rank D6`):

1. **Teto (downgrade-only):** o **primeiro ref do pool** (`eligibleRefs[0]`)
   declara o **tier-teto** — o modelo configurado no topo do pool é o limite
   superior. O rank nunca escolhe um ref de tier acima do teto; `downgrade_only`
   é o único modo em S05 (sem modo "upgrade" — reordenar o pool é como um
   operador muda o teto).
2. **Supressão flat-rate PRIMEIRO:** se o provider do ref-topo é flat-rate
   (assinatura, sem custo marginal por token — ver tabela abaixo), o
   `topRef` vence imediatamente. Hint e budget pressure são ignorados por
   completo — não há custo marginal a otimizar.
3. **Alvo de tier:** começa no teto. Um `tierHint` (hint do planner)
   estritamente ABAIXO do teto rebaixa o alvo; um hint igual/acima do teto é
   no-op (downgrade-only nunca deixa um hint subir o alvo).
4. **Budget pressure:** rebaixa o alvo mais um nível ordinal, sempre travado
   ao menor tier realmente presente no conjunto elegível — nunca inventa um
   tier que não existe no pool, nunca sobe de volta.
5. **Desempate:** entre os refs do tier-alvo elegível mais próximo do alvo
   (por baixo/igual), ordena por `capabilityScore` desc, depois `costRank`
   asc, depois a posição original no pool — determinístico, total.

**(c) Tabela de exemplo** (`MODEL_CAPABILITIES`/`PROVIDER_FLAT_RATE`,
`auto/model-capabilities.ts` — números ILUSTRATIVOS/SINTÉTICOS, não medidos,
declarados só para as 2 famílias fake que este milestone prova a mecânica
com):

| Ref                              | Tier       | Capability | Custo | Provider flat-rate? |
|-----------------------------------|------------|-----------:|------:|----------------------|
| `claude-code/claude-opus-4-8`     | `max`      | 95         | 90    | sim (`claude-code`)  |
| `claude-code/claude-sonnet-5`     | `standard` | 70         | 35    | sim (`claude-code`)  |
| `openai/gpt-5.5`                  | `max`      | 90         | 85    | não (`openai`)       |
| `openai/gpt-5-mini`                | `light`    | 45         | 15    | não (`openai`)       |

Um ref ausente da tabela degrada para um perfil default tolerante (`tier:
standard, capability: 1, cost: 1`) em vez de lançar ou favorecer o
desconhecido como melhor/pior opção.

**(d) O contrato de hint do planner.** O `tier` que `tierHint` carrega é o
mesmo campo de frontmatter que `prompts/plan-slice.ts:154-163` já instrui o
planner a emitir em todo `T##-PLAN.md`:

```yaml
tier:   light | standard | heavy | max     # qual modelo roda a task (opcional; default standard)
effort: low | medium | high | xhigh | max  # quão forte ele raciocina (opcional; default low)
```

Este contrato **já existia** antes de S05 (greenfield de contrato) — S05 é
**consumo** novo dele, não a criação. O leitor puro-por-fora
`tierHintForUnit(cwd, unit)` (`auto/rank-hint.ts`, T03) lê o frontmatter do
`T##-PLAN.md` da unidade sob dispatch (via `splitFrontmatter`/
`parseFrontmatterMap`, `shared/frontmatter.ts` — nenhum parser novo),
resolvido pelo CHAMADOR fora do seam, exatamente como `authorFamilyForSlice`
(§8) — `resolveModelForRole` nunca lê um arquivo de plano por conta própria.
Toda falha (STATE.md ausente, milestone id ausente, plano ausente/ilegível,
sem frontmatter, valor de `tier` inválido) degrada para `undefined`, nunca
lança — `undefined` significa exatamente o que um `tierHint` omitido
significa a jusante: o rank mira o teto declarado do pool (comportamento
S03/S04 preservado byte-a-byte).

**(e) `ResolveModelCtx` widened aditivamente.** `tierHint?: Tier` e
`budgetPressure?: boolean` (`auto/role.ts`) — ambos opcionais; todo call-site
existente (`driver.ts:149` passa só `{ session: s }`) continua
type-checando e produzindo o MESMO resultado de S03/S04 quando ambos estão
ausentes (`rankPool` sem opts sempre devolve `eligibleRefs[0]`, idêntico ao
antigo "primeira ref disponível vence"). Provado byte-a-byte em
`tests/model-rank-e2e.test.ts` (`describe("S05 controle — byte-identidade
com S03 ...")`).

**(f) Follow-ups sintéticos — declarado para não silenciar.** S05 entrega a
*mecânica* de reação aos dois sinais; a *fonte* real de cada sinal fica
fora do escopo desta slice:

- **Instrumentação real de budget** (contagem de tokens/custo acumulado por
  milestone, a origem real do sinal de `budgetPressure`) — S05 injeta o
  sinal como **sintético em `ctx`**, exercido só por teste
  (`model-rank-e2e.test.ts`); a fonte real do sinal é follow-up futuro.
- **Detecção real de provider flat-rate** (introspecção de credencial/plano
  via `AuthStorage`, ver §6) — S05 declara o flag estaticamente por
  provider conhecido em `PROVIDER_FLAT_RATE`; a introspecção dinâmica real
  de plano de credencial é o eixo credencial-real de **S06**.
- **Threading do hint a partir do disco no `driver.ts` real** —
  `tierHintForUnit` (leitor) e o contrato de injeção em `ResolveModelCtx`
  estão prontos e testados, mas `driver.ts:149` continua passando só
  `{ session: s }` (hint omitido ⇒ S03/S04 preservado); ativar o threading
  no dispatch real de produção é integração follow-up — a *capacidade* (o
  leitor + o contrato + o rank que a consome) já está entregue e provada
  sinteticamente em S05, mesma disciplina "prova sintética, caminho real
  documentado" do resto do milestone.

**Atualização — o threading acima foi concluído em milestones posteriores:**
`resolveDispatchAuthor` (`auto/driver.ts`) hoje lê `tierHintForUnit` E
`domainHintForUnit` do disco e os passa ao `ResolveModelCtx` do dispatch real
(sem hint ⇒ `undefined` ⇒ comportamento S03/S04 preservado byte-a-byte, como
antes). Ver §9(g) abaixo para o fator `domain`/capacidade que passou a
compor o mesmo tie-break.

**(g) Fator capability(domain) no tie-break (D-S03-1, milestone
capacidade-esforço).** Instalado na S03 do milestone
`M-20260711233434-capacidade-esforco`, compondo ADITIVAMENTE dentro do MESMO
passo "Desempate" do item (b) acima —
nenhuma mudança de assinatura, nenhum novo seam. Continua sendo o mesmo
`rankPool` de §9; `RankOpts` ganha dois campos opcionais:

```ts
interface RankOpts {
  tierHint?: Tier;
  budgetPressure?: boolean;
  domain?: string;                                       // novo (S03)
  capabilityOf?: (domain: string, ref: string) => number | undefined; // novo (S03)
}
```

- **`domain`** — o hint de frontmatter `domain:` da task sob dispatch
  (`domainHintForUnit`, `auto/rank-hint.ts`), pré-resolvido pelo chamador
  fora do seam, exatamente como `tierHint`.
- **`capabilityOf`** — o lookup puro pré-ligado à matriz `.gsd/CAPABILITIES.md`
  já lida (`(d, r) => capabilityFor(matrix, d, r)`, `auto/capability-matrix.ts`
  — contrato completo em
  [`FORGE2-CAPABILITIES-FORMAT.md`](FORGE2-CAPABILITIES-FORMAT.md)). O rank
  em si nunca lê o filesystem; `auto/role.ts` resolve a matriz uma única vez
  ANTES do walk dos pools, e só quando `ctx.domain` está presente — sem
  domain, zero leitura de `CAPABILITIES.md`.

**Onde o fator entra (D-S03-1):** SOMENTE no desempate entre os finalistas do
mesmo tier-alvo (o passo 5 de §9(b)) — a seleção de tier (passos 1/3/4) e a
supressão flat-rate (passo 2) ficam intocadas, por construção: o fator nunca
vê um ref que já foi descartado por elas. Quando `domain` e `capabilityOf`
estão AMBOS presentes, a chave primária do desempate passa a ser

```
capabilityOf(domain, ref) ?? capabilityScore(ref) / 100     desc
  → costRank(ref)                                            asc
  → posição original no pool                                 asc
```

O `??` implementa o contrato da matriz (S02): um miss do domain/ref na matriz
é "fator AUSENTE para este ref", nunca nota 0 — o ref cai de volta ao seu
`capabilityScore` estático normalizado para a mesma escala `[0,1]`
(`STATIC_CAPABILITY_SCALE = 100`, uma transformação monotônica: a ordem
RELATIVA entre refs não pontuados pela matriz é idêntica à ordem estática
pré-S03). Com `domain` OU `capabilityOf` ausente (qualquer um dos dois), o
desempate roda o comparador EXATO pré-S03 — `capabilityScore` desc → `costRank`
asc → ordem do pool — um branch estrutural, não uma coincidência aritmética:
byte-identidade não depende de nenhum valor específico da matriz.

**As duas armadilhas do fator** (documentadas também no guia do operador,
`OPERATOR-GUIDE.md` §5):

- O tie-break só reordena CO-FINALISTAS do mesmo tier — um score de
  capacidade alto nunca fura o teto (§9(b) passo 1) nem a supressão
  flat-rate (§9(b) passo 2).
- `model` na matriz é exact-match verbatim contra o ref roteado (mesma
  disciplina de `models.md`) — um typo ou diferença de case degrada a um
  miss silencioso, não a um erro ou warn.

`domain` **não** entra no journal nesta composição (deferimento declarado,
D-S03-3) — o observável de auditoria é `unit_dispatched.model` (o ref
vencedor), não o `domain` que o produziu.

## 10. Rank v3 cross-pool por aptidão (S09 cockpit-v2)

Instalado na S09 do milestone `M-20260712170458-cockpit-v2`, **substituindo**
— só quando julgamento roda — a caminhada "primeiro pool com elegível"
(`role.ts:409-430`) descrita em §3 passo 3. Rota (b) do addendum do operador,
TRANCADA em `S09-PLAN.md`. Mesmo seam único (`resolveModelForRole`), nenhuma
mudança de assinatura pública além de campos aditivos.

**(a) A mudança semântica, em uma frase.** Pools deixam de ser "a ordem de
tentativa" e passam a ser **elegibilidade**: a lista de candidatos possíveis.
A matriz de capability (`.gsd/CAPABILITIES.md`) deixa de ser um tie-break de
finalistas dentro de um único pool (§9) e passa a ser **julgamento**: o fator
PRINCIPAL de rank entre a UNIÃO de candidatos de TODOS os pools do papel. A
ordem declarada dos pools/refs só decide quando o julgamento empata dentro da
banda ε — ela é o desempate FINAL, não mais o critério primário.

**(b) Quando o julgamento roda (guard).** Julgamento cross-pool só entra
quando AMBAS as condições valem:

1. A task sob dispatch declara `domain:` no frontmatter (`domainHintForUnit`,
   `auto/rank-hint.ts` — o mesmo leitor de §9(d), best-effort, `undefined`
   nunca lança).
2. A matriz cobre **≥1** candidato da união com uma linha `(domain, ref)` —
   "cobertura" (S09-PLAN decisão 2).

Faltando qualquer uma, `rankUnion` (ou nem é chamado, ou é chamado e devolve
`null`) e o dispatch cai byte-idênticamente na caminhada legada de §3/§9: os
mesmos filtros, a mesma ordem de pools, o **mesmo warn** de pool ausente, e
**nenhuma leitura de `CAPABILITIES.md`** quando falta só a condição 1. Este é
o mesmo guard estrutural que já protege §9(g) — S09 estende o alcance do
fator capability, não sua ativação.

**(c) A mecânica do rank v3, em 4 passos** (`auto/model-rank-union.ts
rankUnion`, `S09-PLAN.md §Decisões de interpretação`):

1. **União:** por pool, os MESMOS filtros de §3/§8 já rodaram (adversarial
   `excludeAuthorFamily`/`onlyAuthorFamily` → disponibilidade
   `isModelAvailable`); a união dos candidatos sobreviventes de todos os
   pools do papel forma o conjunto de contenção — preservando `(poolIndex,
   posIndex)` de cada ref (primeira ocorrência vence se um ref repete entre
   pools).
2. **Score:** cada candidato é pontuado por `capabilityOf(domain, ref)`. Um
   miss da matriz (`undefined`) é "sem-julgamento" — **nunca** cai de volta
   ao `capabilityScore` estático de §9(c) (diferença doutrinária do fator de
   §9(g), que faz esse fallback). Sem-julgamento nunca vence um candidato
   pontuado; ordena-se apenas entre outros sem-julgamento, abaixo de todos os
   pontuados, por ordem declarada.
3. **ε-grupo (ε = 0.05):** o candidato de maior score é o líder. Candidatos
   com `|Δ| ≤ ε` do líder formam o "grupo ε" — o passo de curadoria da
   matriz (0.02–0.05) é a menor diferença que o operador tratou como
   significativa. `|Δ| > ε` é decisivo por score puro, sem desempate.
4. **Desempate dentro do grupo ε:** (i) penalidade de clamp de effort — só
   quando `requestedEffort` E um teto observado (`effortCeilingOf`, journal
   `effort_clamped`) estão AMBOS presentes e o teto observado do candidato
   fica ordinalmente ABAIXO do effort pedido; sem observação nunca inventa
   penalidade — (ii) `costRank` ascendente (mais barato vence) — (iii)
   `(poolIndex, posIndex)` ascendente, a ordem declarada da união — o
   desempate final.

**(d) `tierHint`/`budgetPressure`/flat-rate não re-entram no modo
julgamento** (S09-PLAN decisão 3). Eram heurísticas da era pool-walk
(downgrade dentro do teto de UM pool — um teto que não existe numa união
cross-pool). O eixo custo já entra como fator secundário do passo (c)(4)(ii).
No caminho guard (legado, §9), os três continuam 100% honrados via `rankPool`
intocado — nada muda ali.

**(e) `rank_reason` — a trilha de auditoria.** Campo ADITIVO em
`ResolveResult` e no evento `unit_dispatched` (junto de `domain`, fechando o
gap cosmético do §9(g) final) — string de prosa auditável, NUNCA `""`/`"null"`
(G1). Ausente (chave genuinamente ausente, não vazia) sempre que o caminho
guard/legado rodou — byte-identidade do princípio 5 do addendum vale para o
journal também, não só para o `model` escolhido. Formato:

```
capability:<domain> <ref-vencedor> <score> > <ref-2º> <score> (<motivo do desempate>)
```

O parêntese final só aparece quando um tie-break (não score puro) decidiu —
omitido quando `Δ > ε`. Exemplos reais (produzidos pela suite
`tests/model-rank-union.test.ts` e pelo e2e desta task):

```
capability:infra openai-codex/gpt-5.6-terra 0.90 > claude-code/claude-sonnet-5 0.65
capability:infra claude-code/claude-sonnet-5 0.70 > openai-codex/gpt-5.6-terra 0.68 (cost tie-break)
capability:infra claude-code/claude-sonnet-5 0.70 > openai-codex/gpt-5.6-terra 0.68 (openai-codex/gpt-5.6-terra clamped medium)
capability:infra openai-codex/gpt-5.6-terra 0.90
```

(a última linha é o caso de candidato único pontuado — sem cláusula de
runner-up.)

**(f) Prova através do driver.** `src/resources/extensions/forge/tests/
cross-pool-rank-e2e.test.ts` (S09/T04, template
`authorship-routing-e2e.test.ts`) prova os 3 cenários via `runForgeLoop`
(a mesma `resolveDispatchAuthor` de `auto/driver.ts` que roda no dispatch
real, fake driver só para o turno do worker — nunca uma chamada direta ao
seam): (A) vitória cross-pool — terra (0.90) vence sonnet (0.65) mesmo com
`claude-exec` na frente da ordem de pools; (B) guard sem `domain:` —
resolve como a caminhada legada, sem `rank_reason`/`domain`; (C) guard com
`domain:` mas cobertura zero na matriz — idem (B), byte-identidade do
princípio 5.
