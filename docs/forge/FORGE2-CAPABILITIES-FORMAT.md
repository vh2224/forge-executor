# Forge 2.0 — Formato de `.gsd/CAPABILITIES.md` (matriz de capacidade)

> Superfície de dados **declarada e travada** na S02 do milestone
> `M-20260711233434-capacidade-esforco`. Decisões registradas em
> `S02-PLAN.md §Decisões registradas` (D-S02-1..D-S02-4); parser real em
> `src/resources/extensions/forge/auto/capability-matrix.ts`. Este doc é o
> contrato que a S03 CONSOME (fator capability no rank) e a S04 ESCREVE
> (unidade de research de modelos) — qualquer divergência entre este doc e
> o comportamento do parser é bug do doc, guardada pelo teste de contrato
> `tests/capability-format-doc.test.ts` (parseia o §Exemplo canônico daqui
> com o parser real).

## 1. Onde os arquivos vivem

Cascata de 2 camadas, mesmo eixo de `models.md`/`models.local.md`
(`auto/models-config.ts`), com parser próprio dedicado
(`auto/capability-matrix.ts`):

| Ordem (menor → maior precedência) | Caminho                       | Escopo               |
|------------------------------------|--------------------------------|-----------------------|
| 1                                   | `.gsd/CAPABILITIES.md`         | repo, committed       |
| 2                                   | `.gsd/CAPABILITIES.local.md`   | repo, **gitignored**  |

- O merge é **last-wins por chave `(domain, ref)`**: uma linha definida na
  camada local sobrescreve a mesma chave da camada repo (incluindo
  `locked` e `sources`); chaves que a local não menciona passam intactas.
- Camada ausente/ilegível degrada silenciosamente para "não contribuiu
  nada" — `readCapabilities` **nunca lança**. Sem nenhuma camada, retorna
  matriz vazia (`{ domains: {} }`), que a jusante significa "sem efeito no
  rank" para qualquer lookup.
- A linha file-level `updated:` também é last-wins entre camadas.
- **Convenção gitignore (repos-alvo):** `CAPABILITIES.md` committed,
  `CAPABILITIES.local.md` gitignored — mesma convenção de
  `models.local.md`. NESTE repo (`forge2/forge`) o `.gsd/` inteiro é
  gitignored (estado runtime), então nenhum dos dois é versionado aqui; a
  convenção acima vale para os repos-alvo que o forge gerencia.

## 2. Forma travada (contrato do parser)

O arquivo é Markdown contendo linhas de **pipe-table**, uma linha = uma
entrada da matriz (D-S02-1 — NÃO é bloco YAML fenced; sem dependência YAML
nova, regra de ferro do repo). Ordem de colunas **fixa**:

```
| domain | model | score | locked | sources |
```

- **`domain`** — string aberta, **minúscula por normalização**: lowercased
  no parse E no lookup (D-S02-3). Vocabulário aberto — não há enum de
  domains válidos.
  - **Compatibilidade de vocabulário com os planners:** o vocabulário é
    aberto, mas o lookup em `capabilityFor` é exact-match pós-lowercase
    contra o valor literal que os `T##-PLAN.md` emitem em `domain:` no
    frontmatter — não há tradução nem sinônimo. Use os mesmos rótulos que
    os planners deste repo emitem (ex. `testes`, convenção pt-BR, não
    `testing`); um domain da matriz que não bate byte a byte com o emitido
    pelo planner é um miss silencioso (§3) — sem erro, só sem efeito no
    rank.
- **`model`** — ref `provider/model-id` **verbatim**, match **exato** no
  lookup (D-S02-3; mesma disciplina do models-config, sem normalização
  silenciosa de case). Um ref que não bate simplesmente não contribui
  score.
- **`score`** — número em `[0,1]` **inclusive** (0 e 1 são válidos).
- **`locked`** — truthy quando a célula é `locked`, `true` ou `yes`
  (case-insensitive); vazia ou qualquer outro valor ⇒ `false`. Semântica
  em §4.
- **`sources`** — texto livre, verbatim: URLs + data embutida, ex.
  `https://exemplo.dev/bench (2026-07-11)`. Célula vazia ⇒ campo ausente.
- Colunas além da 5ª são **ignoradas**.
- Linha opcional **file-level**, fora da tabela: `updated: <data>`
  (chave case-insensitive, valor verbatim; a última no arquivo vence).
  Uma célula `updated:` DENTRO de uma pipe-row não é capturada.
- A tabela pode estar dentro de bloco fenced ou não — parseia idêntico
  (as linhas de fence são ignoradas como prosa).

## 3. Tolerância e diagnósticos

O parser é um line-reader tolerante que **nunca lança** e degrada a vazio.
Uma linha só vira entrada quando é pipe-row com ≥ 3 células, domain e ref
não-vazios, e a célula score parseia como número em `[0,1]`.

**Ignorado em silêncio** (não é erro, não warna):

- O header `| domain | model | score |…` e o separador `|---|---|` — a
  célula score deles não é numérica, então caem fora naturalmente, sem
  case especial.
- Prosa, fences, linhas em branco, pipe-rows com < 3 células.
- Célula score não-numérica ou vazia (linha inteira é pulada).

**Warna com `console.warn` nomeado** (diagnóstico aditivo — nunca muda o
valor retornado):

