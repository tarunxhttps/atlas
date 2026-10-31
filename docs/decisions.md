# Decisions

Each entry gives what was decided, why, and who decided it and when.

## D1. Electron + React + TypeScript
- **Decided:** build a desktop app with Electron 45, electron-vite, React 19 and TypeScript.
- **Why:**
  - The best graph libraries are web libraries (React Flow, ELK).
  - The code is TypeScript end to end.
  - Nothing new needs installing. Rust (for Tauri) isn't installed, and SwiftUI needs full Xcode and has no comparable graph layout.
- **Who:** Tarun, 2026-10-31.

## D2. Claude through the local CLI by default, with an API-key option
- **Decided:** default to `claude -p --json-schema` with your Claude Code login. Settings can switch to the Anthropic SDK with an API key, which uses streaming, `betaZodOutputFormat` and `fallbacks: "default"`.
- **Why:** it works with no key. The CLI flags `--tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands` cut the per-call overhead from about 102k to 2.7k tokens.
- **Who:** Tarun, 2026-10-31.

## D3. A local blobless clone per repo, through `gh`
- **Decided:** clone each repo once with `gh repo clone -- --filter=blob:none --no-checkout`, then check out the PR head.
- **Why:**
  - Finding callers outside the PR needs the whole tree; the GitHub API only gives the changed files.
  - Git network calls reuse your `gh` login as their credential helper.
- **Who:** Tarun, 2026-10-31.

## D4. App name and location
- **Decided:** call the app "Atlas" and put it at `~/BIK/personal/atlas`.
- **Who:** Tarun, 2026-10-31.

## D5. Keep the parsed facts separate from Claude's layer
- **Decided:**
  - The Package, Module and Code levels, the changes tree, callers and dependencies, and the diffs all come only from the parser.
  - Claude adds the architecture, flows, walkthrough, explanation, reading order and attention list.
  - `NarrativeSanitizer` drops any symbol id Claude invents.
- **Why:** Etchpad's split. The map can't lie, and it shows up before the AI is done.
- **Who:** Claude (default), 2026-10-31.

## D6. tree-sitter WASM grammars from the official packages
- **Decided:** load the grammars from the `tree-sitter-python`, `tree-sitter-typescript` and `tree-sitter-javascript` packages, using the `.wasm` files they ship, with `web-tree-sitter` 0.27.
- **Why:** the prebuilt `tree-sitter-wasms` bundle fails to load in web-tree-sitter 0.27 (its WASM metadata format is too old). The official packages load fine and need no native build.
- **Who:** Claude, 2026-10-31.

## D7. Calls are resolved by name, with a confidence on each edge
- **Decided:**
  - Calls on `self`/`this` resolve within the same class, and calls in the same file resolve locally. Both are marked `resolved`.
  - Anything else must be the only candidate of that name, or the only one in the caller's folder, and is marked `name-match`.
  - Common names such as `get`, `run` and `append` are never matched.
  - Production code is never matched by name to test helpers or mocks.
- **Why:** without type information, a name match is the only cheap option. The dotted edge style tells you how far to trust an edge. The test-path rule came from a false edge found while testing, from `PubSubService` to a test mock.
- **Who:** Claude, 2026-10-31.

## D8. One PCRE `git grep` for neighbour search
- **Decided:** search with `git grep -P "\b(?:a|b|…)\b"`, falling back to `-w -E` when git has no PCRE.
- **Why:** with 188 words on automation-chatbots, `-w -F -e …` took 28s; PCRE took 0.4s and returned the same hits.
- **Who:** Claude, 2026-10-31.

## D9. The narrative runs in the background after the map
- **Decided:** `analyze` returns the parsed facts at once. The narrative is pushed later through an `analysis-updated` event and cached per head commit. A narrative that failed waits for you to retry; one interrupted by quitting resumes.
- **Why:** you see the map in seconds instead of waiting one to two minutes for Claude, and a failed narrative doesn't re-run, and cost money, every time the PR is opened.
- **Who:** Claude, 2026-10-31.

## D12. "Viewed" is local, and GitHub ticks are only read in
- **Decided:**
  - Atlas tracks viewed per function and stores it locally. It never writes to GitHub: no `markFileAsViewed`, no `unmarkFileAsViewed`.
  - On sync, Atlas reads GitHub's per-file "Viewed" box. A file newly ticked on github.com ticks all its functions in Atlas.
  - A file that was ticked at the last sync and isn't any more unticks them.
  - A tick made in Atlas on a file GitHub never ticked stays as it is.
