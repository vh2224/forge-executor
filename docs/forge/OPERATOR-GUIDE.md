# Forge 2.0 — Operator Guide

Manual operacional para iniciar, acompanhar e recuperar o loop Forge 2.0 sem
precisar ler o código. As mensagens da interface são em português; os nomes de
arquivos, subcomandos e estados abaixo são contratos literais.

## 1. Pré-requisitos e visão geral

O Forge opera um milestone descrito no diretório `.gsd/`. O estado durável do
loop é mantido pelo orquestrador: workers não devem editar `STATE.md`, o journal
ou os arquivos de configuração do projeto.

Antes de começar:

1. Execute o binário Forge 2.0 a partir da raiz do projeto.
2. Confirme que `.gsd/STATE.md` existe e contém um milestone ativo. Para um
   snapshot 1.0, rode `/forge migrate` primeiro; só use `--apply` depois de
   revisar o dry-run e o backup informado.
3. Confirme que a configuração de modelos e as credenciais necessárias estão
   disponíveis.
4. Faça uma inspeção com `/forge status`.

O diretório `.gsd/` é runtime e é ignorado pelo Git. A inteligência durável do
produto fica em `docs/forge/`.

## 2. Quick start

No TUI, use:

```text
/forge status
/forge accounts list
/forge models view
/forge next
/forge auto
```

`/forge next` executa uma unidade e retorna; `/forge auto` continua derivando e
despachando unidades até concluir, pausar ou bloquear. Para uma execução em
print/headless, os relatórios vão para stdout. No TUI, eles aparecem como
notificações e cards no transcript.

Uma execução headless concluída define `process.exitCode` como `0`. Uma execução
que termina sem completar (pausa, bloqueio, teto ou falta de progresso) define o
código `3`; o processo ainda drena a saída normalmente. Em um TUI interativo,
pausa não força código não-zero. Isso permite usar o resultado em scripts sem
matar o processo com `process.exit()`.

### Começando um projeto do zero

O quick start acima assume um `.gsd/` já existente (migrado ou herdado). Num
diretório sem `.gsd/`, o primeiro comando é:

```text
/forge init
```

Não há perguntas em cascata — nunca. O comando aplica uma heurística de
manifestos (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) para
semear `PROJECT.md` e cria o esqueleto mínimo, item a item:

- `.gsd/PROJECT.md` — nome/descrição herdados do `package.json` quando presente
  (senão o nome do diretório) e a stack detectada; edite livremente para
  refinar identidade e escopo do projeto.
- `.gsd/STATE.md` — estado vazio-válido (`milestone: ''`); é o loop que grava
  aqui, não edite à mão.
- `.gsd/prefs.md` — template 100% comentado de overrides (modelo/timeout por
  unidade); descomente e ajuste as linhas que fizerem sentido.
- `.gsd/models.md` — template 100% comentado do role×pool; veja a §5 para o
  formato e `/forge models` para editar sem abrir o arquivo.
- `.gsd/ledger/`, `.gsd/decisions/`, `.gsd/memory/` — diretórios vazios do
  fragment-store (com `.gitkeep`); o loop os popula conforme milestones
  avançam.

Rodar `/forge init` de novo num diretório que já tem `.gsd/` vira
**doctor-lite**: um relatório read-only (✓ existe / ✗ falta, item a item),
zero escrita. Para criar somente o que falta — sem nunca reescrever o que já
existe — use:

```text
/forge init --repair
```

A garantia de não-sobrescrita é estrutural (a escrita usa a flag `wx` do
sistema de arquivos), não uma checagem por convenção: mesmo `--repair` nunca
toca um item que já existe, ainda que seu conteúdo tenha sido editado à mão.

Por padrão `.gsd/` fica fora do `.gitignore` — é para ser commitado no repo
do projeto-usuário (é o estado durável do loop, não um cache local). Quando
isso não se aplica ao projeto, `--gitignore` adiciona a entrada `.gsd/` (é
idempotente — chamadas repetidas não duplicam a linha):

```text
/forge init --gitignore
```

