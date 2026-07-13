import { GSD_WEBSITE } from './logo.js'

function writeHelpHeader(version: string): void {
  process.stdout.write(`Forge v${version}\n`)
  process.stdout.write(`${GSD_WEBSITE}\n\n`)
}

const SUBCOMMAND_HELP: Record<string, string> = {
  config: [
    'Usage: forge config',
    '',
    'Re-run the interactive setup wizard to configure:',
    '  - LLM provider (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, etc.)',
    '  - Web search provider (Brave, Tavily, built-in)',
    '  - Remote questions (Discord, Slack, Telegram)',
    '  - Tool API keys (Context7, Jina, Groq)',
    '',
    'All steps are skippable and can be changed later with /login or /search-provider.',
    '',
    'For detailed provider setup instructions (OpenRouter, Ollama, LM Studio, vLLM,',
    'and other OpenAI-compatible endpoints), see docs/providers.md.',
  ].join('\n'),

  update: [
    'Usage: forge update [browser]',
    '',
    'Update Forge to the latest version, or update browser automation only.',
    '',
    'Examples:',
    '  forge update',
    '  forge update browser',
  ].join('\n'),

  upgrade: [
    'Usage: forge upgrade [browser]',
    '',
    'Alias for update. Upgrade Forge, or upgrade browser automation only.',
    '',
    'Examples:',
    '  forge upgrade',
    '  forge upgrade browser',
  ].join('\n'),

  sessions: [
    'Usage: forge sessions',
    '',
    'List all saved sessions for the current directory and interactively',
    'pick one to resume. Shows date, message count, and a preview of the',
    'first message for each session.',
    '',
    'Sessions are stored per-directory, so you only see sessions that were',
    'started from the current working directory.',
    '',
    'Compare with --continue (-c) which always resumes the most recent session.',
  ].join('\n'),

  install: [
    'Usage: forge install <source> [-l, --local]',
    '',
    'Install a package/extension source and run post-install validation (dependency checks, setup).',
    '',
    'Examples:',
    '  forge install npm:@foo/bar',
    '  forge install git:github.com/user/repo',
    '  forge install https://github.com/user/repo',
    '  forge install ./local/path',
  ].join('\n'),

  remove: [
    'Usage: forge remove <source> [-l, --local]',
    '',
    'Remove an installed package source and its settings entry.',
  ].join('\n'),

  list: [
    'Usage: forge list',
    '',
    'List installed package sources from user and project settings.',
  ].join('\n'),

  worktree: [
    'Usage: forge worktree <command> [args]',
    '',
    'Manage isolated git worktrees for parallel work streams.',
    '',
    'Commands:',
    '  list                 List worktrees with status (files changed, commits, dirty)',
    '  merge [name]         Squash-merge a worktree into main and clean up',
    '  clean                Remove all worktrees that have been merged or are empty',
    '  remove <name>        Remove a worktree (--force to remove with unmerged changes)',
    '',
    'The -w flag creates/resumes worktrees for interactive sessions:',
    '  forge -w               Auto-name a new worktree, or resume the only active one',
    '  forge -w my-feature    Create or resume a named worktree',
    '',
    'Lifecycle:',
    '  1. forge -w             Create worktree, start session inside it',
    '  2. (work normally)    All changes happen on the worktree branch',
    '  3. Ctrl+C             Exit — dirty work is auto-committed',
    '  4. forge -w             Resume where you left off',
    '  5. forge worktree merge Squash-merge into main when done',
    '',
    'Examples:',
    '  forge -w                              Start in a new auto-named worktree',
    '  forge -w auth-refactor                Create/resume "auth-refactor" worktree',
    '  forge worktree list                   See all worktrees and their status',
    '  forge worktree merge auth-refactor    Merge and clean up',
    '  forge worktree clean                  Remove all merged/empty worktrees',
    '  forge worktree remove old-branch      Remove a specific worktree',
    '  forge worktree remove old-branch --force  Remove even with unmerged changes',
  ].join('\n'),

  graph: [
    'Usage: forge graph <subcommand> [options]',
    '',
    'Manage the Forge project knowledge graph. Reads .gsd/ artifacts and builds',
    'a queryable graph of milestones, slices, tasks, rules, patterns, and lessons.',
    '',
    'Subcommands:',
    '  build   Parse .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,',
    '          KNOWLEDGE.md) and write .gsd/graphs/graph.json atomically.',
    '  query   Search graph nodes by term (BFS from seed matches, budget-trimmed).',
    '          Returns matching nodes and reachable edges within the token budget.',
    '  status  Show whether graph.json exists, its age, node/edge counts, and',
    '          whether it is stale (built more than 24 hours ago).',
    '  diff    Compare current graph.json with .last-build-snapshot.json.',
    '          Returns added, removed, and changed nodes and edges.',
    '',
    'Examples:',
    '  forge graph build                        Build the graph from .gsd/ artifacts',
    '  forge graph status                       Check graph age and node/edge counts',
    '  forge graph query auth                   Find nodes related to "auth"',
    '  forge graph diff                         Show changes since last snapshot',
  ].join('\n'),

  hermes: [
    'Usage: forge hermes install [options]',
    '',
    'Install the bundled open-gsd-hermes plugin into Hermes Agent.',
    '',
    'Options:',
    '  --hermes-home <path>    Hermes home (default: $HERMES_HOME or ~/.hermes)',
    '  --project <path>        Default Forge project to write into gsd.yaml',
    '  --plugin-source <path>  Override bundled integrations/hermes source',
    '  --skip-pip             Copy plugin only; do not pip install editable package',
    '  --skip-enable          Do not run hermes plugins enable',
    '  --dry-run              Print intended actions without writing',
    '',
    'Examples:',
    '  forge hermes install --project ~/code/myapp',
    '  HERMES_HOME=~/.hermes forge hermes install --skip-enable',
  ].join('\n'),

  read: [
    'Usage: forge read <progress|roadmap|memory> --json --project <path>',
    '',
    'JSON read seam for external integrations (e.g. open-gsd-hermes).',
    'Emits envelope: { integration_version, kind, projectDir, data }.',
    '',
    'Examples:',
    '  forge read progress --json --project ~/code/myapp',
    '  forge read roadmap --json --project ~/code/myapp --milestone M001',
    '  forge read memory --json --project ~/code/myapp --query auth',
  ].join('\n'),

  headless: [
    'Usage: forge headless [flags] [command] [args...]',
    '',
    'Run /gsd commands without the TUI. Default command: auto',
    '',
    'Flags:',
    '  --timeout N            Overall timeout in ms (default: 300000)',
    '  --json                 JSONL event stream to stdout (alias for --output-format stream-json)',
    '  --output-format <fmt>  Output format: text (default), json (structured result), stream-json (JSONL events)',
    '  --bare                 Minimal context: skip CLAUDE.md, AGENTS.md, user settings, user skills',
    '  --resume <id>          Resume a prior headless session by ID',
    '  --model ID             Override model',
    '  --supervised           Forward interactive UI requests to orchestrator via stdout/stdin',
    '  --response-timeout N   Timeout (ms) for orchestrator response (default: 30000)',
    '  --answers <path>       Pre-supply answers and secrets (JSON file)',
    '  --events <types>       Filter JSONL output to specific event types (comma-separated)',
    '',
    'Commands:',
    '  auto                 Run all queued units continuously (default)',
    '  next                 Run one unit',
    '  status               Show progress dashboard',
    '  new-milestone        Create a milestone from a specification document',
    '  query                JSON snapshot: state + next dispatch + costs (no LLM)',
    '',
    'new-milestone flags:',
    '  --context <path>     Path to spec/PRD file (use \'-\' for stdin)',
    '  --context-text <txt> Inline specification text',
    '  --auto               Start auto-mode after milestone creation',
    '  --verbose            Show tool calls in progress output',
    '',
    'Output formats:',
    '  text         Human-readable progress on stderr (default)',
    '  json         Collect events silently, emit structured HeadlessJsonResult on stdout at exit',
    '  stream-json  Stream JSONL events to stdout in real time (same as --json)',
    '',
    'Examples:',
    '  forge headless                                    Run /gsd auto',
    '  forge headless next                               Run one unit',
    '  forge headless --output-format json auto           Structured JSON result on stdout',
    '  forge headless --json status                      Machine-readable JSONL stream',
    '  forge headless --timeout 60000                    With 1-minute timeout',
    '  forge headless --bare auto                        Minimal context (CI/ecosystem use)',
    '  forge headless --resume abc123 auto               Resume a prior session',
    '  forge headless new-milestone --context spec.md    Create milestone from file',
    '  cat spec.md | forge headless new-milestone --context -   From stdin',
    '  forge headless new-milestone --context spec.md --auto    Create + auto-execute',
    '  forge headless --supervised auto                     Supervised orchestrator mode',
    '  forge headless --answers answers.json auto              With pre-supplied answers',
    '  forge headless --events agent_end,extension_ui_request auto   Filtered event stream',
    '  forge headless query                              Instant JSON state snapshot',
    '  forge headless recover                            Reset hierarchy + validation/gates, then rebuild from markdown',
    '',
    'Exit codes: 0 = success, 1 = error/timeout, 10 = blocked, 11 = cancelled',
  ].join('\n'),
}

