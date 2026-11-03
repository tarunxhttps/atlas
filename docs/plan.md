# Plan: Atlas v1

A personal macOS app for PR review. Paste a GitHub PR link and see the change as architecture, call-graph and data-flow diagrams, with the added, changed and removed parts marked. The feature list comes from [research.md](research.md).

## Files

Everything below is CREATE; this is a new repo at `~/BIK/personal/atlas`.

### Shared (`src/shared/`)
- `types.ts`: the domain model (PR, changed files, symbols with deltas, call edges, analysis, settings).
- `narrative.ts`: zod schemas for Claude's structured output (the narrative and chat answers).
- `ipc.ts`: IPC channel names and the `AtlasApi` the preload exposes.
- `review.ts`: what counts as one review item (each changed function or method, plus each changed file with no changed function), shared by main and the renderer.
- `paths.ts`: test-path and markdown-path detection, used by the renderer's filters.

### Main process (`src/main/`)
- `index.ts`: `AtlasApp` creates the window, wires the services together and registers the IPC handlers.
- `services/CommandRunner.ts`: runs `gh`, `git` and `claude` with a PATH that works when the app is launched from Finder.
- `services/GitHubPrClient.ts`: parses PR links and reads PR metadata with `gh pr view`.
- `services/RepoMirror.ts`:
  - Keeps one blobless clone per repo.
  - Fetches PR refs, finds the merge base, checks out the head, diffs, and runs `git show`.
  - Searches with a single PCRE `git grep`.
- `analysis/UnifiedDiffParser.ts`: turns the git diff into files, hunks and lines.
- `analysis/LanguageRegistry.ts`: loads the tree-sitter WASM grammars (Python, TS, TSX, JS) and maps file extensions to them.
- `analysis/SymbolExtractor.ts`: finds functions, methods, classes and arrow-function consts, plus every call site.
- `analysis/SymbolDiffer.ts`:
  - Pairs the base and head symbols of each file.
  - Assigns deltas and detects formatting-only edits and moved functions.
  - Counts changed lines per symbol.
- `analysis/CallGraphBuilder.ts`:
  - Resolves calls on the base side and the head side, giving added, removed and unchanged edges. Only calls proven by the same class, the same file or an import get an edge (decisions D7).
  - Flags dangling calls (the head still calls code the PR removed).
- `analysis/ImportResolver.ts`: decides whether an import names a file (relative imports exactly, absolute ones as a path suffix, packages include the files under them).
- `analysis/NeighbourFinder.ts`: finds unchanged files outside the PR that call into the change or are called by it, which is the blast radius.
- `analysis/AnalysisPipeline.ts`:
  - Runs the steps in order and reports progress.
  - Saves the analysis per head commit.
  - Starts the narrative in the background.
- `ai/ClaudeProvider.ts`, `ai/ClaudeCliProvider.ts`, `ai/AnthropicApiProvider.ts`: two ways to get structured output from Claude, through the `claude` CLI or through the SDK with a key.
- `ai/NarrativeService.ts`:
  - Builds the prompts and runs the narrative and the chat.
  - `NarrativeSanitizer` drops ids that don't exist in the facts and applies lane pins.
- `store/AtlasStore.ts`: settings (the API key encrypted with `safeStorage`), analyses, recent PRs and review state (with code fingerprints), kept as JSON files.
- `review/ReviewService.ts`:
  - Marks review items viewed and re-checks them against the latest code.
  - Reads GitHub's per-file "Viewed" boxes. It never writes to GitHub.
- `services/GitHubPrClient.ts` also checks for new commits (`gh pr view` plus the compare API) and reads each file's viewed state through GraphQL (`viewerViewedState`). It is read-only.

### Preload (`src/preload/index.ts`)
- Exposes `window.atlas` through `contextBridge`.

### Renderer (`src/renderer/src/`)
- `lib/AnalysisModel.ts`: read-only indexes over an analysis (callers, callees, children, components, notes, renames).
- `lib/WorkspaceContext.ts`: shared workspace actions (reveal, highlight, viewed, isolate) and GitHub links.
- `graph/GraphBuilder.ts`: builds the graph for each level (architecture, package, module, code), applying the scope and filters.
- `graph/ElkLayouter.ts`: ELK layered layout with nesting; architecture lanes are laid out as fixed columns.
- `graph/LegendFilter.ts`: which nodes and lines to hide for the legend kinds switched off (decisions D30).
- `lib/CallSiteDiff.ts` and `components/CallPeek.tsx`: the ⌘ + hover box with a line's call lines, marked added, removed, changed or unchanged (decisions D32).
- `components/`:
  - `App`, `Home`, `Workspace`
  - `Canvas` and `Nodes` (the React Flow canvas)
  - `FlowView` (sequence diagram and payload panel)
  - `Inspector` and `CodeDiff`
  - `Panels` (changes tree, search), `OverlaysPanel`, `ChatPanel`
  - `Markdown`, `SettingsDialog`