Depois do bootstrap, o próximo passo é do operador: editar `.gsd/PROJECT.md`
com a identidade real do projeto, configurar `.gsd/models.md` (§5) com os
pools/roles disponíveis e criar a primeira milestone.

## 3. Comandos `/forge`

| Comando | Uso |
| --- | --- |
| `/forge status` | Mostra o snapshot operacional derivado de `.gsd/STATE.md`. |
| `/forge help` | Mostra os subcomandos disponíveis. |
| `/forge init` | Cria o esqueleto `.gsd/` num projeto novo; com `.gsd/` existente vira doctor-lite (`--repair`, `--gitignore`). |
| `/forge next` | Executa somente a próxima unidade. |
| `/forge auto` | Executa o loop até uma condição terminal. |
| `/forge review <alvo>` | Executa o review dialético sob demanda. |
| `/forge accounts list` | Lista contas por provider, sem segredos. |
| `/forge accounts add <provider>` | Inicia login OAuth nativo, quando suportado. |
| `/forge accounts remove <provider> <index>` | Remove uma conta após confirmação. |
| `/forge models view` | Exibe pools, roles e constraints mesclados. |
| `/forge models set ...` | Salva uma alteração na camada local. |
| `/forge unblock <S##\|S##/T##>` | Limpa uma unidade `blocked` ou `partial` para novo dispatch. |
| `/forge migrate` | Inspeciona uma migração; `--apply` aplica a migração prevista. |
| `/forge research-models` | Pesquisa forças atuais dos modelos roteados e atualiza `.gsd/CAPABILITIES.md`. |

Exemplo de recuperação:

```text
/forge status
/forge unblock S02/T01
/forge next
```

`unblock` só atua se a entrada correspondente no `STATE.md` estiver `blocked`
ou `partial`. Ele registra um evento `unit_unblocked` e remove a entrada da lista
de unidades; o próximo `/forge auto` ou `/forge next` pode então despachá-la.

### TUI, print e headless

No TUI, `ctx.ui.notify` renderiza notificações persistentes ou temporárias. Em
print/headless, os comandos que produzem relatório escrevem em stdout. Se uma
mensagem não aparecer no TUI, confira também o transcript e o journal; não
confunda ausência de stdout com ausência de execução.

A paleta mostra somente comandos essenciais por padrão. Para recuperar comandos
avançados e extensões, configure `advanced_commands: true` na cascata de
preferências Forge. O dispatch direto de um comando continua sendo uma questão
distinta da sua presença no autocomplete.

#### Doutrina anti-`--print` aninhado

Forge-dentro-de-forge **NUNCA via `--print` em background**: jamais lance o
binário (`gsd`/`forge`) em modo `--print`/`-p` como job em background (`&`,
`nohup`, tool bash com `run_in_background`, etc.) de dentro de uma sessão forge
ou de um assistente. Isso cria um job opaco, com zero visibilidade — sem strip,
sem painel, sem journal acompanhável, sem forma de interromper.

Registro do incidente 2026-07-12: o assistente lançou um forge aninhado via
`--print` em background dentro de uma sessão forge já em curso; o resultado foi
exatamente essa opacidade — nenhuma saída acompanhável, nenhum painel, nenhum
journal legível, e nenhuma forma de intervir ou interromper o job até ele
terminar sozinho. O incidente 2026-07-12 é a referência canônica desta
doutrina: qualquer dispatch futuro que se pareça com o padrão abaixo deve ser
recusado.

Anti-padrão concreto (NÃO fazer):

```text
gsd --print "/forge auto" &
nohup gsd -p "/forge next" &
```

O mesmo vale para uma tool call de bash do assistente com
`run_in_background: true` disparando um `gsd`/`forge` aninhado — o mecanismo
(shell `&`, `nohup` ou flag de tool) é irrelevante; o que importa é: modo
`--print`/headless + background + processo forge aninhado.

Caminhos legítimos:

- Dentro da sessão TUI corrente: rodar `/forge auto` ou `/forge next`
  diretamente, sem sair para um processo aninhado.
