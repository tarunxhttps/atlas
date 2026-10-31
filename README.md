# Atlas

Atlas is a Mac app for reviewing pull requests. Paste a GitHub PR link and it draws the change as diagrams:

- **Architecture**: components grouped into lanes, with the added, changed and removed parts coloured.
- **Package, Module and Code levels**: zoom from folders down to individual functions.
- **Flows**: animated sequence diagrams of how a request moves through the new code.

On every diagram you can see what calls what, what changed, and what outside the PR the change touches.

It exists because the GitHub diff shows lines, not structure. Before reading a big PR you want to know where it sits in the system, which functions changed, and who calls them.

## How it works

Atlas keeps two layers apart, the way Etchpad does:

1. **Facts from the parser, with no AI.** Atlas clones the repo once using your `gh` login and diffs the PR against its merge base. tree-sitter then parses the old and new version of every changed Python, TypeScript or JavaScript file. Every function, method and class is marked **added**, **modified**, **removed** or **unchanged**, and formatting-only edits and moved functions are detected. Calls are resolved into a call graph. `git grep` then finds files outside the PR that call the changed code or are called by it, so the map also shows the blast radius.
2. **An AI layer on top.** Claude reads those facts and the diff, and writes the architecture lanes, data flows with payloads, a walkthrough, a linked explanation, a reading order and an attention list. Ids Claude invents that don't exist in the facts are dropped before anything is shown.

The parser map appears within seconds. The AI layer arrives a minute or two later, and only once per commit. Re-analyzing at the same commit reuses it. After new commits, Claude gets only the earlier explanation and what changed since, not the whole PR again.

## Requirements

- macOS, with Node 22 or newer (developed on Node 26)
- `gh`, logged in (`gh auth status`)
- `git`
- For the AI layer, one of:
  - the `claude` CLI, logged in. This is the default and needs no API key.
  - an Anthropic API key, entered in Settings and stored encrypted with macOS Keychain.

## Run it

```bash
npm install
npm run dev          # development, with hot reload
npm run build        # production bundles in out/
npm run dist         # a .dmg via electron-builder (unsigned)
npm run typecheck
```

VS Code terminals set `ELECTRON_RUN_AS_NODE`, which makes Electron start as plain Node. If the app fails with "does not provide an export named 'BrowserWindow'", start it with:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

## Using it

| Key | Action |
| --- | --- |
| drag, two-finger scroll, arrow keys (`⇧` for bigger steps) | move around the canvas |
| pinch, `⌘`+scroll, `+` / `−` | zoom |
| `1`–`5` | Architecture, Package, Module, Code, Flows |
| `j` / `k` | next / previous changed function |
| `i` | isolate the selection and what it touches |
| `v` | mark the selection viewed |
| `w`, then `←` `→` | play and step the walkthrough (the arrows pan again once it's closed) |
| `c` | show code inside cards (Code level) |
| `/` | search |
| `⌘→` / `⌘←` | walk the selected node's outgoing / incoming lines; with several, each press picks the next and shows a peek |
| `Enter` | follow the picked line |
| `⌘[` `⌘]` | back / forward through nodes you visited |
| `Ctrl+G` `Ctrl+D` `Ctrl+F` `Ctrl+K` | Changes, AI overlays, Search, Ask |
| `Esc` | cancel a picked line, clear selection, stop isolating, close the walkthrough |

- Drag the edge of the left panel or the inspector to resize it, and double-click the edge to reset. Dragging the left panel below 200px closes it; reopen it from the rail or with its shortcut.
- Click a card to open the **inspector**. It shows the signature, Claude's note, callers and dependencies, and the old and new code side by side with word-level highlights.
- Double-click a card to **isolate** it. Isolating a class or model also searches the whole repo for code that uses it.
- Shift-click several cards, then ask about them in **Ask**.
- Click a **markdown file**, from the Changes list or the Module view, to read the whole file rendered as it is at the PR head. Table-of-contents links scroll to their section, and "Source diff" shows the raw changed lines.
- In the Flows view, click an arrow to see its request and response payload.
- **Viewed is local.** Your ticks stay in Atlas, and Atlas never changes anything on GitHub. A file you tick or untick on github.com gets ticked or unticked in Atlas the next time the PR syncs.
- **New commits** show as a **↓ N commits** button at the top of the Changes panel, with a badge on its icon. Click it to pull and re-map the PR. Anything you viewed whose code changed comes back unviewed and tagged "changed".
- Settings has **per-repo corrections**: exclude globs, renames, and pins of a component to a lane.

## Where data lives

Everything is under `~/Library/Application Support/atlas/`:

- `repos/<owner>/<repo>`: a blobless clone per repo
- `analyses/`: one JSON file per PR head commit, so reopening a PR is instant
- `review/`: what you marked as viewed
- `settings.json`

Code goes to Claude only through the provider you pick in Settings.

More detail is in [docs/](docs/). [research.md](docs/research.md) covers which tool each feature comes from, [plan.md](docs/plan.md) what is built and what is left, [decisions.md](docs/decisions.md) why, and [flow.md](docs/flow.md) how the code runs.
