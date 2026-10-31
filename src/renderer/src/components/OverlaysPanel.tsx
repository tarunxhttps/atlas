import { useState } from "react";
import { useWorkspace } from "../lib/WorkspaceContext";
import { Markdown } from "./Markdown";

type Tab = "overview" | "walkthrough" | "explain" | "review" | "attention";

interface Props {
  walkIndex: number | null;
  onPlay: (index: number) => void;
  onRetry: () => void;
}

export function OverlaysPanel({ walkIndex, onPlay, onRetry }: Props) {
  const { model, reveal, setHighlight, review, toggleViewed } = useWorkspace();
  const [tab, setTab] = useState<Tab>("overview");
  const { narrativeStatus, narrativeError, narrativeModel } = model.analysis;
  const narrative = model.narrative;

  if (!narrative) {
    return (
      <div className="panel-body">
        <div className="panel-title">AI overlays</div>
        {narrativeStatus === "pending" && (
          <div className="pending">
            <span className="spinner" /> Claude is reading the diff. The map from the parser is already live; the architecture, flows and walkthrough land here when it's done.
          </div>
        )}
        {narrativeStatus === "failed" && (
          <>
            <div className="home-error">{narrativeError}</div>
            <button className="btn primary small" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {narrativeStatus === "disabled" && (
          <button className="btn primary small" onClick={onRetry}>
            Ask Claude to explain this PR
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div className="panel-title">AI overlays</div>
      <div className="tabs">
        {(["overview", "walkthrough", "explain", "review", "attention"] as const).map((value) => (
          <button key={value} className={`tab ${tab === value ? "active" : ""}`} onClick={() => setTab(value)}>
            {value === "review" ? "order" : value}
            {value === "attention" && narrative.attention.length > 0 ? ` ${narrative.attention.length}` : ""}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="overview">
          <h3>{narrative.title}</h3>
          <div className="scores">
            <span className="score">
              Effort <strong>{narrative.effort}/5</strong>
            </span>
            <span className={`score risk-${narrative.risk}`}>
              Risk <strong>{narrative.risk}</strong>
            </span>
          </div>
          <p className="muted small">{narrative.riskReason}</p>
          <Markdown text={narrative.summary} />
          {narrative.chips.length > 0 && (
            <div className="stat-chips">
              {narrative.chips.map((chip) => (
                <div key={chip.label} className="stat-chip">
                  <div className="stat-value">{chip.value}</div>
                  <div className="stat-label">{chip.label}</div>
                </div>
              ))}
            </div>
          )}
          <p className="muted tiny">
            Written by {narrativeModel}. Everything on the map itself comes from the parser; this text is Claude's reading of it.
          </p>
          <button className="btn ghost small" onClick={onRetry}>
            Regenerate
          </button>
        </div>
      )}

      {tab === "walkthrough" && (
        <div className="walk-list">
          <button className="btn primary small" onClick={() => onPlay(0)}>
            ▶ Play walkthrough (w)
          </button>
          {narrative.walkthrough.map((step, index) => (
            <button key={step.id} className={`walk-item ${walkIndex === index ? "active" : ""}`} onClick={() => onPlay(index)}>
              <span className="walk-number">{index + 1}</span>
              <span>
                <strong>{step.heading}</strong>
                <span className="muted small block">{step.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tab === "explain" && (
        <div className="explain">
          <Markdown text={narrative.explanation} />
        </div>
      )}

      {tab === "review" && (
        <div className="review-order">
          <p className="muted small">Read the change in this order: contracts and data shapes first, then what uses them.</p>
          {narrative.reviewOrder.map((layer, index) => {
            const done = layer.symbolIds.length > 0 && layer.symbolIds.every((id) => review.viewed.includes(id));
            return (
              <div key={layer.id} className={`layer ${done ? "done" : ""}`}>
                <div className="layer-head" onMouseEnter={() => setHighlight(layer.symbolIds)} onMouseLeave={() => setHighlight([])}>
                  <span className="walk-number">{index + 1}</span>
                  <strong>{layer.title}</strong>
                  {layer.symbolIds.length > 0 && (
                    <button className="link small" onClick={() => toggleViewed(layer.symbolIds, !done)}>
                      {done ? "✓ viewed" : "mark viewed"}
                    </button>
                  )}
                </div>
                <p className="muted small">{layer.reason}</p>
                <div className="layer-items">
                  {layer.symbolIds.map((id) => {
                    const symbol = model.symbols.get(id)!;
                    return (
                      <button key={id} className="chip-link" onClick={() => reveal(id)}>
                        <span className={`delta-dot delta-${symbol.delta}`} /> {symbol.name}
                        {review.viewed.includes(id) ? " ✓" : ""}
                      </button>
                    );
                  })}
                  {layer.paths.map((path) => (
                    <button key={path} className="chip-link" onClick={() => reveal(path)}>
                      ▤ {path.split("/").pop()}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "attention" && (
        <div className="attention-list">
          {narrative.attention.length === 0 && <p className="muted small">Nothing flagged.</p>}
          {narrative.attention.map((item) => (
            <div key={item.id} className={`attention severity-${item.severity}`}>
              <div className="attention-head">
                <span className="badge">{item.severity}</span>
                {item.symbolId && (
                  <button className="md-link" onClick={() => reveal(item.symbolId!)}>
                    {model.symbols.get(item.symbolId)?.name}
                  </button>
                )}
                {!item.symbolId && item.path && (
                  <button className="md-link" onClick={() => reveal(item.path!)}>
                    {item.path}
                  </button>
                )}
              </div>
              <Markdown text={item.note} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