- Headless deliberado: uma decisão explícita do operador humano, executada em
  **foreground**, com stdout visível — nunca como job em background disparado
  de dentro de uma sessão já em curso.

## 4. Contas e credenciais

Liste o estado redigido:

```text
/forge accounts list
```

A saída mostra provider, índice, um rótulo não secreto e um estado como `pronto`,
`cooldown` ou `backoff`. Nunca mostra token, chave, código OAuth ou conteúdo de
`auth.json`. `cooldown` significa que uma identidade individual está temporariamente
indisponível; `backoff` indica espera aplicada ao provider inteiro. O tempo
restante pode ser exibido em milissegundos.

Para adicionar uma conta:

```text
/forge accounts add anthropic
```

O comando usa os callbacks OAuth nativos do provider: URL/código, prompts e
confirmações aparecem na UI. Apenas providers expostos por `getOAuthProviders()`
podem usar esse fluxo. Providers `externalCli` ou baseados em ambiente podem ser
listados e usados quando prontos, mas não ganham uma conta via este comando.

Para remover uma conta, use o índice exibido na listagem (essa operação pede
confirmação na UI):

```text
/forge accounts remove anthropic 1
```

A operação preserva as demais contas, grava a alteração atomicamente e recarrega
o armazenamento. Faça adição/remoção no TUI, não edite `auth.json` manualmente
como caminho recomendado e nunca copie seu conteúdo para logs, tickets ou prompts.

A rotação é por identidade estável, não por posição: uma conta em cooldown não
deve esfriar outras contas do mesmo provider. Headroom proativo de contas não é
uma promessa do Forge atual; o operador pode adicionar uma conta antes de uma
nova execução, mas o sistema não garante reserva preventiva.

## 5. Modelos e roteamento

### 5.0 O modelo mental — dois arquivos, dois papéis

O roteamento é governado por DUAS superfícies distintas. Confundi-las é o erro
mais comum:

| Superfície | Arquivo | Papel | Quem escreve |
|---|---|---|---|
| **Cerca** (`/forge models`) | `.gsd/models.md` + `.gsd/models.local.md` | Elegibilidade: *quem pode concorrer* por papel | Só o operador |
| **Julgamento** (`/forge research-models`) | `.gsd/CAPABILITIES.md` | Aptidão: *quem vence*, por domínio, com score e fonte | Pesquisa automática **+** curadoria do operador |

Analogia: `models.md` é o edital do concurso; `CAPABILITIES.md` é o currículo
dos candidatos; `locked` é a anotação do operador na margem que nenhuma
pesquisa apaga.

### 5.0.1 Qual arquivo eu edito? — guia de decisão

Comece pelo que você QUER, não pelo arquivo:

| Quero… | Edito | Efeito |
|---|---|---|
| Mudar quem pode executar/planejar/revisar, para o projeto todo | `.gsd/models.md` | Vai no PR; vale para todo clone |
| Testar um modelo só na MINHA máquina (ex.: Sol no pool por um dia) | `.gsd/models.local.md` | Gitignored; sobrescreve a repo só aqui |
| Corrigir o julgamento de aptidão ("Terra é melhor em infra do que a pesquisa acha") | `.gsd/CAPABILITIES.md` — ajusta score + `locked` + fonte | Permanente; a pesquisa nunca sobrescreve |
| Deixar a pesquisa reavaliar um modelo que eu tinha travado | remover o `locked` da linha → `/forge research-models` | A próxima rodada atualiza com evidência nova |
| Mudar comportamento do loop (timeout de unidade, rounds de review) | `.gsd/prefs.md` (projeto) ou `.gsd/prefs.local.md` (pessoal) | Flat `chave: valor`; local vence |
| Preferência minha em TODOS os projetos | `~/.forge/prefs.md` (camada user) | Abaixo do repo na cascata |

**Regra de bolso da camada:** *se você colocaria num PR para o time, é o
arquivo repo; se é experimento, gosto pessoal ou segredo, é o `.local`.* Na
dúvida, comece no `.local` — promover depois é copiar a linha para o repo.

### 5.0.2 Mapa completo das superfícies de config

