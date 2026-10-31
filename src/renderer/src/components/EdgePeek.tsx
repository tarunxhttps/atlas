import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import type { CodeSymbol } from "@shared/types";
import { changePreview } from "../lib/codePreview";
import { useWorkspace } from "../lib/WorkspaceContext";

interface Props {
  /** Canvas node at the other end of the highlighted line; files are `file:<path>`. */
  nodeId: string;
  /** Both ends of the picked line; the box keeps clear of them. */
  edgeEnds: [string, string];
  direction: "out" | "in";
  position: string;
}

type Side = "below" | "above" | "right" | "left";
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const maxLines = 400;
const gap = 14;
// Room for the canvas toolbar above and the legend below.
const topClear = 112;
const bottomClear = 70;
const sideClear = 12;

/**
 * Places the box right next to the picked line, like a popover: below, above, right or left of it,
 * whichever fits on the canvas without covering the two cards. Re-runs as the view pans and zooms.
 */
function useBesideEdge(edgeEnds: [string, string], box: React.RefObject<HTMLDivElement | null>): { left: number; top: number; side: Side } | null {
  const flow = useReactFlow();
  const viewport = useViewport();
  const [placement, setPlacement] = useState<{ left: number; top: number; side: Side } | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    const stage = element?.parentElement?.getBoundingClientRect();
    if (!element || !stage) return;
    const cards = edgeEnds.map((id) => {
      const node = flow.getInternalNode(id);
      if (!node) return null;
      const { x, y } = node.internals.positionAbsolute;
      const topLeft = flow.flowToScreenPosition({ x, y });
      const bottomRight = flow.flowToScreenPosition({ x: x + (node.width ?? 0), y: y + (node.height ?? 0) });
      return { left: topLeft.x - stage.left, top: topLeft.y - stage.top, right: bottomRight.x - stage.left, bottom: bottomRight.y - stage.top };
    });
    if (cards.some((card) => card === null)) return;
    const [a, b] = cards as Rect[];
    const bounds = { left: sideClear, top: topClear, right: stage.width - sideClear, bottom: stage.height - bottomClear };
    // The line runs between the two cards; keep to the part of it that's on screen.
    const line: Rect = {
      left: Math.max(Math.min(a.left, b.left), bounds.left),
      top: Math.max(Math.min(a.top, b.top), bounds.top),
      right: Math.min(Math.max(a.right, b.right), bounds.right),
      bottom: Math.min(Math.max(a.bottom, b.bottom), bounds.bottom),
    };
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const centerX = (line.left + line.right) / 2;
    const centerY = (line.top + line.bottom) / 2;
    const options: { side: Side; left: number; top: number }[] = [
      { side: "below", left: clamp(centerX - width / 2, bounds.left, bounds.right - width), top: line.bottom + gap },
      { side: "above", left: clamp(centerX - width / 2, bounds.left, bounds.right - width), top: line.top - gap - height },
      { side: "right", left: line.right + gap, top: clamp(centerY - height / 2, bounds.top, bounds.bottom - height) },
      { side: "left", left: line.left - gap - width, top: clamp(centerY - height / 2, bounds.top, bounds.bottom - height) },
    ];
    const covered = (rect: Rect, target: Rect) =>
      Math.max(0, Math.min(rect.right, target.right) - Math.max(rect.left, target.left)) * Math.max(0, Math.min(rect.bottom, target.bottom) - Math.max(rect.top, target.top));
    const overflow = (rect: Rect) =>
      Math.max(0, bounds.left - rect.left) + Math.max(0, rect.right - bounds.right) + Math.max(0, bounds.top - rect.top) + Math.max(0, rect.bottom - bounds.bottom);
    // Fitting on the canvas comes first, then not covering the cards; ties keep the order below/above/right/left.
    const score = (option: { left: number; top: number }) => {
      const rect = { left: option.left, top: option.top, right: option.left + width, bottom: option.top + height };
      return overflow(rect) * 1000 + covered(rect, a) + covered(rect, b);
    };
    const best = options.reduce((winner, option) => (score(option) < score(winner) ? option : winner));
    // An option that doesn't fit is pulled back inside the canvas.
    const left = clamp(best.left, bounds.left, bounds.right - width);
    const top = clamp(best.top, bounds.top, bounds.bottom - height);
    if (!placement || Math.abs(placement.left - left) > 1 || Math.abs(placement.top - top) > 1 || placement.side !== best.side) {
      setPlacement({ left, top, side: best.side });
    }
  }, [edgeEnds, viewport, flow, box, placement]);

  return placement;
}