// Alias: `forge wt --help` → same as `forge worktree --help`
SUBCOMMAND_HELP['wt'] = SUBCOMMAND_HELP['worktree']

export function printHelp(version: string): void {
  writeHelpHeader(version)
  process.stdout.write('Usage: forge [options] [message...]\n\n')
  process.stdout.write('Options:\n')
  process.stdout.write('  --mode <text|json|rpc|mcp> Output mode (default: interactive)\n')
  process.stdout.write('  --print, -p              Single-shot print mode\n')
  process.stdout.write('  --continue, -c           Resume the most recent session\n')
  process.stdout.write('  --worktree, -w [name]    Start in an isolated worktree (auto-named if omitted)\n')
  process.stdout.write('  --model <id>             Override model (e.g. provider/model-id)\n')
  process.stdout.write('  --no-session             Disable session persistence\n')
  process.stdout.write('  --extension <path>       Load additional extension\n')
  process.stdout.write('  --tools <a,b,c>          Restrict available tools\n')
  process.stdout.write('  --list-models [search]   List available models and exit\n')
  process.stdout.write('  --version, -v            Print version and exit\n')
  process.stdout.write('  --help, -h               Print this help and exit\n')
  process.stdout.write('\nSubcommands:\n')
  process.stdout.write('  config                   Re-run the setup wizard\n')
  process.stdout.write('  install <source>         Install a package/extension source\n')
  process.stdout.write('  remove <source>          Remove an installed package source\n')
  process.stdout.write('  list                     List installed package sources\n')
  process.stdout.write('  update                   Update Forge to the latest version\n')
  process.stdout.write('  upgrade                  Alias for update\n')
  process.stdout.write('  sessions                 List and resume a past session\n')
  process.stdout.write('  worktree <cmd>           Manage worktrees (list, merge, clean, remove)\n')
  process.stdout.write('  auto [args]              Run auto-mode without TUI (pipeable)\n')
  process.stdout.write('  headless [cmd] [args]    Run /gsd commands without TUI (default: auto)\n')
  process.stdout.write('  graph <subcommand>       Manage knowledge graph (build, query, status, diff)\n')
  process.stdout.write('  hermes install           Install the Hermes Agent plugin\n')
  process.stdout.write('\nRun forge <subcommand> --help for subcommand-specific help.\n')
}

export function printSubcommandHelp(subcommand: string, version: string): boolean {
  const help = SUBCOMMAND_HELP[subcommand]
  if (!help) return false
  writeHelpHeader(version)
  process.stdout.write(help + '\n')
  return true
}