Para eliminar o obscuro — TODA superfície que influencia um dispatch, com
suas camadas (precedência: de cima para baixo, último vence):

| Superfície | Camadas (ordem de precedência crescente) | Governa |
|---|---|---|
| **Prefs** | `~/.claude/forge-agent-prefs.md` (legacy 1.0) → `~/.forge/prefs.md` (user) → `.gsd/prefs.md` (repo) → `.gsd/prefs.local.md` (local) | Comportamento do loop: `unit_timeout_ms`, rounds de review, modelos por unidade (legado pré-role×pool) |
| **Cerca** | `.gsd/models.md` (repo) → `.gsd/models.local.md` (local) | Pools, papéis, constraints (`reviewer_not_author`, `on_missing_pool`) |
| **Julgamento** | `.gsd/CAPABILITIES.md` (linhas `locked` = curadoria imutável; demais = pesquisa atualiza) | Score por domínio×modelo, com fontes datadas |
| **Credenciais/modelos custom** | `~/.forge/agent/auth.json` + `~/.forge/agent/models.json` | Logins de provider e modelos fora do catálogo — **nunca commitar, nunca em `.gsd/`** |
| **Por task** (emitido pelo planner, não editado à mão) | frontmatter do `T##-PLAN.md`: `domain:`, `effort:` | O que a task é e quanta profundidade pede — corrigível editando o plano ANTES do execute |

Sinal de sanidade: `/forge status` mostra quantas camadas de prefs foram
encontradas; `/forge models view` mostra a cerca JÁ mesclada (repo+local).

**Como editar a cerca:**
- Compartilhada (commitável): edite `.gsd/models.md`, ou
  `/forge models set roles executor "claude-exec, gpt"`.
- Só na sua máquina (gitignored, prevalece sobre a repo): edite
  `.gsd/models.local.md`. Override entre camadas é o mecanismo, não erro —
  merge silencioso, last-wins.

**Como editar o julgamento:**
- Refresh automático: `/forge research-models` — pesquisa na web e atualiza
  APENAS linhas sem `locked`. Re-invocável quando saem modelos novos.
- Curadoria permanente: edite `.gsd/CAPABILITIES.md` diretamente — ajuste o
  `score` e escreva `locked` na 4ª coluna; cite a fonte (posts do X, bench da
  comunidade, evidência interna) com data. Linha `locked` nunca é sobrescrita
  pelo writer. Formato completo: `FORGE2-CAPABILITIES-FORMAT.md`.

**Eixos independentes por task:** o planner emite `domain:` (o que a task é)
e `effort:` (profundidade de raciocínio) no frontmatter de cada T##-PLAN. O
rank escolhe QUEM pelo domínio; o effort viaja com a task — o vencedor roda
no effort pedido, e um clamp do host é registrado no journal
(`effort_clamped`), nunca silencioso.

> Semântica de decisão (a partir do S09 do M-20260712170458): candidatos =
> união dos pools do papel; capability(domain) é o fator PRINCIPAL; custo
> desempata entre scores próximos; ordem declarada é o último desempate; sem
> `domain:`/matriz, vale a caminhada de pools clássica descrita abaixo.
> Referência profunda: `FORGE2-ROUTING-CONFIG.md`.

Veja a configuração efetiva:

```text
/forge models view
```

A configuração baseline vive em `.gsd/models.md`. Alterações pelo comando são
salvas em `.gsd/models.local.md`; a camada local prevalece na leitura e o
baseline não é mutado. O formato tem três áreas:

- `pools`: listas ordenadas de referências `provider/model`;
- `roles`: cada papel aponta para pools candidatos em ordem;
- `constraints`: regras como comportamento quando nenhum pool está disponível.

Exemplos seguros (sem credenciais):

```text
/forge models set pools primary anthropic/claude-sonnet-4-6,openai/gpt-5
/forge models set roles executor primary
/forge models set constraints on_missing_pool degrade+warn
```

O roteador resolve o papel e o pool a cada dispatch, filtra referências sem
credencial/prontidão e segue a ordem declarada. O modelo efetivo aparece no
card `▶` e na evidência do journal quando conhecido. Não presuma que o modelo da
sessão interativa será usado por toda unidade.

