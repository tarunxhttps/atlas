# Research: what existing PR visualizers do

This research was done on 2026-10-31 to decide Atlas's feature set. The sources were each tool's site and docs, PR Lens's source code, and the recordings on etchpad.ai. Etchpad's "videos" are DOM replays, so their poster frames were studied instead.

## PR Lens (github.com/coldteadotai/pr-lens, MIT)
- Draws the PR as **lanes and cards**. Every node, edge and flow step carries a delta: added, modified, removed or unchanged.
- **Unchanged neighbours** are drawn too, so you can see the blast radius.
- **Data-flow lens**: ordered steps animated with a moving dot. Clicking an arrow shows the **payload**, with added and removed fields in colour.
- **Views**: drill-down sections that go from system context to containers to components.
- **Walkthrough**: 2 to 12 steps, each showing one diagram and focusing on one part of it.
- **Interactive canvas**: pan, zoom, light and dark themes, and live Q&A with an agent.
- **Corrections** live in `.github/pr-lens.yml`: rename, exclude, pin to a lane, group.
- Runs as a GitHub App, an Action, from the CLI, or as an agent skill. An LLM produces a strict JSON graph and a validator rejects invented ids.

## Etchpad (etchpad.ai, waitlist only)
- A **deterministic map** built by parsing the code. AI explanations are a separate overlay and are never mixed into the map.
- **Zoom levels**: Architecture, Package, Module, Code, plus back and forward buttons.
- **Git panel**:
  - "Diff vs ref" shows a tree of changed scopes (folder → file → class → method) with +/− counts and MODIFIED or ADDED badges.
  - Filters by kind (signatures, structures), by access (public, package-private), and by how far to collapse.
  - Next and previous changed scope, a hide-whitespace toggle, and "Isolate" or "With context".
- **On the canvas**: changed scopes are hatched. A **Before pane** shows old code beside new with word-level highlights.
- **Trace panel**:
  - Explore a function's callers or its dependencies, and flip between them.
  - Shows which of the function's parts each caller uses.
  - Undo and redo, breadcrumbs, and keyboard navigation.
- **Block toolbar**: Explore, Callers, Dependencies, Pivot, and a signature popover.
- **AI overlays**:
  - Walkthroughs split into sections and steps, every step tied to a real construct, with an "Isolate canvas" option.
  - Prose explanations where each link pans the canvas to the code.

## Other tools
- **CodeRabbit**:
  - Walkthrough comment with a changed-files table, Mermaid sequence diagrams, a 1–5 review-effort score and a merge-risk rating.
  - **Change Stack** splits a PR into layers and gives a reading order: contracts first, then consumers, then tests. It also tracks read progress and offers chat scoped to a layer or file.
  - **Blast-radius graph** with typed edges and a confidence for each.
- **CodeSee Review Maps** (now GitKraken):
  - File map with dependency arrows, coloured added, modified, removed or impacted.
  - Clicking a file isolates its dependencies.
  - "Reviewed" checkboxes and tours of the change.
- **Greptile**: picks a diagram type per PR (sequence, ER, class or flow) and gives a 0–5 confidence score.
- **Qodo PR-Agent**: `/describe` adds a Mermaid diagram of how components interact, with a configurable direction.
- **SemanticDiff and difftastic**: diffs that ignore formatting and detect moved code.
- **SciTools Understand**: call graphs that compare two versions and mark added and removed call edges.
- **Sourcegraph**: find references from inside the PR diff.

## What Atlas takes from each

| Area | Feature | Source |
| --- | --- | --- |
| Diagrams | Lanes and cards with deltas, plus unchanged neighbours | PR Lens, CodeRabbit |
| | Function call graph with added and removed call edges | Etchpad, Understand |
| | Animated sequence flows with payloads | PR Lens, CodeRabbit |
| | Zoom from Architecture to Package, Module and Code | Etchpad |
| Change view | Tree of changed scopes with counts, next and previous change | Etchpad |
| | Before and after code with word-level highlights; Exact or With context; hide whitespace | Etchpad, SemanticDiff |
| | Formatting-only edits and moved functions detected | SemanticDiff, difftastic |
| Navigation | Callers and dependencies trace, isolate, back and forward, search, minimap | Etchpad, CodeSee, Sourcegraph |
| AI | Walkthrough player, linked explanation, chat about the selection | PR Lens, Etchpad, CodeRabbit |
| | Reading order, effort and risk, attention list | CodeRabbit, Greptile |
| Review | Mark viewed, with progress | CodeSee, SemanticDiff |
| | Analysis saved per head commit | PR Lens, CodeRabbit |
| Other | PNG and JSON export, per-repo corrections | PR Lens, Qodo |
