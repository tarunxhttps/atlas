import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import type { Analysis, ChatTurn, PrUpdate, ProgressEvent, ReviewState, Settings, SettingsPatch } from "@shared/types";
import { isTestPath } from "@shared/paths";
import { GraphBuilder, type GraphOptions, type Level, type Scope } from "../graph/GraphBuilder";
import { AnalysisModel } from "../lib/AnalysisModel";
import { GitHubLinks, WorkspaceContext, type WorkspaceApi } from "../lib/WorkspaceContext";
import { Canvas, type FocusRequest } from "./Canvas";
import { ChatPanel } from "./ChatPanel";
import { EdgePeek } from "./EdgePeek";
import { FlowView } from "./FlowView";
import { Inspector } from "./Inspector";
import { OverlaysPanel } from "./OverlaysPanel";
import { ChangesPanel, SearchPanel } from "./Panels";
import { ResizeHandle, usePanelWidth } from "./ResizeHandle";

type View = Level | "flows";

const railWidth = 52;
const minCanvasWidth = 320;
const collapseSidePanelBelow = 200;
const reopenSidePanelAfter = 60;
type PanelId = "changes" | "overlays" | "search" | "chat";

interface Props {
  analysis: Analysis;
  settings: Settings;
  progress: ProgressEvent[];
  onHome: () => void;
  refreshing: boolean;
  refreshError: string | null;
  onReanalyze: () => void;
  onOpenSettings: () => void;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
}

const views: { id: View; label: string; key: string }[] = [
  { id: "architecture", label: "Architecture", key: "1" },
  { id: "package", label: "Package", key: "2" },
  { id: "module", label: "Module", key: "3" },
  { id: "code", label: "Code", key: "4" },
  { id: "flows", label: "Flows", key: "5" },
];