O papel `reviewer` deve resolver para uma família diferente da família autora;
o roteamento fail-closed impede revisar com a mesma família. O `advocate` é
resolvido separadamente. Um review read-only não recebe autorização para editar
arquivos ou escrever o artefato: o orquestrador grava o resultado. Se não houver
família elegível, o review produz um resultado conservador/stub e não deve ser
tratado como aprovação forte.

Para trocar o LLM da sessão, use o comando canônico do harness:

```text
/model
```

Para trocar apenas o backend de busca web, use:

```text
/web-search-provider
```

`/search-provider` permanece como alias de compatibilidade. Não use o comando
de busca para trocar o LLM.

### Esforço (`effort_*`)

Além de QUEM roteia (pools/roles acima), o Forge decide COM QUANTA FORÇA cada
unidade raciocina — o eixo esforço. A configuração vive em `.gsd/prefs.md` (a
mesma cascata de 4 camadas de preferências: legado `~/.claude`, usuário
(`gsdHome()/prefs.md`), repo `.gsd/prefs.md`, repo local
`.gsd/prefs.local.md` — a camada mais específica vence). As chaves são
**FLAT**, uma por papel, nunca um bloco aninhado sob `models:`:

```text
effort_planner: high
effort_executor: medium
effort_completer: low
effort_max: xhigh
```

O vocabulário tem 5 níveis, do mais fraco ao mais forte:
`low | medium | high | xhigh | max`. `effort_max` é um TETO global opcional:
quando o nível escolhido para uma unidade fica acima dele, o Forge rebaixa
para o teto (nunca sobe). `effort_planner`/`effort_executor`/`effort_completer`
têm efeito hoje; `effort_reviewer`/`effort_advocate` são aceitos de forma
prospectiva (essas roles ainda não têm entrada de dispatch própria no loop).

Precedência de resolução, da mais específica para a mais genérica:

1. `effort:` no frontmatter do `T##-PLAN.md` da task sob dispatch;
2. `effort_<role>` da cascata de prefs acima;
3. ausente — nenhum eixo de esforço é aplicado (caminho sem configuração,
   byte-idêntico ao comportamento anterior a este eixo).

O journal registra dois pares de campos, um por evento, que NÃO são a mesma
coisa:

- `unit_dispatched.effort` / `effort_reason` — o nível **resolvido** antes do
  despacho (e o motivo: `task-frontmatter`, `role-default:<role>`, ou o mesmo
  sufixado com `; capped <de>→<para> by effort_max` quando o teto rebaixou).
- `unit_result.effort` / `effort_clamped` — o nível **aplicado** de fato pelo
  host via `setThinkingLevel`, só presente quando a aplicação realmente
  ocorreu (token-gated: a unidade que recebeu o nível é a mesma cujo
  resultado voltou). `effort_clamped` só aparece quando o PRÓPRIO modelo não
  suporta o nível pedido e o host rebaixou de novo (clamp por capacidade do
  modelo, ortogonal ao teto `effort_max`) — formato `"<pedido>→<efetivo>"`.

Nenhuma chave `effort_*` configurada e nenhum `effort:` de frontmatter ⇒
nenhum dos dois pares aparece no journal — o caminho sem config permanece
byte-idêntico ao Forge sem o eixo esforço.

### Domain, capacidade e curadoria (`CAPABILITIES.md`)

O Forge também roteia por qual modelo é **melhor no domínio da task agora**,
via uma matriz de capacidade `domain × ref → score`. Duas fontes de `domain`
existem, com propósitos diferentes:

- **`domain:` no frontmatter da própria task** (`T##-PLAN.md`) — é o único
  `domain` que entra no rank. Vocabulário aberto, minúsculo (ex.: `backend`,
  `frontend`, `infra`, `docs`); não há lista de valores válidos — um domain
  desconhecido simplesmente não bate em nenhuma linha da matriz e não tem
  efeito nenhum sobre o ranking.
