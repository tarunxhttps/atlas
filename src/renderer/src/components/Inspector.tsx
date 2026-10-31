import { useState } from "react";
import type { NarrativeComponent } from "@shared/narrative";
import type { CallEdge, CodeSymbol } from "@shared/types";
import { useWorkspace } from "../lib/WorkspaceContext";
import { isMarkdownPath } from "@shared/paths";
import { CodeBlock, CodeDiff } from "./CodeDiff";
import { MarkdownFileView } from "./MarkdownPreview";
import { Markdown } from "./Markdown";

interface Props {
  id: string;
  width: number;
  onClose: () => void;
}

export function Inspector({ id, width, onClose }: Props) {
  const { model } = useWorkspace();
  const entity = model.resolve(id);
  return (
    <aside className="inspector" style={{ width }}>
      <button className="icon-btn close" onClick={onClose} title="Close (Esc)">
        ×
      </button>
      {entity?.kind === "symbol" && <SymbolDetails symbol={entity.symbol} />}
      {entity?.kind === "component" && <ComponentDetails component={entity.component} />}
      {entity?.kind === "file" && <FileDetails path={entity.path} />}
      {entity?.kind === "dir" && <DirDetails path={entity.path} />}
      {entity?.kind === "step" && <p className="muted">Step selected in the flow view.</p>}
      {!entity && <p className="muted">Nothing selected.</p>}
    </aside>
  );
}

function SymbolDetails({ symbol }: { symbol: CodeSymbol }) {
  const { model, reveal, isolate, review, toggleViewed, github } = useWorkspace();
  const [traceTab, setTraceTab] = useState<"callers" | "dependencies">("callers");
  const side = symbol.head ?? symbol.base!;
  const viewed = review.viewed.includes(symbol.id);
  const note = model.note(symbol.id);
  const attention = model.attentionFor(symbol.id);
  const callers = model.callers(symbol.id);
  const callees = model.callees(symbol.id);
  const component = model.componentOfSymbol.get(symbol.id);
  const moved = symbol.movedFrom ? model.symbols.get(symbol.movedFrom) : null;

  return (
    <div className="inspector-body">
      <div className="crumbs">
        {symbol.path.split("/").map((part, index, parts) => (
          <span key={index}>
            {part}
            {index < parts.length - 1 && <span className="crumb-sep">/</span>}
          </span>
        ))}
      </div>
      <h2 className="inspector-title">
        <span className={`delta-dot delta-${symbol.delta}`} /> {model.label(symbol)}
      </h2>
      <div className="inspector-tags">
        <span className="tag">{symbol.kind}</span>
        {symbol.delta !== "unchanged" && <span className={`tag delta-${symbol.delta}`}>{symbol.delta}</span>}
        {symbol.formattingOnly && <span className="tag">formatting only</span>}
        {!symbol.inPr && <span className="tag neighbour">outside PR</span>}
        {(symbol.additions > 0 || symbol.deletions > 0) && (
          <span className="tag">
            <span className="plus">+{symbol.additions}</span> <span className="minus">−{symbol.deletions}</span>
          </span>
        )}
        <span className="tag">
          L{side.startLine}–{side.endLine}
        </span>
      </div>
      {moved && (
        <p className="callout">
          Moved from{" "}
          <button className="md-link" onClick={() => reveal(moved.id)}>
            {moved.path}
          </button>{" "}
          with the same body.
        </p>
      )}

      <div className="inspector-actions">
        <button className={`btn small ${viewed ? "" : "primary"}`} onClick={() => toggleViewed([symbol.id], !viewed)}>
          {viewed ? "✓ Viewed" : "Mark viewed (v)"}
        </button>
        <button className="btn ghost small" onClick={() => isolate(symbol.id)}>
          Isolate (i)
        </button>
        <button
          className="btn ghost small"
          onClick={() => github.open(github.blob(symbol.path, symbol.head ? "head" : "base", side.startLine, side.endLine))}
        >
          GitHub ↗
        </button>
        {symbol.inPr && (
          <button className="btn ghost small" onClick={() => void github.prDiff(symbol.path).then((url) => github.open(url))}>
            PR diff ↗
          </button>
        )}
        {component && (
          <button className="btn ghost small" onClick={() => reveal(component)}>
            In architecture
          </button>
        )}
      </div>

      <div className="signature">
        <div className="section-label">Signature</div>
        <code>{side.signature}</code>
        {symbol.base && symbol.head && symbol.base.signature !== symbol.head.signature && (
          <div className="signature-before">
            was <code>{symbol.base.signature}</code>
          </div>
        )}
      </div>

      {(note || attention.length > 0) && (
        <div className="ai-note">
          <div className="section-label">Claude</div>
          {note && <Markdown text={note} />}
          {attention.map((item) => (
            <div key={item.id} className={`attention severity-${item.severity}`}>
              <span className="badge">{item.severity}</span> <Markdown text={item.note} />
            </div>
          ))}
        </div>
      )}

      <div className="trace">
        <div className="trace-tabs">
          <button className={traceTab === "callers" ? "active" : ""} onClick={() => setTraceTab("callers")}>
            ← Callers & users {callers.length}
          </button>
          <button className={traceTab === "dependencies" ? "active" : ""} onClick={() => setTraceTab("dependencies")}>
            Dependencies {callees.length} →
          </button>
        </div>
        <TraceList edges={traceTab === "callers" ? callers : callees} direction={traceTab} />
      </div>

      {symbol.delta === "unchanged" ? (
        // Nothing changed here (outside the PR, or untouched in a PR file), so a diff would show the same code twice.
        symbol.kind !== "class" && (symbol.head ?? symbol.base) ? (
          <div className="inspector-diff">
            <div className="section-label">Code</div>
            <CodeBlock code={(symbol.head ?? symbol.base)!.code} startLine={(symbol.head ?? symbol.base)!.startLine} />
          </div>
        ) : null
      ) : (
        <div className="inspector-diff">
          <div className="section-label">{symbol.delta === "added" ? "New code" : symbol.delta === "removed" ? "Removed code" : "Before → After"}</div>
          <CodeDiff
            key={symbol.id}
            before={symbol.base && symbol.delta !== "added" ? { code: symbol.base.code, startLine: symbol.base.startLine } : null}
            after={symbol.head ? { code: symbol.head.code, startLine: symbol.head.startLine } : null}
          />
        </div>
      )}
    </div>
  );
}