- Score numérico **fora de `[0,1]`** ⇒ linha pulada + warn.
- **Duplicata `(domain, ref)` dentro da MESMA camada** ⇒ last-wins (a
  linha mais abaixo vence) + warn.
- **Ref malformado** (sem exatamente um `/` com lados não-vazios) ⇒ warn,
  mas a entrada é **preservada** — o lookup exact-match nunca vai bater
  nela, então degrada a "sem efeito no rank"; o warn é o diagnóstico.

**NUNCA warna** (D-S02-4, divergência deliberada do `readModelsConfig`):

- **Override cross-layer** (local sobrescrevendo repo). É o caminho de uso
  PROJETADO — curadoria do operador vencendo o researcher; warn em toda
  leitura seria ruído que treina o operador a ignorar warns.

## 4. Curadoria do operador — as duas vias

"Curadoria do operador sempre vence" se realiza por DUAS vias
independentes (D-S02-2):

1. **`locked` por linha (write-time, contrato da S04):** o writer de
   research NUNCA sobrescreve uma linha `locked: true` existente. No
   READER, `locked` **não** altera a precedência da cascata — é parseado,
   sobrevive ao merge e fica consultável (`entry.locked`); quem o honra é
   o writer. Use quando você validou um score à mão e não quer que o
   researcher automático o toque no futuro.
2. **`CAPABILITIES.local.md` (read-time, esta camada):** sobrepõe qualquer
   valor da camada repo na leitura, incondicionalmente (last-wins). Use
   para overrides locais/experimentais que não devem ser versionados, ou
   quando você discorda da matriz committed sem querer editá-la.

As duas compõem: uma linha `locked` na camada local também está protegida
do writer (que só escreve `.gsd/CAPABILITIES.md`, §6) e ainda vence a repo
na leitura.

## 5. Contrato do reader (consumido pela S03)

API em `auto/capability-matrix.ts`, leitura separada de lookup:

- **`readCapabilities(cwd)`** — resolve a cascata de §1 (fs, síncrono,
  nunca lança) e retorna a `CapabilityMatrix` merged.
- **`capabilityFor(matrix, domain, ref)`** — lookup **puro e
  determinístico**: score `number` da célula, ou `undefined` quando o
  domain OU o ref é desconhecido. `undefined` significa exatamente "sem
  efeito no rank". Domain é lowercased antes do lookup; ref é exato.
  Não toca fs, nunca lança.

O call-site da S03 pré-resolve a matriz UMA vez via `readCapabilities` e
injeta o lookup puro no rank — `rankPool` permanece puro e nunca lê o
filesystem.

## 6. Contrato do writer (S04 — unidade research-models)

- Escrever/atualizar **somente** `.gsd/CAPABILITIES.md` — NUNCA a
  `CAPABILITIES.local.md` (aquela é exclusiva do operador).
- **Preservar byte a byte** toda linha existente com `locked` truthy —
  nunca sobrescrever, reordenar ou "corrigir" uma linha locked.
- Toda linha escrita cita **fontes com data** na célula `sources`
  (URL + data, ex. `https://exemplo.dev/bench (2026-07-11)`).
- Manter a ordem de colunas de §2 e atualizar a linha `updated:`
  file-level com a data da escrita.

## 7. Exemplo canônico

O bloco abaixo é um `.gsd/CAPABILITIES.md` completo e realista que um
operador pode copiar verbatim como ponto de partida.

> **Guardado por teste:** este é o PRIMEIRO bloco fenced após este
> heading — `tests/capability-format-doc.test.ts` o extrai do doc no
> disco e o parseia com o `parseCapabilities` real; editar o exemplo sem
> ajustar o teste (ou vice-versa) quebra o gate. Doc e parser não podem
> divergir silenciosamente.

```markdown
updated: 2026-07-12

| domain   | model                         | score | locked | sources                                              |
|----------|-------------------------------|-------|--------|------------------------------------------------------|
| infra    | claude-code/claude-opus-4-8   | 0.95  |        | https://exemplo.dev/bench/opus-infra (2026-07-10)    |
| infra    | openai/gpt-5.5                | 0.85  |        | https://exemplo.dev/bench/gpt55-infra (2026-07-10)   |
| frontend | claude-code/claude-sonnet-5   | 0.8   | locked | curadoria manual do operador (2026-07-11)            |
| frontend | openai/gpt-5.5                | 0.9   |        | https://exemplo.dev/bench/gpt55-fe (2026-07-10)      |
| docs     | claude-code/claude-sonnet-5   | 0.75  |        | https://exemplo.dev/bench/sonnet-docs (2026-07-09)   |
| docs     | openai/gpt-5-mini             | 0.6   |        | https://exemplo.dev/bench/mini-docs (2026-07-09)     |
```

Lendo o exemplo: 3 domains × 2 refs; a linha `frontend ×
claude-code/claude-sonnet-5` está `locked` (o researcher S04 nunca a
sobrescreve — score validado à mão pelo operador); todas as demais citam
fonte com data. `capabilityFor(matrix, "infra",
"claude-code/claude-opus-4-8")` ⇒ `0.95`; um domain fora da tabela (ex.
`"security"`) ⇒ `undefined` ⇒ sem efeito no rank.