- **Why:** Tarun wants Atlas's checks kept local, while ticks made on GitHub still count. The first version also pushed Atlas ticks to GitHub; that was removed the same day at Tarun's request.
- **Who:** Tarun, 2026-10-31.

## D13. New commits show as "incoming", with a Pull button
- **Decided:**
  - Atlas polls `gh pr view headRefOid` every 60 seconds and whenever the window regains focus.
  - When the head commit has moved, the Changes panel shows a "↓ N commits" pull button, with the commit list from the compare API behind "show". If the old head is gone, it says "Force-pushed" (see D21).
  - Pulling re-analyses in place, without going back to the home screen.
  - Each viewed item stores a SHA-1 fingerprint of its code. After a pull, items whose fingerprint changed are unmarked and tagged "changed".
- **Why:** you asked for VS Code-style incoming changes. Fingerprints make "already viewed" mean "already read this exact code".
- **Who:** Tarun, 2026-10-31.

## D14. No fading on hover
- **Decided:** all cards stay fully visible until you click one, or until a walkthrough step or chat answer highlights some.
- **Why:** with hover fading, the canvas looked faded whenever the mouse was over a frame, which was almost always.
- **Who:** Tarun, 2026-10-31.

## D15. Claude only runs for what changed
- **Decided:**
  - **Reuse:** re-analyzing or pulling at the same head commit re-parses the code and keeps the explanation, with no Claude call. The same happens when new commits only touch files outside the PR, such as a merge from the base branch.
  - **Update:** when the PR's code did change, Claude gets the previous explanation, the new, changed and gone symbols, the new calls, and the diff from the old head to the new head, limited to PR files. It does not get the whole PR diff again. It returns the revised explanation, keeping still-true parts word for word, with a first walkthrough step "What changed since your last review".
  - **Full:** used when there is no earlier ready explanation, the old head commit can't be diffed (for example after a force-push), the new commits' diff is over 150k characters, or you press "Regenerate".
- **Why:** Tarun: don't call Claude when nothing changed, and when something did, pass only what changed.
- **Who:** Tarun, 2026-10-31.

## D16. Re-layouts keep the selection in view
- **Decided:** when the canvas re-lays out (hide tests, scope, code in cards, isolate), the camera fits the selected node if it's still on the canvas, and otherwise fits the whole diagram. A reveal from the tree, search or a link focuses its node once, after the layout it caused; it isn't re-applied on later re-layouts.
- **Why:** Tarun: toggling "hide tests" re-arranged the canvas and lost the node being looked at. Before this, every layout fitted everything, and the last reveal was re-applied on top.
- **Who:** Tarun, 2026-10-31.

## D17. Markdown files show a whole-file preview, read on demand
- **Decided:**
  - Clicking a `.md`, `.mdx` or `.markdown` file renders the whole file as it reads at the PR head (or before deletion, if the PR deletes it), with a **Source diff** tab for the raw lines.
  - The text is read when the file is opened (`atlas:read-file` → `RepoMirror.show` on the local clone) rather than stored in the analysis, so PRs analysed earlier need no re-analyze.
  - Rendering uses `react-markdown` with `remark-gfm` (tables, task lists, strikethrough), and raw HTML is never rendered.
  - Headings get GitHub-style anchors, so table-of-contents links scroll the preview.
  - Images show as labelled placeholders, since private-repo images need auth, and only http(s) links open, in the browser.
  - A ⤢ button widens the inspector.
- **Why:** Tarun: the preview should be the whole file, not a diff, and shouldn't need a re-analyze. The first version (a block-level rendered diff kept in the analysis) was replaced the same day.
- **Who:** Tarun, 2026-10-31.

## D18. Selecting a file frame lights the frame and everything in it
- **Decided:**
  - A selection made by clicking a file holds the file path; it's matched to its canvas node `file:<path>`.
  - A selected frame counts its contents as selected, so its functions and their calls stay lit while everything else fades.
- **Why:** clicking a file frame highlighted nothing, while clicking a class or function inside it did.
- **Who:** Tarun, 2026-10-31.

## D19. Function rows in Module view cards highlight
- **Decided:**
  - In Module view a function is a row inside its file's card, not a node.
  - Selecting one marks the row, lights its card and the cards of files it calls or is called by, and keeps only the edges between them bright.
- **Why:** Tarun: clicking a function name in a Module card highlighted nothing. Option A was chosen over jumping to the Code view.
- **Who:** Tarun, 2026-10-31.