function TraceList({ edges, direction }: { edges: CallEdge[]; direction: "callers" | "dependencies" }) {
  const { model, reveal } = useWorkspace();
  if (edges.length === 0) return <p className="muted small">{direction === "callers" ? "Nothing in the map calls this." : "This doesn't call anything in the map."}</p>;
  const grouped = new Map<string, { edge: CallEdge; symbol: CodeSymbol }[]>();
  for (const edge of edges) {
    const symbol = model.symbols.get(direction === "callers" ? edge.from : edge.to);
    if (!symbol) continue;
    grouped.set(symbol.path, [...(grouped.get(symbol.path) ?? []), { edge, symbol }]);
  }
  return (
    <div className="trace-list">
      {[...grouped.entries()].map(([path, items]) => (
        <div key={path} className="trace-file">
          <div className="trace-path">{path}</div>
          {items.map(({ edge, symbol }) => (
            <button key={edge.id} className="trace-item" onClick={() => reveal(symbol.id)}>
              <span className={`delta-dot delta-${symbol.delta}`} />
              <span className="trace-name">{model.label(symbol)}</span>
              {edge.kind === "reference" && <span className="badge subtle">uses</span>}
              {edge.delta !== "unchanged" && <span className={`badge delta-${edge.delta}`}>{edge.kind === "reference" ? "use" : "call"} {edge.delta}</span>}
              {edge.dangling && <span className="badge delta-removed">calls removed code</span>}
              {edge.confidence === "name-match" && <span className="badge subtle">by name</span>}
              {!symbol.inPr && <span className="badge neighbour">outside PR</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ComponentDetails({ component }: { component: NarrativeComponent }) {
  const { model, reveal, isolate } = useWorkspace();
  const edges = model.narrative?.componentEdges.filter((edge) => edge.from === component.id || edge.to === component.id) ?? [];
  return (
    <div className="inspector-body">
      <div className="crumbs">{model.narrative?.lanes.find((lane) => lane.id === component.lane)?.label}</div>
      <h2 className="inspector-title">
        <span className={`delta-dot delta-${component.delta}`} /> {component.label}
      </h2>
      <div className="inspector-tags">
        <span className="tag">{component.kind}</span>
        {component.delta !== "unchanged" && <span className={`tag delta-${component.delta}`}>{component.delta}</span>}
      </div>
      <div className="inspector-actions">
        <button className="btn ghost small" onClick={() => isolate(component.id)}>
          Isolate (i)
        </button>
      </div>
      <Markdown text={component.summary} />
      {component.symbolIds.length > 0 && (
        <>
          <div className="section-label">Code in this component</div>
          <div className="trace-list">
            {component.symbolIds.map((id) => {
              const symbol = model.symbols.get(id)!;
              return (
                <button key={id} className="trace-item" onClick={() => reveal(id)}>
                  <span className={`delta-dot delta-${symbol.delta}`} />
                  <span className="trace-name">{model.label(symbol)}</span>
                  <span className="muted small">{symbol.path}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {component.paths.length > 0 && (
        <>
          <div className="section-label">Paths</div>
          <ul className="plain-list">
            {component.paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {edges.length > 0 && (
        <>
          <div className="section-label">Connections</div>
          <div className="trace-list">
            {edges.map((edge) => {
              const otherId = edge.from === component.id ? edge.to : edge.from;
              return (
                <button key={edge.id} className="trace-item" onClick={() => reveal(otherId)}>
                  <span className={`delta-dot delta-${edge.delta}`} />
                  <span className="trace-name">
                    {edge.from === component.id ? "→" : "←"} {model.components.get(otherId)?.label ?? otherId}
                  </span>
                  <span className="muted small">
                    {edge.kind}
                    {edge.label ? ` · ${edge.label}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function FileDetails({ path }: { path: string }) {
  const { model, reveal, github, review, toggleViewed } = useWorkspace();
  const reviewIds = model.reviewIdsForPath(path);
  const fileViewed = reviewIds.length > 0 && reviewIds.every((id) => review.viewed.includes(id));
  const file = model.files.get(path);
  const symbols = model.analysis.facts.symbols.filter((symbol) => symbol.path === path && symbol.kind !== "class");
  return (
    <div className="inspector-body">
      <div className="crumbs">{path}</div>
      <h2 className="inspector-title">{model.fileLabel(path)}</h2>
      <div className="inspector-tags">
        {file ? <span className={`tag delta-${file.status === "removed" ? "removed" : file.status === "added" ? "added" : "modified"}`}>{file.status}</span> : <span className="tag neighbour">outside PR</span>}
        {file?.previousPath && <span className="tag">from {file.previousPath}</span>}
        {file && (
          <span className="tag">
            <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
          </span>
        )}
      </div>
      <div className="inspector-actions">
        {reviewIds.length > 0 && (
          <button className={`btn small ${fileViewed ? "" : "primary"}`} onClick={() => toggleViewed(reviewIds, !fileViewed)}>
            {fileViewed ? "✓ Viewed" : "Mark file viewed"}
          </button>
        )}
        {file && (
          <button className="btn ghost small" onClick={() => void github.prDiff(path).then((url) => github.open(url))}>
            PR diff ↗
          </button>
        )}
      </div>
      {symbols.length > 0 && (
        <div className="trace-list">
          {symbols.map((symbol) => (
            <button key={symbol.id} className="trace-item" onClick={() => reveal(symbol.id)}>
              <span className={`delta-dot delta-${symbol.delta}`} />
              <span className="trace-name">{model.label(symbol)}</span>
              {(symbol.additions > 0 || symbol.deletions > 0) && (
                <span className="small">
                  <span className="plus">+{symbol.additions}</span> <span className="minus">−{symbol.deletions}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {file && isMarkdownPath(path) && (
        <div className="inspector-diff">
          <div className="section-label">Document</div>
          <MarkdownFileView key={path} file={file} />
        </div>
      )}
      {file && !isMarkdownPath(path) && file.hunks.length > 0 && (
        <div className="inspector-diff">
          <div className="section-label">File diff</div>
          <pre className="hunks">
            {file.hunks.map((hunk, index) => (
              <div key={index}>
                <div className="hunk-header">{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => (
                  <div key={lineIndex} className={`hunk-line ${line.kind}`}>
                    {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    {line.text}
                  </div>
                ))}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

function DirDetails({ path }: { path: string }) {
  const { model, reveal } = useWorkspace();
  const files = model.analysis.facts.files.filter((file) => (file.path.lastIndexOf("/") < 0 ? "" : file.path.slice(0, file.path.lastIndexOf("/"))) === path);
  return (
    <div className="inspector-body">
      <h2 className="inspector-title">{path || "(root)"}/</h2>
      <div className="trace-list">
        {files.map((file) => (
          <button key={file.path} className="trace-item" onClick={() => reveal(file.path)}>
            <span className="trace-name">{model.fileLabel(file.path)}</span>
            <span className="small">
              <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
