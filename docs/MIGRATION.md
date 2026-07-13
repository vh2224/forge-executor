# Migração forge-agent 1.0 → Forge 2.0

Este guia é para quem já tem um projeto gerido pelo **forge-agent 1.0** (o orquestrador Python
original) e quer adotar o Forge 2.0 nesse mesmo projeto, sem perder o histórico de milestones,
slices, tasks, decisões e memória já acumulado em `.gsd/`.

O comando é `/forge migrate`, rodado dentro do diretório do projeto que tem o `.gsd/` 1.0. Ele
tem dois modos: um dry-run que só classifica e relata (o default, sem escrever nada), e
`--apply`, que converte de fato — sempre atrás de um backup automático. Pré-requisito: o
projeto precisa ter um `.gsd/` no formato do forge-agent 1.0 (STATE.md dashboard auto-gerado
ou frontmatter por milestone, prefs aninhadas, fragments de decisions/memory no formato 1.0).
Um `.gsd/` já 2.0-nativo, ou a ausência de `.gsd/`, não têm nada para converter.

## Dry-run: `/forge migrate`

Rodar `/forge migrate` sem argumentos nunca escreve um byte — é puramente um relatório de
classificação. Ele cobre seis dimensões do `.gsd/` atual:

1. **STATE.md** — o arquivo de topo (`.gsd/STATE.md`) e qualquer `STATE.md` por milestone,
   classificados como ausente, 2.0-nativo (bloco fenced yaml), dashboard 1.0 (auto-gerado) ou
   frontmatter 1.0 (por milestone).