- **`domain:` de escopo maior**, no `CONTEXT.md`/`ROADMAP.md` da slice ou do
  milestone — informa os PROMPTS dos julgadores (reviewer/advocate, linha
  `DOMAIN:` composta no prompt), nunca o rank. É contexto para quem lê e
  julga, não um sinal de roteamento.

A matriz vive em `.gsd/CAPABILITIES.md` (repo, committed) com uma segunda
camada opcional `.gsd/CAPABILITIES.local.md` (repo, gitignored, last-wins por
chave `(domain, ref)`) — mesmo eixo de cascata do `models.md`/`models.local.md`.
Formato completo, exemplo canônico e contrato do parser:
[`FORGE2-CAPABILITIES-FORMAT.md`](FORGE2-CAPABILITIES-FORMAT.md).

A curadoria do operador SEMPRE vence, por duas vias independentes e
combináveis:

1. **Linha `locked`** em `.gsd/CAPABILITIES.md` — o writer de
   `research-models` nunca sobrescreve uma linha marcada `locked`/`true`/`yes`
   (case-insensitive), byte a byte.
2. **`.gsd/CAPABILITIES.local.md`** — sobrepõe incondicionalmente qualquer
   valor da camada repo na leitura, mesmo sem estar `locked`.

Duas armadilhas reais a evitar:

- **O tie-break só reordena co-finalistas do mesmo tier.** Um score de
  capacidade alto NUNCA faz um modelo furar o teto de tier do pool nem a
  supressão flat-rate — o fator capacidade só decide ENTRE os refs que já
  empataram no tier-alvo. Não espere que uma nota 1.0 num domain promova um
  modelo `light` acima do teto `standard`/`max` do pool.
- **Refs são exact-match verbatim.** `model` na matriz precisa bater
  caractere a caractere com o `provider/model-id` roteado (mesma disciplina
  do `models.md`). Um typo ou diferença de maiúscula/minúscula não gera erro
  nem warn no lookup — a linha simplesmente não contribui, um miss
  silencioso.

### `/forge research-models`

Dispara um worker dedicado que julga as forças ATUAIS dos modelos
efetivamente roteados (via benchmarks/avaliações/notas de release, quando há
ferramentas de busca disponíveis; do próprio conhecimento, com proveniência
declarada, quando não há) e escreve/atualiza `.gsd/CAPABILITIES.md` — nunca a
camada `.local.md`, que é exclusiva do operador.

Invoque no início de um milestone novo (para popular a matriz antes das
primeiras tasks) ou sob demanda, quando a rotação de modelos disponíveis
mudar. Pontos importantes:

- Respeita linhas `locked: true` byte a byte — nunca as sobrescreve.
- É repo-level: não depende de milestone ativo e não aparece em
  `deriveNextUnit` — **nunca é auto-despachado** pelo `/forge auto`; a única
  forma de rodá-lo é este comando explícito.
- Sem `.gsd/models.md` e sem `.gsd/CAPABILITIES.md` existente, não há refs
  para julgar: o comando reporta `blocked` pedindo para configurar pools via
  `/forge models`, em vez de inventar refs que nunca vão bater em nada.

Veja também a configuração de roteamento por capacidade em
[`FORGE2-ROUTING-CONFIG.md`](FORGE2-ROUTING-CONFIG.md) §9.

## 6. Unidade, tools e review

O loop segue o ciclo: ler snapshot, derivar unidade, compor prompt, despachar,
receber resultado, registrar evidência e aplicar o estado. Cada worker deve
chegar ao commit point `forge_unit_result`; no caminho `claude-code`/SDK o nome
namespaceado é `mcp__forge__forge_unit_result`.

O resultado estruturado tem três estados operacionais principais:

- `done`: unidade concluída e apta a avançar;
- `partial`: trabalho incompleto que exige decisão/ação humana antes de retomar;
- `blocked`: não é seguro ou possível prosseguir sem resolver o bloqueio.

Timeout, teto de iterações e falta de progresso também são terminais do loop,
mas não equivalem a sucesso. Em caso de dúvida, leia o evento e o `reason` antes
de tentar novamente.

