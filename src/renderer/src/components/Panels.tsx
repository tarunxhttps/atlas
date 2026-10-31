import { useMemo, useState } from "react";
import { isTestPath } from "@shared/paths";
import type { ChangedFile, CodeSymbol, PrUpdate } from "@shared/types";
import { useWorkspace } from "../lib/WorkspaceContext";

interface ChangesProps {
  cursor: number;
  onStep: (direction: 1 | -1) => void;
  /** Set only when GitHub's head differs from the analysed one. */
  incoming: PrUpdate | null;
  refreshing: boolean;
  refreshError: string | null;
  onPull: () => void;
  /** Mirrors the canvas toggle so the list and the map agree. */
  hideTests: boolean;
  onShowTests: () => void;
}

export function ChangesPanel({ cursor, onStep, incoming, refreshing, refreshError, onPull, hideTests, onShowTests }: ChangesProps) {
  const { model, review, toggleViewed } = useWorkspace();
  const [kind, setKind] = useState<"all" | "functions" | "classes">("all");
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const reviewable = model.reviewableIds();
  const viewedCount = reviewable.filter((id) => review.viewed.includes(id)).length;
  const allFiles = model.analysis.facts.files;
  const files = useMemo(() => (hideTests ? allFiles.filter((file) => !isTestPath(file.path)) : allFiles), [allFiles, hideTests]);
  const hiddenTests = allFiles.length - files.length;
  const visibleChanges = hideTests ? model.changedSymbols.filter((symbol) => !isTestPath(symbol.path)) : model.changedSymbols;
  const position = cursor >= 0 ? visibleChanges.indexOf(model.changedSymbols[cursor]) : -1;
  const byDir = useMemo(() => {
    const groups = new Map<string, ChangedFile[]>();
    for (const file of files) {
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      groups.set(dir, [...(groups.get(dir) ?? []), file]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const symbolVisible = (symbol: CodeSymbol) =>
    (showUnchanged || symbol.delta !== "unchanged") &&
    (kind === "all" || (kind === "classes" ? symbol.kind === "class" : symbol.kind !== "class"));

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  return (
    <div className="panel-body">
      <div className="panel-title">Changes</div>
      <IncomingBanner incoming={incoming} refreshing={refreshing} refreshError={refreshError} onPull={onPull} />
      <div className="panel-summary">
        {visibleChanges.length} changed scopes · {files.length} files
        {hiddenTests > 0 && (
          <span className="muted small">
            {" "}
            · {hiddenTests} test file{hiddenTests === 1 ? "" : "s"} hidden{" "}
            <button className="link small" onClick={onShowTests}>
              show
            </button>
          </span>
        )}
        <div className="progress">
          <div className="progress-bar" style={{ width: `${reviewable.length ? (viewedCount / reviewable.length) * 100 : 0}%` }} />
        </div>
        <span className="muted small">
          {viewedCount}/{reviewable.length} viewed
          {review.changedSinceViewed.length > 0 && <span className="changed-since"> · {review.changedSinceViewed.length} changed since you viewed them</span>}
        </span>
        {!review.githubSync.ok && <div className="sync-line error">⚠ {review.githubSync.message}</div>}
      </div>
      <div className="panel-nav">
        <button className="icon-btn" onClick={() => onStep(-1)} title="Previous change (k)">
          ‹
        </button>
        <span className="muted small">
          {position >= 0 ? position + 1 : "–"}/{visibleChanges.length}
        </span>
        <button className="icon-btn" onClick={() => onStep(1)} title="Next change (j)">
          ›
        </button>
        <span className="spacer" />
        <label className="toggle small">
          <input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} /> unchanged
        </label>
      </div>
      <div className="segmented small full">
        {(["all", "functions", "classes"] as const).map((value) => (
          <button key={value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
            {value}
          </button>
        ))}
      </div>

      <div className="tree">
        {byDir.map(([dir, dirFiles]) => (
          <div key={dir} className="tree-dir">
            <button className="tree-row dir" onClick={() => toggle(dir)}>
              <span className="caret">{collapsed.has(dir) ? "▸" : "▾"}</span>
              <span className="tree-name">{dir || "(root)"}/</span>
            </button>
            {!collapsed.has(dir) &&
              dirFiles.map((file) => (
                <FileRow key={file.path} file={file} collapsed={collapsed.has(file.path)} onToggle={() => toggle(file.path)} symbolVisible={symbolVisible} />
              ))}
          </div>
        ))}
      </div>

      {model.analysis.facts.notes.length > 0 && (
        <div className="panel-notes">
          {model.analysis.facts.notes.map((note) => (
            <p key={note} className="muted small">
              {note}
            </p>
          ))}
        </div>
      )}
      <button className="btn ghost small" onClick={() => toggleViewed(reviewable, viewedCount < reviewable.length)}>
        {viewedCount < reviewable.length ? "Mark all viewed" : "Clear viewed"}
      </button>
    </div>
  );
}

function FileRow({
  file,
  collapsed,
  onToggle,
  symbolVisible,
}: {
  file: ChangedFile;
  collapsed: boolean;
  onToggle: () => void;
  symbolVisible: (symbol: CodeSymbol) => boolean;
}) {
  const { model, reveal, selectedIds, review, toggleViewed } = useWorkspace();
  const roots = model.analysis.facts.symbols.filter((symbol) => symbol.path === file.path && symbol.inPr && !symbol.parentId);
  const status = file.status === "added" ? "added" : file.status === "removed" ? "removed" : "modified";
  const ids = model.reviewIdsForPath(file.path);
  const viewedCount = ids.filter((id) => review.viewed.includes(id)).length;
  return (
    <div className="tree-file">
      <div className={`tree-row file ${selectedIds.includes(file.path) ? "selected" : ""} ${file.excluded ? "excluded" : ""}`}>
        {ids.length > 0 ? (
          <input
            type="checkbox"
            className="viewed-box"
            title="Viewed (in Atlas only)"
            checked={viewedCount === ids.length}
            ref={(box) => {
              if (box) box.indeterminate = viewedCount > 0 && viewedCount < ids.length;
            }}
            onChange={(event) => toggleViewed(ids, event.target.checked)}
          />
        ) : (
          <span className="viewed-box-spacer" />
        )}
        <button className="caret-btn" onClick={onToggle}>
          {roots.length > 0 ? (collapsed ? "▸" : "▾") : " "}
        </button>
        <button className="tree-name-btn" onClick={() => reveal(file.path)}>
          ▤ {file.path.split("/").pop()}
        </button>
        <span className="line-counts">
          <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
        </span>
        <span className={`badge delta-${status}`}>{file.status}</span>
      </div>
      {!collapsed && roots.map((symbol) => <SymbolRow key={symbol.id} symbol={symbol} depth={1} symbolVisible={symbolVisible} />)}
    </div>
  );
}

function SymbolRow({ symbol, depth, symbolVisible }: { symbol: CodeSymbol; depth: number; symbolVisible: (symbol: CodeSymbol) => boolean }) {
  const { model, reveal, selectedIds, review, toggleViewed } = useWorkspace();
  const children = model.children(symbol.id);
  const childRows = children.map((child) => <SymbolRow key={child.id} symbol={child} depth={depth + 1} symbolVisible={symbolVisible} />);
  const hasVisibleDescendant = (current: CodeSymbol): boolean => model.children(current.id).some((child) => symbolVisible(child) || hasVisibleDescendant(child));
  if (!symbolVisible(symbol) && !hasVisibleDescendant(symbol)) return null;
  const viewed = review.viewed.includes(symbol.id);
  return (
    <>
      <div className={`tree-row symbol ${selectedIds.includes(symbol.id) ? "selected" : ""}`} style={{ paddingLeft: 10 + depth * 14 }}>
        {symbol.kind !== "class" && symbol.delta !== "unchanged" ? (
          <input type="checkbox" className="viewed-box" checked={viewed} title="Viewed" onChange={(event) => toggleViewed([symbol.id], event.target.checked)} />
        ) : (
          <span className="viewed-box-spacer" />
        )}
        <button className="tree-name-btn" onClick={() => reveal(symbol.id)}>
          <span className="kind-icon">{symbol.kind === "class" ? "◇" : symbol.kind === "method" ? "{}" : "ƒ"}</span> {symbol.name}
        </button>
        {(symbol.additions > 0 || symbol.deletions > 0) && (
          <span className="line-counts">
            {symbol.additions > 0 && <span className="plus">+{symbol.additions}</span>} {symbol.deletions > 0 && <span className="minus">−{symbol.deletions}</span>}
          </span>
        )}
        {review.changedSinceViewed.includes(symbol.id) && <span className="badge changed-badge" title="You marked this viewed, then a new commit changed it">changed</span>}
        {symbol.delta !== "unchanged" && <span className={`badge delta-${symbol.delta}`}>{symbol.formattingOnly ? "format" : symbol.movedFrom ? "moved" : symbol.delta}</span>}
      </div>
      {childRows}
    </>
  );
}

/** Silent while up to date; like VS Code's sync button, it only appears once there are commits to pull. */
function IncomingBanner({ incoming, refreshing, refreshError, onPull }: Pick<ChangesProps, "incoming" | "refreshing" | "refreshError" | "onPull">) {
  const [showCommits, setShowCommits] = useState(false);
  if (refreshing) {
    return (
      <div className="incoming pulling">
        <span className="spinner" /> Pulling the latest commits…
      </div>
    );
  }
  if (refreshError) return <div className="home-error">{refreshError}</div>;
  if (!incoming) return null;
  const count = incoming.commits.length;
  return (
    <div className="incoming">
      <button className="btn primary small pull-btn" onClick={onPull} title="Pull the new commits and re-map the PR">
        ↓ {incoming.forcePushed ? "Force-pushed" : `${count} commit${count === 1 ? "" : "s"}`}
      </button>
      {count > 0 && (
        <button className="link small" onClick={() => setShowCommits(!showCommits)}>
          {showCommits ? "hide" : "show"}
        </button>
      )}
      {showCommits && (
        <ul className="incoming-commits">
          {incoming.commits.slice(0, 8).map((commit) => (
            <li key={commit.sha}>
              <code>{commit.sha.slice(0, 7)}</code> <span className="commit-message">{commit.message}</span>
              <span className="muted small block">
                {commit.author} · {timeAgo(commit.date)}
              </span>
            </li>
          ))}
          {count > 8 && <li className="muted small">and {count - 8} more</li>}
        </ul>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SearchPanel() {
  const { model, reveal } = useWorkspace();
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const symbols = model.analysis.facts.symbols
      .filter((symbol) => symbol.qualifiedName.toLowerCase().includes(needle) || symbol.path.toLowerCase().includes(needle))
      .slice(0, 80)
      .map((symbol) => ({ id: symbol.id, title: model.label(symbol), sub: symbol.path, delta: symbol.delta }));
    const components = [...model.components.values()]
      .filter((component) => component.label.toLowerCase().includes(needle))
      .map((component) => ({ id: component.id, title: component.label, sub: `component · ${component.kind}`, delta: component.delta }));
    return [...components, ...symbols];
  }, [query, model]);

  return (
    <div className="panel-body">
      <div className="panel-title">Search</div>
      <input
        autoFocus
        className="text-input"
        placeholder="Function, class, file or component"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results[0]) reveal(results[0].id);
        }}
      />
      <div className="trace-list">
        {results.map((result) => (
          <button key={result.id} className="trace-item stacked" onClick={() => reveal(result.id)}>
            <span className="trace-name">
              <span className={`delta-dot delta-${result.delta}`} /> {result.title}
            </span>
            <span className="muted small">{result.sub}</span>
          </button>
        ))}
        {query && results.length === 0 && <p className="muted small">No matches.</p>}
      </div>
    </div>
  );
}