## D20. Panels resize by dragging, like VS Code
- **Decided:**
  - The left panel and the inspector each have a drag edge: hover shows the resize cursor and a blue line, and double-click resets.
  - Widths are kept between launches (localStorage), and the canvas never goes below 320px.
  - This replaces the inspector's widen button.
  - Dragging the left panel below 200px closes it, as VS Code does. It reopens only from a rail icon or its shortcut, at the width it had before that drag.
- **Why:** Tarun: the widen button made the layout overflow.
- **Who:** Tarun, 2026-10-31.

## D21. The update banner stays quiet until there's something to pull
- **Decided:**
  - No "up to date" text and no manual refresh: Atlas polls every 60 seconds and whenever the window regains focus.
  - When the PR has new commits, the Changes panel shows a single "↓ N commits" button that pulls, with a "show" toggle for the commit list.
  - The GitHub Viewed-box read status only appears when the read fails.
- **Why:** Tarun asked for less status text.
- **Who:** Tarun, 2026-10-31.

## D22. Walk the lines with ⌘→ / ⌘← and peek before you jump
- **Decided:**
  - ⌘→ follows the selected node's outgoing lines (what it calls); ⌘← follows incoming ones (its callers and users).
  - With one line, it jumps straight there. With several, each press picks the next line: that line glows, every other line fades to 7%, its target card is highlighted, and a peek box shows what's at the end (function: signature and changed lines; file: its changed functions; component: summary).
  - The camera stays put while cycling. Enter follows the picked line and moves the camera; Esc cancels.
  - The peek box sits right beside the picked line, like a popover (below, above, right or left of it). It takes the first side that fits on the canvas without covering either card, follows the line as you pan or zoom, and when the target is off-screen it sits beside the visible part of the line.
  - The top-left ← → buttons stay as back/forward through visited nodes (⌘[ / ⌘]), and they now reveal and frame the node too.
  - Camera framing uses React Flow's absolute node positions (`fitBounds`), because `fitView({ nodes })` ignores nodes it hasn't drawn, so off-screen targets didn't move the camera.
- **Why:** Tarun asked for keyboard walking along edges, with a preview instead of zooming out, and a picked line that stands out.
- **Who:** Tarun, 2026-10-31.

## D23. "Uses" lines, and isolating a model finds its users across the repo
- **Decided:**
  - The parser records the capitalised names each function or class mentions (type hints, `isinstance`, attributes). A mention that resolves to a class becomes a `reference` edge, drawn as a thin dash-dot line ("uses") and listed as "uses" in the inspector.
  - Isolating a class also searches the whole repo for its name (`atlas:find-usages` → `UsageFinder`). It parses the files that mention it, adds the functions that call or use it (with their file and class) to the saved analysis, and records the class in `expandedUsages` so the search runs once.
  - Isolation includes the class's own users, not only its methods' callers.
- **Why:** Tarun: isolating a model should show the functions and files where it's used. Before this, only calls made lines, so a model named only in type hints looked unused.
- **Who:** Tarun, 2026-10-31.

## D24. The Architecture view doesn't take over mid-review
- **Decided:** when Claude's explanation arrives, Atlas switches to Architecture only if nothing is selected.
- **Why:** an explanation finishing while you're in the Code view pulled you away from the node you were reading.
- **Who:** Claude, 2026-10-31.

## D25. No "hide formatting" filter
- **Decided:** the toolbar's "hide formatting" checkbox and its filtering are removed. Formatting-only edits count as changes everywhere: their normal modified colour on the map, included in the "Changed" scope, and still labelled with a "format" badge in the Changes list and the inspector.
- **Why:** Tarun: not needed.
- **Who:** Tarun, 2026-10-31.

## D11. The canvas pans like a map; nodes don't drag
- **Decided:**
  - No node can be dragged.
  - Dragging anywhere pans, and so does two-finger scroll, 1:1 with the fingers (`panOnScrollSpeed` 1).
  - Pinch or `⌘`+scroll zooms.
  - Arrow keys pan, except while the walkthrough is playing, where they step through it.
- **Why:** React Flow marks every draggable node `nopan`. The file, class and lane frames cover most of the canvas, so dragging moved frames instead of panning, and trackpad scrolling zoomed instead of moving.
- **Who:** Tarun reported it couldn't move around; fixed 2026-10-31.

## D10. Tests hidden by default on the canvas
- **Decided:**
  - "Hide tests" starts checked, and applies to both the canvas and the Changes list. The list shows "N test files hidden · show".
  - While tests are hidden, `j`/`k` skip test functions.
  - Opening a test function from search or a link turns the filter off.
- **Why:** in PR #5952, 40+ new test methods buried the real code in one tall column.
- **Who:** Claude, 2026-10-31. This is an open question in plan.md.