As tools dependem do tipo de unidade. Em particular, workers de review são
read-only por contrato: eles analisam o diff e respondem ao desafio/defesa, mas
não devem alterar código, STATE, journal ou o artefato final.

### Review dialético

Ao fechar uma slice, o loop materializa o review antes de completar a slice. O
fluxo escolhe challenger de outra família, coleta a defesa do advocate, faz a
réplica limitada e registra resoluções, concessões e itens abertos. O artefato é
`S##-REVIEW.md` dentro do milestone. Reviews de task são gravados junto da task.

Para rodar sob demanda:

```text
/forge review S03
/forge review auth-flow
```

A saída informa o caminho `docs/forge/<alvo>-REVIEW-<família>.md`. Itens `open`
são sinalizados para decisão humana; a revisão é best-effort e não deve ser
interpretada como autorização para ignorar um bloqueio do worker.

## 7. Observabilidade

### Status e STATE

`/forge status` é o painel recomendado: ele usa o mesmo snapshot que alimenta
o loop, em vez de apenas despejar YAML. O arquivo `.gsd/STATE.md` é a fonte
durável de milestone, unidades, status e próxima ação. Não o edite durante uma
execução; somente o orquestrador faz as mutações de estado.

```bash
sed -n '1,220p' .gsd/STATE.md
```

### Journal JSONL

O journal append-only está em `.gsd/forge/events.jsonl`. Cada linha é um evento
JSON independente; use-o para confirmar ordem, modelo, status e motivo:

```bash
tail -n 40 .gsd/forge/events.jsonl
node -e 'const fs=require("fs"); for (const l of fs.readFileSync(".gsd/forge/events.jsonl","utf8").trim().split("\n")) { if (l) console.log(JSON.stringify(JSON.parse(l), null, 2)); }'
```

Leia, filtre e copie evidências; não reescreva, compacte ou edite o journal.
Eventos `unit_dispatched`, `unit_result`, `unit_unblocked`, `review` e os
marcadores de pausa ajudam a distinguir dispatch real de uma tentativa.

### Transcript, cards e pulse

No transcript interativo, cada fronteira aparece como card:

```text
▶ S01/T01 · execute-task · <modelo>
✓ S01/T01 · done · <elapsed>ms
```

Prosa do worker permanece na ordem original. Ferramentas bem-sucedidas
consecutivas podem ser agrupadas por fase; erros e resumos concluídos são
fronteiras e não devem desaparecer no rollup. Em turnos longos sem saída, o
pulse informa há quanto tempo o trabalho está ativo e quantos shells continuam
rodando; ele não altera o estado do loop.

Uma pausa visível é persistente:

```text
⏸ PAUSADO (motivo) — retome com /forge auto
```

O pulse e os cards são observabilidade, não prova de `done`; confirme sempre o
`forge_unit_result` e o evento correspondente.

## 8. Troubleshooting

### “Nenhuma credencial” ou provider em cooldown

Rode `/forge accounts list`. Aguarde o cooldown/backoff ou adicione outra conta
OAuth suportada. Verifique se o provider externalCli realmente está disponível
no ambiente (PATH/login); ele não é resolvido como uma conta OAuth nativa.

### Refresh OAuth falhou com `fetch failed`

Não conclua que o processo ficou inutilizado. O refresh transitório é refeito no
turno seguinte, até o limite de três tentativas do episódio. Verifique rede,
aguarde um turno e tente `/forge next`; se a credencial continuar inválida, use
`/login <provider>` ou o fluxo de accounts. Credencial ausente continua sendo
bloqueio terminal.

### “Model not found <id>”

Prefira a referência qualificada `provider/id` no pool. O resolver pode
re-resolver um id nu quando ele é único; se houver ambiguidade, qualifique-o e
confirme com `/forge models view`. Não invente um id baseado somente no nome
exibido pela UI.

### Loop pausou ou ficou blocked/partial

Leia a razão no card e no último `unit_result` do journal. Corrija a causa sem
apagar evidência; depois use o índice correto:

```text
/forge status
/forge unblock S01/T02
/forge auto
```