2. **Prefs** — cada camada da cascata de preferências encontrada (repo, `~/.claude` legado,
   etc.), classificada como `flat` (já 2.0), `nested1x` (formato 1.0, com tabela de "Phase →
   Agent Routing" e blocos `skip_discuss:`), vazia, ou de forma desconhecida. Toda camada
   `nested1x` já lista aqui as chaves sem equivalente 2.0 (ver seção "Equivalência de prefs"
   abaixo).
3. **Fragment stores** — `decisions/`, `ledger/` e `memory/`, arquivo por arquivo, marcando
   quais são incompatíveis com os parsers 2.0 reais (e por quê).
4. **Artefatos órfãos** — diretórios de milestone/task que não batem com o formato de id
   esperado (`isValid`/`entityKind`).
5. **Roadmap** — todo `<mid>-ROADMAP.md` que ainda está no formato prosa+checkbox 1.0 (a seção
   `## Slices`), e portanto precisaria de conversão para a tabela pipe que o parser 2.0 lê.

O relatório termina sempre com uma linha explícita confirmando que nenhuma escrita foi
realizada. Use o dry-run quantas vezes quiser antes de decidir aplicar — ele é seguro para
rodar a qualquer momento, inclusive repetidamente.

## Aplicar: `/forge migrate --apply`

`/forge migrate --apply` é o único caminho que efetivamente escreve. A ordem de execução é
fixa e sempre a mesma:

1. **Backup automático primeiro, sempre** — antes de qualquer conversão, se (e somente se)
   algo realmente precisa ser convertido, todo o `.gsd/` é copiado para um diretório-irmão
   (ver "Backup e rollback" abaixo). Se nada precisa de conversão (já 2.0-nativo, ou `.gsd/`
   ausente), nenhum backup é criado e nenhuma das conversões abaixo roda.
2. **STATE.md** — o dashboard 1.0 vira o shell 2.0 (bloco fenced yaml de topo), desde que
   exatamente um milestone 1.0 esteja inequivocamente ativo. Zero ou dois-ou-mais milestones
   ativos simultâneos não são resolvidos automaticamente — o relatório aponta a ambiguidade e
   pede uma resolução manual (escrever o STATE.md 2.0 apontando para o milestone escolhido, e
   rodar `--apply` de novo).
3. **Prefs** — os blocos aninhados 1.0 viram entradas flat 2.0, usando a tabela de
   equivalência (ver abaixo). A camada legada `~/.claude` é redirecionada para dentro do
   `.gsd/` do projeto em vez de sobrescrever o arquivo 1.0 original, que permanece intocado.
4. **Decisions** — fragments 1.0 (campos `when`/`scope`/`choice`/`revisable`, sem id nativo)
   viram fragments 2.0 (`id`/`decision`/`rationale`/`date`), com um id sintetizado e os campos
   sem slot 2.0 preservados no corpo livre — nada é descartado.
5. **Memory** — os dois blocos separados 1.0 (`facts:` + `stats:`) são unidos num único
   fragment 2.0 por `mem_id`.
6. **Units + Roadmap** — a lista de units (`StateDoc.units[]`, slice + task) é derivada primeiro
   a partir do roadmap 1.0 ainda em formato prosa, checkbox por checkbox, cruzado com o
   `status:` de cada `T##-PLAN.md` e a existência de `SUMMARY.md`; só depois disso o
   `<mid>-ROADMAP.md` é reescrito para a tabela pipe 2.0. Essa ordem é deliberada: converter o
   roadmap antes zeraria a leitura de units, porque o parser da forma 1.0 já não encontraria
   mais nada no arquivo reescrito.

O relatório final de `--apply` mostra o que foi de fato escrito em cada uma dessas seis
dimensões (não apenas o que foi detectado, como no dry-run) e sempre fecha com a seção de
backup/rollback.

## Backup e rollback

Sempre que alguma conversão precisa rodar, o `.gsd/` inteiro é copiado, antes de qualquer
escrita, para um diretório-irmão `.gsd-backup-<timestamp>-<pid>-<sufixo aleatório>/` (nunca
aninhado dentro do próprio `.gsd/`). Essa é uma regra dura, sem exceção — nasceu de um
incidente real do forge 1.0 (2026-06-10) em que uma conversão sem backup prévio corrompeu
dados de um projeto.

Se algo der errado depois do `--apply` e você quiser voltar ao estado anterior, a instrução de
rollback é exatamente esta (a mesma que o próprio relatório de `--apply` imprime):

> apague `.gsd/` e renomeie `<backup>` de volta para `.gsd/`

Se nada precisava ser convertido, o relatório diz explicitamente que nenhum backup foi criado
— não há confusão possível entre "não fiz backup porque não havia risco" e "esqueci de fazer
backup".

## Equivalência de prefs

A tabela de equivalência de chaves de prefs 1.0 → 2.0 (`PREFS_KEY_MAP`, em
`migrate/prefs-layout.ts`) mapeia cada chave 1.0 conhecida para seu equivalente flat 2.0 quando
existe um (por exemplo, `models`/`tier_models` → `unit_models`, `ids`/`ids.format` →
`ids.format`).

Quatro chaves 1.0 citadas no roadmap deste milestone **não têm nenhum equivalente 2.0 hoje** e
por isso **sempre geram um WARN explícito** no relatório, nunca um descarte silencioso:

- `review` — o gate de revisão dialética (reviewer × advocate).
- `plan_gate` — o handshake interativo de aprovação de plano.
- `evidence` — as configurações do log de evidências via PostToolUse.
- `milestone_cleanup` — a política de limpeza de artefatos ao fechar um milestone.

(A tabela também lista uma quinta chave sem equivalente direto, `verification`, cujo
sub-campo `command_timeout_ms` é conceitualmente próximo do flat `unit_timeout_ms`, mas o
bloco inteiro não mapeia 1:1 — também sempre WARN, nunca silêncio.)

## Coexistência com o forge 1.0

- O forge 1.0 (Python) continua instalado e totalmente utilizável nos SEUS OUTROS projetos —
  rodar `forge migrate` num projeto não afeta o forge 1.0 nem qualquer outro projeto que ele
  gerencie.
- Migrar o `.gsd/` de um projeto é, na prática, um passo sem volta fácil PARA AQUELE PROJETO: o
  forge 1.0 não foi desenhado para retomar o despacho de unidades contra uma árvore `.gsd/` já
  convertida para 2.0. Depois de rodar `--apply` num projeto, esse projeto passa a ser operado
  pelo Forge 2.0 (`/forge auto` / `/forge next`), não mais pelo orquestrador 1.0.
- Desinstalar o forge 1.0 do seu `~/.claude` está **fora do escopo** desta ferramenta — `forge
  migrate` nunca faz isso nem tenta fazer. Se você quiser continuar usando o forge 1.0 em
  outros projetos, não precisa (e não deve) desinstalar nada.

## Fora de escopo

- **Desinstalar o forge 1.0** do `~/.claude` do usuário. `forge migrate` só escreve dentro do
  `.gsd/` do projeto-alvo; a instalação global do 1.0 nunca é tocada.
- **Migrar `forge-accounts`** (gerenciamento multi-conta). Isso é um milestone futuro separado,
  não parte desta ferramenta de migração de projeto.

## Diagnóstico

Para quem quiser verificar o comportamento real na fonte (em vez de confiar só neste guia), a
suíte de testes de migração roda com:

```bash
node --import ./packages/forge-agent-core/scripts/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/forge/tests/migrate-*.test.ts
```

Esses testes incluem cenários com fixtures reais de projetos forge-agent 1.0, cobrindo dry-run,
`--apply` (com backup) e a retomada de um milestone 1.0 em andamento via `/forge auto` depois
da conversão.
