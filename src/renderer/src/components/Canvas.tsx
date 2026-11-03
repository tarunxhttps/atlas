import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Edge,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import type { Delta } from "@shared/types";
import { ElkLayouter, type PositionedNode } from "../graph/ElkLayouter";
import type { GraphSpec } from "../graph/GraphBuilder";
import { LegendFilter, type LegendKind } from "../graph/LegendFilter";
import { useWorkspace } from "../lib/WorkspaceContext";
import { CallPeek } from "./CallPeek";
import { nodeTypeFor, nodeTypes, type AtlasNode } from "./Nodes";

export interface FocusRequest {
  ids: string[];
  nonce: number;
}

interface Props {
  spec: GraphSpec;
  focus: FocusRequest | null;
  exportName: string;
  onSelect: (id: string, additive: boolean) => void;
  onIsolate: (id: string) => void;
  onClear: () => void;
  /** The line ⌘→ / ⌘← has picked; Enter follows it. */
  edgeCursor: { edgeId: string; targetId: string; position: string } | null;
}

/**
 * The box around the given nodes, from React Flow's absolute positions. fitView({ nodes }) skips nodes it
 * hasn't drawn yet, and off-screen nodes aren't drawn, so focusing on one far away wouldn't move the camera.
 * Small targets are padded to a minimum size so a single card isn't blown up to fill the screen.
 */
function boundsOf(
  ids: string[],
  lookup: (id: string) => { internals: { positionAbsolute: { x: number; y: number } }; width?: number; height?: number } | undefined,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = lookup(id);
    if (!node) continue;
    const { x, y } = node.internals.positionAbsolute;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (node.width ?? 0));
    maxY = Math.max(maxY, y + (node.height ?? 0));
  }
  if (!Number.isFinite(minX)) return null;
  const width = Math.max(maxX - minX, 700);
  const height = Math.max(maxY - minY, 440);
  return { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height };
}

export const deltaColors: Record<Delta, string> = {
  added: "#2ea043",
  modified: "#d29922",
  removed: "#f85149",
  unchanged: "#8b8f98",
};

const layouter = new ElkLayouter();

const legendItems: { kind: LegendKind; label: string }[] = [
  { kind: "added", label: "added" },
  { kind: "modified", label: "modified" },
  { kind: "removed", label: "removed" },
  { kind: "unchanged", label: "unchanged" },
  { kind: "neighbour", label: "outside PR" },
];