export function EdgePeek({ nodeId, edgeEnds, direction, position }: Props) {
  const { model } = useWorkspace();
  const entity = model.resolve(nodeId.startsWith("file:") ? nodeId.slice(5) : nodeId);
  const box = useRef<HTMLDivElement>(null);
  const placement = useBesideEdge(edgeEnds, box);

  return (
    <div
      ref={box}
      className={`edge-peek ${placement?.side ?? ""}`}
      style={placement ? { left: placement.left, top: placement.top } : { visibility: "hidden", left: 0, top: 0 }}
    >
      <div className="peek-head">
        <span className="muted small">
          {direction === "out" ? "Calls →" : "← Called by"} {position}
        </span>
        <span className="muted tiny">Enter to go · ⌘{direction === "out" ? "→" : "←"} next · Esc</span>
      </div>
      {entity?.kind === "symbol" && <SymbolPeek symbol={entity.symbol} />}
      {entity?.kind === "file" && <FilePeek path={entity.path} />}
      {entity?.kind === "component" && (
        <>
          <div className="peek-title">{entity.component.label}</div>
          <div className="muted small">
            {entity.component.kind} · {entity.component.delta}
          </div>
          <p className="peek-summary">{entity.component.summary.split("\n")[0]}</p>
        </>
      )}
      {!entity && <div className="peek-title">{nodeId.replace(/^dir:/, "")}/</div>}
    </div>
  );
}

function SymbolPeek({ symbol }: { symbol: CodeSymbol }) {
  const { model } = useWorkspace();
  const side = symbol.head ?? symbol.base!;
  const lines = useMemo(() => changePreview(symbol, maxLines), [symbol]);
  return (
    <>
      <div className="peek-title">
        <span className={`delta-dot delta-${symbol.delta}`} /> {model.label(symbol)}
      </div>
      <div className="peek-meta">
        <span className="muted small">{symbol.path}</span>
        {!symbol.inPr && <span className="badge neighbour">outside PR</span>}
        {symbol.delta !== "unchanged" && <span className={`badge delta-${symbol.delta}`}>{symbol.formattingOnly ? "format" : symbol.delta}</span>}
        {(symbol.additions > 0 || symbol.deletions > 0) && (
          <span className="small">
            <span className="plus">+{symbol.additions}</span> <span className="minus">−{symbol.deletions}</span>
          </span>
        )}
      </div>
      <code className="peek-signature">{side.signature}</code>
      <pre className="peek-code">
        {lines.map((line, index) => (
          <div key={index} className={`hunk-line ${line.kind}`}>
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            {line.text}
          </div>
        ))}
      </pre>
    </>
  );
}

function FilePeek({ path }: { path: string }) {
  const { model } = useWorkspace();
  const file = model.files.get(path);
  const changed = model.changedSymbols.filter((symbol) => symbol.path === path);
  return (
    <>
      <div className="peek-title">▤ {path.split("/").pop()}</div>
      <div className="peek-meta">
        <span className="muted small">{path}</span>
        {file ? <span className="badge delta-modified">{file.status}</span> : <span className="badge neighbour">outside PR</span>}
        {file && (
          <span className="small">
            <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
          </span>
        )}
      </div>
      {changed.length > 0 && (
        <div className="peek-list">
          {changed.slice(0, 6).map((symbol) => (
            <div key={symbol.id} className="small">
              <span className={`delta-dot delta-${symbol.delta}`} /> {model.label(symbol)}
            </div>
          ))}
          {changed.length > 6 && <div className="muted small">and {changed.length - 6} more</div>}
        </div>
      )}
    </>
  );
}