export function Workspace(props: Props) {
  return (
    <ReactFlowProvider>
      <WorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkspaceInner({ analysis, settings, progress, onHome, refreshing, refreshError, onReanalyze, onOpenSettings, onSaveSettings }: Props) {
  const repoCorrections = settings.corrections[`${analysis.pr.owner}/${analysis.pr.repo}`];
  const corrections = useMemo(() => repoCorrections ?? { exclude: [], rename: {}, lanePins: {} }, [repoCorrections]);
  const model = useMemo(() => new AnalysisModel(analysis, corrections), [analysis, corrections]);
  const builder = useMemo(() => new GraphBuilder(model), [model]);
  const github = useMemo(() => new GitHubLinks(analysis.pr), [analysis.pr]);
  const flow = useReactFlow();

  const [view, setView] = useState<View>(analysis.narrative ? "architecture" : "code");
  const [scope, setScope] = useState<Scope>("context");
  const [showCode, setShowCode] = useState(false);
  const [hideTests, setHideTests] = useState(true);
  const [isolateId, setIsolateId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [highlight, setHighlightState] = useState<string[]>([]);
  const [panel, setPanel] = useState<PanelId | null>("changes");
  const lastPanel = useRef<PanelId>("changes");
  useEffect(() => {
    if (panel) lastPanel.current = panel;
  }, [panel]);
  const [walkIndex, setWalkIndex] = useState<number | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowStepId, setFlowStepId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [review, setReview] = useState<ReviewState>({ viewed: [], changedSinceViewed: [], githubSync: { ok: true, message: null, syncedAt: null } });
  const [update, setUpdate] = useState<PrUpdate | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [cursor, setCursor] = useState(-1);
  // Each panel may grow until the canvas would drop below its minimum width.
  const [, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const panelWidths = useRef({ side: 0, inspector: 0 });
  const sidePanel = usePanelWidth("atlas.sidePanelWidth", 340, 240, () => window.innerWidth - railWidth - minCanvasWidth - panelWidths.current.inspector);
  const inspector = usePanelWidth("atlas.inspectorWidth", 520, 340, () => window.innerWidth - railWidth - minCanvasWidth - panelWidths.current.side);
  panelWidths.current = { side: panel ? sidePanel.width : 0, inspector: selectedIds.length > 0 ? inspector.width : 0 };
  const history = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const nonce = useRef(0);

  // A new head commit re-checks every viewed function against its new code and resyncs GitHub's "Viewed" boxes.
  useEffect(() => {
    void window.atlas.getReviewState(analysis.key).then(setReview);
    void window.atlas.syncReview(analysis.key).then(setReview).catch(() => undefined);
  }, [analysis.key, analysis.pr.headSha]);

  const checkForUpdates = useCallback(async () => {
    try {
      setUpdate(await window.atlas.checkForUpdates(analysis.key));
    } catch {
      // Offline or gh hiccup: keep showing the last result and try again on the next tick.
    }
  }, [analysis.key]);

  useEffect(() => {
    setUpdate(null);
    void checkForUpdates();
    const timer = setInterval(() => void checkForUpdates(), 60_000);
    const onFocus = () => void checkForUpdates();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkForUpdates, analysis.pr.headSha]);

  const incoming = update && update.headSha !== analysis.pr.headSha ? update : null;

  // The architecture view only exists once Claude answers; switch to it then, unless the reviewer is already looking at something.
  const hadNarrative = useRef(Boolean(analysis.narrative));
  const selectionRef = useRef(selectedIds);
  selectionRef.current = selectedIds;
  useEffect(() => {
    if (analysis.narrative && !hadNarrative.current) {
      hadNarrative.current = true;
      if (selectionRef.current.length === 0) setView("architecture");
    }
  }, [analysis.narrative]);

  const options: GraphOptions = useMemo(
    () => ({ level: view === "flows" ? "code" : view, scope, showCode, hideTests, isolateId }),
    [view, scope, showCode, hideTests, isolateId],
  );
  const spec = useMemo(() => builder.build(options), [builder, options]);

  // ⌘→ / ⌘← walk the selected node's outgoing / incoming lines; with several, each press highlights the next and Enter follows it.
  const [edgeCursor, setEdgeCursor] = useState<{ from: string; direction: "out" | "in"; edgeIds: string[]; index: number } | null>(null);
  useEffect(() => setEdgeCursor(null), [selectedIds, spec]);

  const focusOn = useCallback((ids: string[]) => {
    nonce.current += 1;
    setFocus({ ids, nonce: nonce.current });
  }, []);

  const pushHistory = (id: string) => {
    const { stack, index } = history.current;
    if (stack[index] === id) return;
    history.current = { stack: [...stack.slice(0, index + 1), id].slice(-100), index: Math.min(index + 1, 99) };
  };

  const reveal = useCallback(
    (id: string, revealOptions?: { additive?: boolean; fromHistory?: boolean }) => {
      const entity = model.resolve(id);
      if (!entity) return;
      if (!revealOptions?.fromHistory) pushHistory(id);
      setSelectedIds((current) => (revealOptions?.additive ? [...current.filter((existing) => existing !== id), id] : [id]));
      switch (entity.kind) {
        case "symbol": {
          const target = view === "module" ? "module" : "code";
          setView(target);
          const visible = builder.selectedLeaves({ ...options, level: "code" }).has(id) || builder.selectedLeaves({ ...options, level: "code" }).has(entity.symbol.parentId ?? "");
          if (!visible) {
            setIsolateId(null);
            setScope("all");
            if (hideTests) setHideTests(false);
          }
          const changedIndex = model.changedSymbols.findIndex((symbol) => symbol.id === id);
          if (changedIndex >= 0) setCursor(changedIndex);
          focusOn([target === "module" ? `file:${entity.symbol.path}` : id]);
          break;
        }
        case "component":
          setView("architecture");
          focusOn([id]);
          break;
        case "file":
          setView("module");
          focusOn([`file:${entity.path}`]);
          break;
        case "dir":
          setView("package");
          focusOn([id]);
          break;
        case "step":
          setView("flows");
          setFlowId(entity.flow.id);
          setFlowStepId(entity.step.id);
          break;
      }
    },
    [model, builder, options, view, hideTests, focusOn],
  );

  const selectOnCanvas = useCallback(
    (id: string, additive: boolean) => {
      if (id.startsWith("file:") || id.startsWith("dir:")) {
        const ref = id.startsWith("file:") ? id.slice(5) : id;
        pushHistory(ref);
        setSelectedIds([ref]);
        return;
      }
      pushHistory(id);
      setSelectedIds((current) => (additive ? [...current.filter((existing) => existing !== id), id] : [id]));
      const changedIndex = model.changedSymbols.findIndex((symbol) => symbol.id === id);
      if (changedIndex >= 0) setCursor(changedIndex);
    },
    [model],
  );

  const toggleViewed = useCallback(
    (ids: string[], viewed: boolean) => {
      void window.atlas.setViewed(analysis.key, ids, viewed).then(setReview);
    },
    [analysis.key],
  );

  const [findingUsages, setFindingUsages] = useState(false);
  const isolate = useCallback(
    (id: string | null) => {
      setIsolateId(id);
      if (id && !model.components.has(id) && view === "architecture") setView("code");
      // Isolating a class (a model) also searches the whole repo for code that uses it; the result arrives as an analysis update.
      const symbol = id ? model.symbols.get(id) : undefined;
      if (symbol?.kind === "class" && !analysis.expandedUsages?.includes(symbol.id)) {
        setFindingUsages(true);
        void window.atlas
          .findUsages(analysis.key, symbol.id)
          .catch(() => undefined)
          .finally(() => setFindingUsages(false));
      }
    },
    [model, view, analysis.key, analysis.expandedUsages],
  );

  const stepChange = useCallback(
    (direction: 1 | -1) => {
      const list = model.changedSymbols;
      if (list.length === 0 || (hideTests && list.every((symbol) => isTestPath(symbol.path)))) return;
      let next = cursor < 0 ? (direction === 1 ? 0 : list.length - 1) : (cursor + direction + list.length) % list.length;
      // With tests hidden, step over test functions instead of revealing (and un-hiding) them.
      while (hideTests && isTestPath(list[next].path)) next = (next + direction + list.length) % list.length;
      setCursor(next);
      reveal(list[next].id);
    },
    [model, cursor, reveal, hideTests],
  );

  const playStep = useCallback(
    (index: number) => {
      const steps = model.narrative?.walkthrough ?? [];
      const step = steps[index];
      if (!step) return;
      setWalkIndex(index);
      setIsolateId(null);
      setHighlightState(step.focusIds);
      if (step.stage === "flow") {
        setView("flows");
        setFlowId(step.flowId);
        setFlowStepId(step.focusIds[0] ?? null);
        return;
      }
      if (step.stage === "code") {
        const leaves = builder.selectedLeaves({ ...options, level: "code", isolateId: null });
        if (step.focusIds.some((id) => model.symbols.has(id) && !leaves.has(id))) setScope("all");
      }
      setView(step.stage);
      focusOn(step.focusIds);
    },
    [model, builder, options, focusOn],
  );

  /** The canvas node standing for the current selection; a file selection is drawn as `file:<path>`. */
  const selectedNode = (): string | null => {
    const id = selectedIds.at(-1);
    if (!id) return null;
    if (spec.nodes.some((node) => node.id === id)) return id;
    return spec.nodes.some((node) => node.id === `file:${id}`) ? `file:${id}` : null;
  };

  const goToNode = (nodeId: string) => {
    const id = nodeId.startsWith("file:") ? nodeId.slice(5) : nodeId;
    pushHistory(id);
    setSelectedIds([id]);
    focusOn([nodeId]);
  };

  const walkEdges = (direction: "out" | "in") => {
    const from = selectedNode();
    if (!from) return;
    const continuing = edgeCursor && edgeCursor.from === from && edgeCursor.direction === direction;
    const edgeIds = continuing
      ? edgeCursor.edgeIds
      : spec.edges.filter((edge) => (direction === "out" ? edge.source === from : edge.target === from)).map((edge) => edge.id);
    if (edgeIds.length === 0) return;
    if (edgeIds.length === 1) return followEdge({ from, direction, edgeIds, index: 0 });
    // The camera stays put while cycling; EdgePeek shows what's at the other end.
    const index = continuing ? (edgeCursor.index + 1) % edgeIds.length : 0;
    setEdgeCursor({ from, direction, edgeIds, index });
  };

  const followEdge = (cursor: { from: string; direction: "out" | "in"; edgeIds: string[]; index: number }) => {
    const edge = spec.edges.find((candidate) => candidate.id === cursor.edgeIds[cursor.index]);
    setEdgeCursor(null);
    if (edge) goToNode(cursor.direction === "out" ? edge.target : edge.source);
  };

  const navigateHistory = (direction: 1 | -1) => {
    const { stack, index } = history.current;
    const next = index + direction;
    if (next < 0 || next >= stack.length) return;
    history.current = { stack, index: next };
    // Same as clicking it again: switch to the view it lives in and bring it on screen.
    reveal(stack[next], { fromHistory: true });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select")) return;
      if (event.metaKey && event.key === "[") return navigateHistory(-1);
      if (event.metaKey && event.key === "]") return navigateHistory(1);
      if (event.metaKey && (event.key === "ArrowRight" || event.key === "ArrowLeft") && view !== "flows") {
        event.preventDefault();
        return walkEdges(event.key === "ArrowRight" ? "out" : "in");
      }
      if (event.key === "Enter" && edgeCursor) {
        event.preventDefault();
        return followEdge(edgeCursor);
      }
      if (event.ctrlKey) {
        const panels: Record<string, PanelId> = { g: "changes", d: "overlays", f: "search", k: "chat" };
        const chosen = panels[event.key.toLowerCase()];
        if (chosen) {
          event.preventDefault();
          setPanel((current) => (current === chosen ? null : chosen));
        }
        return;
      }
      if (event.metaKey || event.altKey) return;
      const viewForKey = views.find((candidate) => candidate.key === event.key);
      if (viewForKey) return setView(viewForKey.id);
      switch (event.key) {
        case "Escape":
          if (edgeCursor) setEdgeCursor(null);
          else if (walkIndex !== null) setWalkIndex(null);
          else if (isolateId) setIsolateId(null);
          else setSelectedIds([]);
          setHighlightState([]);
          break;
        case "w":
          if (model.narrative?.walkthrough.length) playStep(walkIndex === null ? 0 : walkIndex);
          break;
        case "ArrowRight":
        case "ArrowLeft":
        case "ArrowUp":
        case "ArrowDown": {
          if (walkIndex !== null && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
            const steps = model.narrative?.walkthrough.length ?? 1;
            playStep(event.key === "ArrowRight" ? Math.min(walkIndex + 1, steps - 1) : Math.max(walkIndex - 1, 0));
            break;
          }
          if (view === "flows") break;
          event.preventDefault();
          const step = event.shiftKey ? 400 : 120;
          const { x, y, zoom } = flow.getViewport();
          const dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
          const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
          void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 120 });
          break;
        }
        case "j":
          stepChange(1);
          break;
        case "k":
          stepChange(-1);
          break;
        case "i":
          if (selectedIds.at(-1)) isolate(isolateId === selectedIds.at(-1) ? null : selectedIds.at(-1)!);
          break;
        case "v": {
          const id = selectedIds.at(-1);
          if (id && model.symbols.has(id)) toggleViewed([id], !review.viewed.includes(id));
          break;
        }
        case "c":
          setShowCode((current) => !current);
          break;
        case "/":
          event.preventDefault();
          setPanel("search");
          break;
        case "=":
        case "+":
          void flow.zoomIn({ duration: 150 });
          break;
        case "-":
          void flow.zoomOut({ duration: 150 });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const api: WorkspaceApi = useMemo(
    () => ({
      model,
      selectedIds,
      highlightIds: new Set(highlight),
      review,
      reveal,
      setHighlight: setHighlightState,
      toggleViewed,
      isolate,
      github,
    }),
    [model, selectedIds, highlight, review, reveal, toggleViewed, isolate, github],
  );

  const primary = selectedIds.at(-1) ?? null;
  const latest = progress.filter((event) => event.key === analysis.key).at(-1);
  const narrative = analysis.narrative;
  const walkStep = walkIndex !== null ? narrative?.walkthrough[walkIndex] : null;

  return (
    <WorkspaceContext.Provider value={api}>
      <div className="workspace">
        <header className="topbar">
          <button className="icon-btn" onClick={onHome} title="Home">
            ⌂
          </button>
          <div className="topbar-title">
            <span className="repo">
              {analysis.pr.owner}/{analysis.pr.repo}
            </span>
            <span className="pr-title" title={analysis.pr.title}>
              #{analysis.pr.number} {analysis.pr.title}
            </span>
          </div>
          <div className="topbar-meta">
            <span className="tag">{analysis.pr.author}</span>
            <span className="tag mono">
              {analysis.pr.headRef} → {analysis.pr.baseRef}
            </span>
            <span className="tag">
              <span className="plus">+{analysis.pr.additions}</span> <span className="minus">−{analysis.pr.deletions}</span> · {analysis.pr.changedFiles} files
            </span>
            {narrative && (
              <>
                <span className="tag">effort {narrative.effort}/5</span>
                <span className={`tag risk-${narrative.risk}`}>risk {narrative.risk}</span>
              </>
            )}
            {analysis.narrativeStatus === "pending" && (
              <span className="tag pending-tag">
                <span className="spinner" /> Claude is explaining…
              </span>
            )}
          </div>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => github.open(analysis.pr.url)}>
            GitHub ↗
          </button>
          <button className="btn ghost small" onClick={() => void window.atlas.exportFile(`${analysis.pr.repo}-${analysis.pr.number}`, "json", JSON.stringify(analysis, null, 2))}>
            Export JSON
          </button>
          <button className="btn ghost small" onClick={onReanalyze} title="Fetch the latest commits and parse again. Claude only runs if the PR's code changed, and then only on what changed.">
            Re-analyze
          </button>
          <button
            className="icon-btn"
            title="Toggle theme"
            onClick={() => void onSaveSettings({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" })}
          >
            ◐
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">
            ⚙
          </button>
        </header>

        <div className="workspace-body">
          <nav className="rail">
            {(
              [
                ["changes", "⑂", "Changes", "^G"],
                ["overlays", "◈", "AI overlays", "^D"],
                ["search", "⌕", "Search", "^F"],
                ["chat", "✦", "Ask", "^K"],
              ] as const
            ).map(([id, icon, label, shortcut]) => (
              <button key={id} className={`rail-btn ${panel === id ? "active" : ""}`} title={`${label} (${shortcut})`} onClick={() => setPanel(panel === id ? null : id)}>
                <span className="rail-icon">{icon}</span>
                {id === "changes" && incoming && <span className="rail-badge">{incoming.commits.length || "↓"}</span>}
                <span className="rail-key">{shortcut}</span>
              </button>
            ))}
          </nav>

          {panel && (
            <aside className="side-panel" style={{ width: sidePanel.width }}>
              {panel === "changes" && (
                <ChangesPanel
                  cursor={cursor}
                  onStep={stepChange}
                  incoming={incoming}
                  refreshing={refreshing}
                  refreshError={refreshError}
                  onPull={onReanalyze}
                  hideTests={hideTests}
                  onShowTests={() => setHideTests(false)}
                />
              )}
              {panel === "overlays" && <OverlaysPanel walkIndex={walkIndex} onPlay={playStep} onRetry={() => void window.atlas.regenerateNarrative(analysis.key)} />}
              {panel === "search" && <SearchPanel />}
              {panel === "chat" && <ChatPanel turns={chat} onTurns={setChat} />}
            </aside>
          )}
          {panel ? (
            <ResizeHandle
              edge="right"
              width={sidePanel.width}
              onResize={sidePanel.setWidth}
              onReset={sidePanel.reset}
              collapseBelow={collapseSidePanelBelow}
              onCollapse={() => setPanel(null)}
            />
          ) : (
            // Closed: the edge stays grabbable, and dragging it out reopens the last panel at its previous width.
            <ResizeHandle
              edge="right"
              width={0}
              onResize={(width) => width > reopenSidePanelAfter && setPanel(lastPanel.current)}
              onReset={() => setPanel(lastPanel.current)}
            />
          )}

          <main className="stage">
            <div className="toolbar">
              <div className="toolbar-group">
                <button className="icon-btn" onClick={() => navigateHistory(-1)} title="Back (⌘[)">
                  ←
                </button>
                <button className="icon-btn" onClick={() => navigateHistory(1)} title="Forward (⌘])">
                  →
                </button>
              </div>
              <div className="segmented">
                {views.map((candidate) => (
                  <button key={candidate.id} className={view === candidate.id ? "active" : ""} onClick={() => setView(candidate.id)} title={`${candidate.label} (${candidate.key})`}>
                    {candidate.label}
                  </button>
                ))}
              </div>
              {view !== "flows" && (
                <>
                  <div className="toolbar-group">
                    <button className="icon-btn" onClick={() => void flow.zoomOut({ duration: 150 })} title="Zoom out (−)">
                      −
                    </button>
                    <button className="icon-btn" onClick={() => void flow.fitView({ duration: 250, padding: 0.12 })} title="Fit">
                      ⤢
                    </button>
                    <button className="icon-btn" onClick={() => void flow.zoomIn({ duration: 150 })} title="Zoom in (+)">
                      +
                    </button>
                  </div>
                  <div className="segmented">
                    {(
                      [
                        ["changed", "Changed"],
                        ["context", "With context"],
                        ["all", "All"],
                      ] as const
                    ).map(([value, label]) => (
                      <button key={value} className={scope === value && !isolateId ? "active" : ""} onClick={() => { setIsolateId(null); setScope(value); }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="toolbar-group toggles">
                    {view === "code" && (
                      <label className="toggle small">
                        <input type="checkbox" checked={showCode} onChange={(event) => setShowCode(event.target.checked)} /> code
                      </label>
                    )}
                    <label className="toggle small">
                      <input type="checkbox" checked={hideTests} onChange={(event) => setHideTests(event.target.checked)} /> hide tests
                    </label>
                  </div>
                </>
              )}
            </div>

            {edgeCursor &&
              view !== "flows" &&
              (() => {
                const edge = spec.edges.find((candidate) => candidate.id === edgeCursor.edgeIds[edgeCursor.index]);
                return edge ? (
                  <EdgePeek
                    nodeId={edgeCursor.direction === "out" ? edge.target : edge.source}
                    edgeEnds={[edge.source, edge.target]}
                    direction={edgeCursor.direction}
                    position={`${edgeCursor.index + 1}/${edgeCursor.edgeIds.length}`}
                  />
                ) : null;
              })()}

            {isolateId && (
              <div className="isolate-banner">
                Isolated: <strong>{model.symbols.get(isolateId)?.name ?? model.components.get(isolateId)?.label ?? isolateId}</strong> and what it touches
                {findingUsages && (
                  <span className="muted small">
                    <span className="spinner" /> Finding where it's used across the repo…
                  </span>
                )}
                <button className="link small" onClick={() => setIsolateId(null)}>
                  Stop isolating (esc)
                </button>
              </div>
            )}

            {view === "flows" ? (
              <FlowView flowId={flowId} stepId={flowStepId} onFlowChange={setFlowId} onStepChange={setFlowStepId} />
            ) : (
              <Canvas
                spec={spec}
                edgeCursor={
                  edgeCursor
                    ? (() => {
                        const edge = spec.edges.find((candidate) => candidate.id === edgeCursor.edgeIds[edgeCursor.index]);
                        return edge
                          ? { edgeId: edge.id, targetId: edgeCursor.direction === "out" ? edge.target : edge.source, position: `${edgeCursor.index + 1}/${edgeCursor.edgeIds.length}` }
                          : null;
                      })()
                    : null
                }
                focus={focus}
                exportName={`${analysis.pr.repo}-${analysis.pr.number}-${view}`}
                onSelect={selectOnCanvas}
                onIsolate={(id) => isolate(id.startsWith("file:") ? null : id)}
                onClear={() => {
                  setSelectedIds([]);
                  setHighlightState([]);
                }}
              />
            )}

            {walkStep && narrative && (
              <div className="walk-bar">
                <button className="icon-btn" onClick={() => playStep(Math.max((walkIndex ?? 0) - 1, 0))} disabled={walkIndex === 0}>
                  ‹
                </button>
                <div className="walk-text">
                  <div className="walk-heading">{walkStep.heading}</div>
                  <div className="walk-body">{walkStep.body}</div>
                </div>
                <span className="muted small">
                  {(walkIndex ?? 0) + 1}/{narrative.walkthrough.length}
                </span>
                <button className="icon-btn" onClick={() => playStep(Math.min((walkIndex ?? 0) + 1, narrative.walkthrough.length - 1))} disabled={walkIndex === narrative.walkthrough.length - 1}>
                  ›
                </button>
                <button
                  className="icon-btn"
                  onClick={() => {
                    setWalkIndex(null);
                    setHighlightState([]);
                  }}
                >
                  ×
                </button>
              </div>
            )}

            {latest && latest.stage === "error" && <div className="toast error">{latest.message}</div>}
          </main>

          {primary && view !== "flows" && (
            <>
              <ResizeHandle edge="left" width={inspector.width} onResize={inspector.setWidth} onReset={inspector.reset} />
              <Inspector id={primary} width={inspector.width} onClose={() => setSelectedIds([])} />
            </>
          )}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