- `styles.css`: light and dark theme tokens and all styling.

## Built in v1
- Paste a link or `owner/repo#n`. The parser map shows in seconds and the AI layer follows.
- Levels: Architecture, Package, Module and Code, plus Flows.
- Scope: Changed, With context or All. Isolate, hide tests, show code inside cards. Formatting-only edits show as changes with a "format" badge.
- Changes tree with counts, badges, next and previous change, and viewed checkboxes with progress.
- **Viewed is local, with GitHub ticks read in:**
  - Ticking a file on github.com ticks all its functions in Atlas, and unticking it there unticks them.
  - Atlas never changes anything on GitHub.
  - Every file row has a checkbox, and files with no changed function count as one item.
- **Incoming commits, VS Code style:**
  - Atlas checks GitHub every 60 seconds and whenever the window regains focus.
  - The Changes panel shows a "↓ N commits" button (or "↓ Force-pushed"), and the Changes icon gets a badge. Nothing shows while the PR is up to date.
  - **Pull latest changes** re-maps the PR in place.
  - Functions whose code changed lose their viewed mark and get a "changed" badge; the rest stay viewed.
- The canvas fades other cards only after a click or a walkthrough or chat highlight, never on hover.
- **Resizable panels**: drag the edge of the left panel or the inspector, and double-click to reset (decisions D20).
- **Unchanged code** (outside the PR, or untouched in a PR file) shows as plain code with real line numbers in the inspector, with no before/after.
- **Module view**: clicking a function row highlights it, its file and the files it talks to (decisions D19).
- **Edge walking**: ⌘→ / ⌘← pick lines one at a time with a peek box, and Enter follows (decisions D22).
- **"Uses" lines** for classes named without being called, and isolating a model finds its users across the repo (decisions D23).
- **Markdown files** show the whole file rendered, or the source diff, in the inspector. They're read on demand, so no re-analyze is needed (decisions D17).
- **Claude only runs for what changed** (decisions D15):
  - The same head reuses the explanation.
  - New commits send Claude only the earlier explanation and the changes since then.
  - "Regenerate" forces a full run.
- Inspector: signature (and the old one if it changed), Claude's note, attention items, callers and dependencies, and an old/new code diff (side by side or unified, Exact or With context, hide whitespace, word-level highlights).
- Dangling calls into removed code are drawn red and flagged for Claude.
- AI panel: overview with effort, risk and stat chips; walkthrough player; linked explanation; reading order you can mark viewed; attention list.
- Ask: chat about the selected cards; answers link and highlight on the map.
- Export PNG of the canvas and JSON of the analysis. Open the file or symbol on GitHub, or jump to the PR diff anchor.
- Settings: AI engine (CLI or API key), model, effort, auto-explain, how many files outside the PR to scan, theme, per-repo corrections.

## Not built yet
- Syntax highlighting in code views.
- A map of the whole repo, as Etchpad does. Atlas only maps the PR files and their neighbours.
- A data-model (ER) lens for schema and migration changes, as PR Lens has.
- Posting the diagram to the PR as a comment, and shareable links.
- Commenting, approving or merging from inside Atlas.
- Languages beyond Python, TypeScript and JavaScript (Go and Java grammars exist for tree-sitter).
- Edge routing that goes around cards in the same column. Edges currently run straight down through any cards in between.
- Streaming chat answers.
- A signed and notarised `.dmg`. `npm run dist` builds an unsigned one, which hasn't been tried yet.
- Showing which parts of a symbol each caller uses (Etchpad's "members touched").

## Answers for the non-trivial choices
- **Why parse instead of asking the LLM for everything?** A parsed map can't invent a function, and it still works when Claude is slow or down. Claude only adds grouping and story on top of facts it can't change.
- **What it costs.** One Claude call per PR head commit, cached afterwards. Each chat question is one more call. With the CLI route the overhead per call is about 2.7k tokens, because tools, MCP servers, skills and settings are switched off.
- **Smallest workable approach.** No database and no server: just JSON files and the CLIs you already have.

## Open questions
- Should "hide tests" stay on by default? It is on now, because test files dominate the call graph.
- Should Atlas use an existing local clone (for example `~/BIK/automation-chatbots`) with `--reference`, to make the first clone faster?
- Is the default model (`claude-opus-5-5`, high effort) right for everyday PRs, or should everyday PRs use Sonnet?
