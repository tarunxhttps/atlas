# Flow: how Atlas runs

## Start-up
1. `src/main/index.ts` → `new AtlasApp().start()` creates the services: `CommandRunner`, `AtlasStore`, `GitHubPrClient`, `RepoMirror`, `SymbolExtractor(LanguageRegistry)`, `NeighbourFinder`, `NarrativeService` and `AnalysisPipeline`.
2. `AtlasApp.registerIpc` connects each `IpcChannels.*` channel to a service. `createWindow` loads the renderer with `src/preload/index.ts` as the preload, which exposes `window.atlas`.
3. `src/renderer/src/main.tsx` → `App` loads the settings, applies the theme, subscribes to `onProgress` and `onAnalysisUpdated`, and shows `Home`.

## Opening a PR
1. `Home` submits the link → `App.open` → `window.atlas.analyze(url, force)` → IPC `atlas:analyze`.
2. `AtlasApp` → `AnalysisPipeline.analyze`:
   1. `GitHubPrClient.parseRef` and `fetchMeta` (`gh pr view --json …`).
   2. `AtlasStore.loadAnalysis(key, headSha)`. If an analysis for this commit is cached, return it. If its narrative was cut off by quitting, restart it.
   3. Sync the repo with `RepoMirror`: `ensureClone` (`gh repo clone`, blobless), `fetchPr` (`refs/pull/N/head` and the base branch), `mergeBase`, `checkout(headSha)`.
   4. `RepoMirror.diff(mergeBase, head)` → `UnifiedDiffParser.parse` gives the `ChangedFile[]`. Excludes come from the default globs plus the repo's corrections.
   5. `parsePrFiles`, for each supported file:
      - `RepoMirror.show` reads the base and head source.
      - `SymbolExtractor.extract` parses both with tree-sitter.
      - `SymbolDiffer.diffFile` pairs the symbols and assigns deltas.
      - Then `linkMoves` (moved functions) and `markClassesWithChangedMembers`.
   6. `NeighbourFinder.find`:
      - Collects the changed names and the names they call that aren't defined in the PR.
      - Runs `RepoMirror.grepWords` (one PCRE `git grep`) and ranks files by how many words they hit.
      - Parses the top N files and adds their symbols as unchanged neighbours (`inPr: false`).
   7. `CallGraphBuilder.build` resolves calls on the base and head sides, giving added, removed, unchanged and dangling edges. `keepConnectedNeighbours` drops neighbours with no edge to the PR.
   8. `AtlasStore.saveAnalysis` saves it, and the analysis is returned to the renderer (narrative `pending`).
   9. `narrativePlan` compares this analysis with the previously saved one (decisions D15):
      - Same head, or new commits that touch no PR file: **reuse**. `NarrativeService.reuse` re-checks the old explanation against the new facts, and the analysis is returned ready. No Claude call.
      - New commits in PR files: **update**, using `RepoMirror.diff(oldHead, newHead)` limited to PR files.
      - Otherwise: **full**.
   10. `startNarrative(plan)` runs in the background:
      - Full: `NarrativeService.generate` builds the facts and diff prompt.
      - Update: `NarrativeService.update` sends the previous explanation, `changesSince` (new, changed and gone symbols, new calls) and the diff since then.
      - Either way it calls `ClaudeProvider.generate`.
      - The provider is `ClaudeCliProvider` (`claude -p --json-schema`) or `AnthropicApiProvider` (SDK stream with zod output).
      - `NarrativeSanitizer.sanitize` cleans the result, it is saved, and it is pushed to the renderer on `atlas:analysis-updated`.
3. `App` swaps in the updated analysis and renders `Workspace`.

## Drawing the canvas
1. `Workspace` builds an `AnalysisModel` (the indexes) and a `GraphBuilder`.
2. Its view state (level, scope, filters, isolate) becomes `GraphOptions` → `GraphBuilder.build`, which returns a `GraphSpec`:
   - **code**: symbols nested inside class frames inside file frames, with call edges.
   - **module** and **package**: files or folders, with call edges grouped between them.
   - **architecture**: Claude's lanes and components.
3. `Canvas` → `ElkLayouter.layout(spec)`: ELK layered layout with nesting, or fixed lane columns for architecture. The result becomes React Flow nodes (`Nodes.tsx`) and edges coloured by delta.
4. Selection, hover and highlights only restyle the nodes and edges (dimming, lit edges). The layout re-runs only when the spec changes.

## Moving around
- **Changes tree, search, links and chat answers** → `WorkspaceApi.reveal(id)` → `AnalysisModel.resolve(id)`:
  - a symbol switches to the Code level (and widens the scope if it isn't visible)
  - a component switches to Architecture
  - a file switches to Module
  - a flow step switches to Flows
  
  In each case it then focuses the canvas (`FocusRequest` → `fitView`) and opens the `Inspector`.
- **Walkthrough**: `Workspace.playStep(i)` sets the level or flow, highlights the step's `focusIds` and focuses the canvas. The caption bar is drawn in `Workspace`.
- **Flows**: `FlowView` draws an SVG sequence diagram from `narrative.flows`. Play steps through it on a timer. A clicked step opens `PayloadPanel`.
- **Ask**: `ChatPanel` → `window.atlas.ask(key, question, selected ids, history)` → `NarrativeService.ask` → provider. The answer's `highlightIds` light up the map.
- **Viewed**: the checkboxes, the inspector and the `v` key call `window.atlas.setViewed` → `ReviewService.setViewed`, which saves the ids with their code fingerprints to `review/<key>.json`. Nothing is sent to GitHub.
- **Review sync**: `Workspace` calls `window.atlas.syncReview` when a PR opens and after each pull → `ReviewService.sync`:
  1. `invalidateChanged` unmarks items whose fingerprint no longer matches the current code and records them in `changedSinceViewed`.
  2. `GitHubPrClient.viewedStates` reads GitHub's view state for every file. This is read-only.
  3. Files newly ticked on github.com tick their functions in Atlas, and files unticked there untick them (see decisions D12).
- **Incoming commits**: `Workspace` polls `window.atlas.checkForUpdates` every 60 seconds and whenever the window regains focus → `GitHubPrClient.checkForUpdates`:
  1. `gh pr view headRefOid,state`.
  2. If the head moved, `gh api repos/…/compare/old...new`.
  3. If the head differs from the analysed one, `ChangesPanel` shows the banner and the rail shows a badge.
  4. **Pull latest changes** → `App.refresh` → `window.atlas.analyze(url, force)`, which keeps the workspace open. A new head re-runs `syncReview`.

## Settings
`SettingsDialog` → `window.atlas.saveSettings(patch)` → `AtlasStore.saveSettings`. The API key is encrypted with `safeStorage`, and the theme is applied through `nativeTheme`. Excludes take effect on the next re-analyze. Renames and lane pins apply in the renderer and in the next narrative.