Só use `unblock` quando a unidade estiver realmente pronta para novo dispatch.
Um `blocked` por dependência, schema ou credencial não deve ser mascarado.

### Skill Forge/ GSD 1.0 apareceu na paleta

Por padrão, skills `forge-*`/`gsd-*` provenientes dos diretórios de skills do
Claude são sombreadas pelo fork-side. Não patchar `packages/pi-*` e não importar
a extensão 1.0 condenada. Se o problema persistir, confirme o diretório de
origem da skill e se o binário foi recompilado; `advanced_commands` controla
comandos avançados, não deve reativar skills vazadas.

### `/provider` e busca web confundiram-se

Para o LLM, use `/model`. Para busca web, use `/web-search-provider`; o alias
`/search-provider` existe apenas por compatibilidade. Reabra a ajuda se a paleta
estiver com comandos avançados desatualizados.

### Smoke binary ausente ou zombies pós-terminate

A suíte smoke precisa de `GSD_SMOKE_BINARY`; sem essa variável, o smoke pode ser
pulada e isso não prova falha do loop. Há também três zombies conhecidos no
baseline de fake-driver após terminate. Eles são uma limitação de infraestrutura
registrada: não atribua automaticamente esse sintoma a uma regressão do
operador e não apague `.gsd` para “limpar” a evidência.

## 9. Referências de implementação e contratos

Estas referências são para diagnóstico, não para operação cotidiana ou edição:

- [Roteador e help de `/forge`](../../src/resources/extensions/forge/commands/forge-command.ts)
- [Contas e redaction](../../src/resources/extensions/forge/commands/accounts-command.ts)
- [Modelos e camada local](../../src/resources/extensions/forge/commands/models-command.ts)
- [Estado e journal append-only](../../src/resources/extensions/forge/state/store.ts)
- [Retry de sessão OAuth](../../packages/forge-agent-core/src/session/agent-session-prompt.ts)
- [Cards e banner persistente](../../packages/forge-agent-modes/src/modes/interactive/interactive-notify-render.ts)
- [Review dialético](../../src/resources/extensions/forge/review/dispatch.ts)
- [Registro dos incidentes](./M51-REVIEW-CLAUDE.md)

Os contratos de execução e caveats também estão nos summaries de
[S03](../../.gsd/milestones/M-20260711195610-cockpit/slices/S03/S03-SUMMARY.md),
[S04](../../.gsd/milestones/M-20260711195610-cockpit/slices/S04/S04-SUMMARY.md),
[S05](../../.gsd/milestones/M-20260711195610-cockpit/slices/S05/S05-SUMMARY.md),
[S06](../../.gsd/milestones/M-20260711195610-cockpit/slices/S06/S06-SUMMARY.md) e
[S07](../../.gsd/milestones/M-20260711195610-cockpit/slices/S07/S07-SUMMARY.md).

## 10. Segurança, escopo e limites

- Nunca exponha tokens, chaves, códigos OAuth, `auth.json` ou dumps de ambiente.
- Não edite manualmente `auth.json`, `models.md`, `STATE.md` ou `events.jsonl`
  como operação normal; use os comandos e o loop.
- Não patchar pacotes vendorizados `packages/pi-*`; correções fork-side ficam
  nos pacotes Forge ou nas extensões apropriadas.
- Não use `git push` enquanto o remote/publicação (Q1) não estiver decidido.
- Forge-dentro-de-forge nunca via `--print` em background — ver a Doutrina
  anti-`--print` aninhado no §3 (TUI, print e headless).
- O roteamento por capacidade do M7 (hints de domínio, matriz de capacidade e
  rank v2) está fora deste slice.
- OAuth xAI por assinatura está fora do escopo atual.
- Cleanup completo dos zombies pós-terminate está fora deste slice; o baseline
  conhecido deve ser preservado para diagnóstico.
- Q1 (nome e publicação do projeto) depende do operador e não é decidido por
  este manual.

Quando uma ação não estiver coberta aqui, preserve o estado e as evidências,
consulte `docs/forge/` e prefira uma execução única com `/forge next` antes de
retomar `/forge auto`.