export function Canvas({ spec, focus, exportName, onSelect, onIsolate, onClear, edgeCursor }: Props) {
  const { selectedIds, highlightIds, review, model } = useWorkspace();
  const flow = useReactFlow<AtlasNode, Edge>();
  const [positioned, setPositioned] = useState<PositionedNode[]>([]);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [legendOff, setLegendOff] = useState<ReadonlySet<LegendKind>>(new Set());
  const hidden = useMemo(() => new LegendFilter(legendOff).hide(spec), [legendOff, spec]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ id: string; x: number; y: number } | null>(null);
  const [commandHeld, setCommandHeld] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => setCommandHeld(event.metaKey);
    const release = () => setCommandHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
    };
  }, []);

  const trackEdge = (event: React.MouseEvent, edge: Edge) => {
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    setCommandHeld(event.metaKey);
    setHoveredEdge({ id: edge.id, x: event.clientX - box.left, y: event.clientY - box.top });
  };
  const peekCallIds = commandHeld && hoveredEdge ? (spec.edges.find((edge) => edge.id === hoveredEdge.id)?.callIds ?? []) : [];

  const toggleLegend = (kind: LegendKind) =>
    setLegendOff((current) => {
      const next = new Set(current);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  // Read inside effects without re-running them: a selection change alone must not move the camera.
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const positionedRef = useRef<PositionedNode[]>([]);
  const pendingFocus = useRef<FocusRequest | null>(null);

  const fitTo = useCallback(
    (ids: string[]) => {
      // Let React Flow render the new nodes before moving the camera.
      setTimeout(() => {
        const box = boundsOf(ids, (id) => flow.getInternalNode(id));
        if (box) void flow.fitBounds(box, { padding: 0.25, duration: 400 });
        else void flow.fitView({ padding: 0.12, duration: 250, maxZoom: 1.1 });
      }, 60);
    },
    [flow],
  );

  /** Node ids on this canvas for the given entity ids; module view draws files as `file:<path>`. */
  const presentIds = (ids: string[], nodes: PositionedNode[]) => {
    const onCanvas = new Set(nodes.map((node) => node.spec.id));
    return ids.flatMap((id) => [id, `file:${id}`].filter((candidate) => onCanvas.has(candidate)).slice(0, 1));
  };

  useEffect(() => {
    let cancelled = false;
    setLayoutError(null);
    layouter
      .layout(spec)
      .then((result) => {
        if (cancelled) return;
        positionedRef.current = result;
        setPositioned(result);
        // After a re-layout: a pending reveal wins, then the current selection, else the whole diagram.
        const requested = pendingFocus.current ? presentIds(pendingFocus.current.ids, result) : [];
        pendingFocus.current = null;
        fitTo(requested.length > 0 ? requested : presentIds(selectedRef.current, result));
      })
      .catch((error: unknown) => !cancelled && setLayoutError(String(error)));
    return () => {
      cancelled = true;
    };
  }, [spec, fitTo]);

  useEffect(() => {
    if (!focus || focus.ids.length === 0) return;
    const present = presentIds(focus.ids, positionedRef.current);
    // Not on the canvas yet (the reveal also switched level or scope): apply it after the next layout.
    if (present.length === 0) pendingFocus.current = focus;
    else fitTo(present);
  }, [focus, fitTo]);

  // Only a click (or a walkthrough/chat highlight) fades the rest; hovering never does.
  // Selection holds a file's path, while its frame or card on the canvas is `file:<path>`.
  const selectedNodeIds = useMemo(() => new Set(selectedIds.flatMap((id) => [id, `file:${id}`])), [selectedIds]);

  // Lighting a frame lights everything inside it, so its functions and their calls don't fade.
  const active = useMemo(() => {
    const roots = new Set([...selectedNodeIds, ...highlightIds]);
    if (roots.size === 0) return roots;
    const children = new Map<string, string[]>();
    for (const node of spec.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
    const ids = new Set<string>();
    const add = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of children.get(id) ?? []) add(child);
    };
    roots.forEach(add);
    return ids;
  }, [selectedNodeIds, highlightIds, spec]);

  /**
   * In Module view a function is a row inside its file's card, not a node. Selecting one lights its card,
   * the cards of files it calls or is called by, and only the edges between them.
   */
  const chipFocus = useMemo(() => {
    const owner = new Map<string, string>();
    for (const node of spec.nodes) for (const chip of node.chips) owner.set(chip.id, node.id);
    const onCanvas = new Set(spec.nodes.map((node) => node.id));
    const chips = selectedIds.filter((id) => !onCanvas.has(id) && owner.has(id));
    const nodes = new Set<string>();
    const edgePairs = new Set<string>();
    for (const id of chips) {
      const card = owner.get(id)!;
      nodes.add(card);
      for (const edge of [...model.callers(id), ...model.callees(id)]) {
        const other = model.symbols.get(edge.from === id ? edge.to : edge.from);
        const otherCard = other ? `file:${other.path}` : null;
        if (!otherCard || otherCard === card || !onCanvas.has(otherCard)) continue;
        nodes.add(otherCard);
        edgePairs.add(edge.from === id ? `${card}->${otherCard}` : `${otherCard}->${card}`);
      }
    }
    return { chips: new Set(chips), nodes, edgePairs };
  }, [spec, selectedIds, model]);

  const connected = useMemo(() => {
    if (active.size === 0 && chipFocus.nodes.size === 0) return null;
    const ids = new Set([...active, ...chipFocus.nodes]);
    for (const edge of spec.edges) {
      if (active.has(edge.source)) ids.add(edge.target);
      if (active.has(edge.target)) ids.add(edge.source);
    }
    // Keep the containers of anything lit so the file and class frames stay readable.
    const parents = new Map(spec.nodes.map((node) => [node.id, node.parentId]));
    for (const id of [...ids]) {
      let parent = parents.get(id);
      while (parent) {
        ids.add(parent);
        parent = parents.get(parent);
      }
    }
    return ids;
  }, [active, chipFocus, spec]);

  const viewed = useMemo(() => new Set(review.viewed), [review]);

  // Absolute boxes, so edges between cards stacked in one column can leave from the bottom instead of looping round.
  const boxes = useMemo(() => {
    const byId = new Map(positioned.map((placed) => [placed.spec.id, placed]));
    const absolute = new Map<string, { x: number; y: number; width: number }>();
    const resolve = (placed: PositionedNode): { x: number; y: number; width: number } => {
      const cached = absolute.get(placed.spec.id);
      if (cached) return cached;
      const parent = placed.spec.parentId ? byId.get(placed.spec.parentId) : undefined;
      const origin = parent ? resolve(parent) : { x: 0, y: 0 };
      const box = { x: origin.x + placed.x, y: origin.y + placed.y, width: placed.width };
      absolute.set(placed.spec.id, box);
      return box;
    };
    positioned.forEach(resolve);
    return absolute;
  }, [positioned]);

  const nodes: AtlasNode[] = useMemo(
    () =>
      positioned.map((placed) => ({
        id: placed.spec.id,
        type: nodeTypeFor(placed.spec),
        position: { x: placed.x, y: placed.y },
        parentId: placed.spec.parentId ?? undefined,
        width: placed.width,
        height: placed.height,
        style: { width: placed.width, height: placed.height },
        // Hidden in place rather than dropped from the spec, so switching a legend kind off doesn't re-run the layout.
        hidden: hidden.nodes.has(placed.spec.id),
        // Draggable nodes block panning, and frames cover most of the canvas, so nothing drags.
        draggable: false,
        selectable: placed.spec.kind !== "lane",
        zIndex: placed.spec.kind === "lane" || placed.spec.kind === "file-group" ? 0 : placed.spec.kind === "class-group" ? 1 : 2,
        data: {
          spec: placed.spec,
          selected: selectedNodeIds.has(placed.spec.id),
          selectedChips: placed.spec.chips.filter((chip) => chipFocus.chips.has(chip.id)).map((chip) => chip.id),
          highlighted: highlightIds.has(placed.spec.id) || edgeCursor?.targetId === placed.spec.id,
          dimmed: connected !== null && !connected.has(placed.spec.id),
          viewed: viewed.has(placed.spec.id),
        },
      })),
    [positioned, selectedNodeIds, highlightIds, connected, viewed, chipFocus, edgeCursor, hidden],
  );

  const edges: Edge[] = useMemo(
    () =>
      spec.edges.map((edge) => {
        const picked = edgeCursor?.edgeId === edge.id;
        const touches = picked || active.has(edge.source) || active.has(edge.target) || chipFocus.edgePairs.has(`${edge.source}->${edge.target}`);
        const anyFocus = active.size > 0 || chipFocus.nodes.size > 0;
        const color = edge.dangling ? deltaColors.removed : deltaColors[edge.delta];
        const from = boxes.get(edge.source);
        const to = boxes.get(edge.target);
        const sameColumn = from && to && Math.abs(from.x + from.width / 2 - (to.x + to.width / 2)) < Math.min(from.width, to.width) / 2;
        const handles = sameColumn ? (to.y > from.y ? { sourceHandle: "down", targetHandle: "from-above" } : { sourceHandle: "up", targetHandle: "from-below" }) : {};
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...handles,
          hidden: hidden.edges.has(edge.id),
          // While a line is picked with ⌘→/⌘←, it's the only one that moves.
          animated: edgeCursor ? picked : edge.hero || (touches && anyFocus),
          label: picked ? `${edgeCursor.position} · Enter to follow` : edge.label || undefined,
          zIndex: picked ? 1001 : 1000,
          className: `atlas-edge delta-${edge.delta}${edge.dangling ? " dangling" : ""}${picked ? " picked" : ""}`,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          style: {
            stroke: color,
            strokeWidth: picked ? 4.5 : edge.hero || touches ? 2.4 : 1.4,
            strokeDasharray: edge.delta === "removed" || edge.dangling ? "6 4" : edge.reference ? "9 3 2 3" : undefined,
            // A picked line stands alone: every other line nearly disappears until Enter or Esc.
            opacity: edgeCursor ? (picked ? 1 : 0.07) : anyFocus && !touches ? 0.18 : 1,
          },
          labelStyle: { fill: color, fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: "var(--panel)" },
        };
      }),
    [spec, active, boxes, chipFocus, edgeCursor, hidden],
  );

  /** The first selected node's name, safe for a file name; a function row in Module view counts too. */
  const selectedLabel = (): string | null => {
    const byId = new Map(spec.nodes.map((node) => [node.id, node.label]));
    for (const id of selectedIds) {
      const label = byId.get(id) ?? byId.get(`file:${id}`) ?? model.symbols.get(id)?.name;
      if (label) return label.replace(/[\\/:*?"<>|\s]+/g, "_");
    }
    return null;
  };

  const exportPng = async () => {
    const element = document.querySelector<HTMLElement>(".react-flow__viewport");
    const pane = element?.closest<HTMLElement>(".react-flow");
    if (!element || !pane) return;
    // What's on screen right now: the pane's size at the current pan and zoom.
    const { clientWidth: width, clientHeight: height } = pane;
    const viewport = flow.getViewport();
    const dataUrl = await toPng(element, {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim() || "#121316",
      width,
      height,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` },
    });
    const label = selectedLabel();
    await window.atlas.exportFile(label ? `${exportName}-${label}` : exportName, "png", dataUrl);
  };

  return (
    <div className="canvas" ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        minZoom={0.05}
        maxZoom={2.5}
        panOnDrag
        panOnScroll
        // 1:1 with the fingers on a trackpad; React Flow's default 0.5 feels sluggish.
        panOnScrollSpeed={1}
        zoomOnScroll={false}
        zoomOnPinch
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        onNodeClick={(event, node) => node.data.spec.kind !== "lane" && onSelect(node.id, event.shiftKey || event.metaKey)}
        onNodeDoubleClick={(_event, node) => onIsolate(node.id)}
        onPaneClick={onClear}
        onEdgeMouseEnter={trackEdge}
        onEdgeMouseMove={trackEdge}
        onEdgeMouseLeave={() => setHoveredEdge(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--grid)" />
        <MiniMap
          pannable
          zoomable
          className="minimap"
          nodeColor={(node) => {
            const { spec: nodeSpec } = node.data as AtlasNode["data"];
            return nodeSpec.kind === "lane" || nodeSpec.kind === "file-group" || nodeSpec.kind === "class-group" ? "transparent" : deltaColors[nodeSpec.delta];
          }}
          nodeStrokeWidth={0}
          bgColor="var(--panel)"
        />
        <Panel position="bottom-left" className="legend">
          {legendItems.map(({ kind, label }) => (
            <button
              key={kind}
              className={`legend-item ${kind}${legendOff.has(kind) ? " off" : ""}`}
              aria-pressed={!legendOff.has(kind)}
              title={legendOff.has(kind) ? `Show ${label} lines` : `Hide ${label} lines`}
              onClick={() => toggleLegend(kind)}
            >
              {label}
            </button>
          ))}
          <button className="btn ghost small" onClick={() => void exportPng()}>
            Export PNG
          </button>
        </Panel>
      </ReactFlow>
      {hoveredEdge && peekCallIds.length > 0 && (
        <CallPeek
          callIds={peekCallIds}
          x={hoveredEdge.x}
          y={hoveredEdge.y}
          width={canvasRef.current?.clientWidth ?? 0}
          height={canvasRef.current?.clientHeight ?? 0}
        />
      )}
      {spec.empty && <div className="canvas-empty">{spec.empty}</div>}
      {layoutError && <div className="canvas-empty">Layout failed: {layoutError}</div>}
    </div>
  );
}
