import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { Delta } from "@shared/types";
import type { SpecNode } from "../graph/GraphBuilder";
import { useWorkspace } from "../lib/WorkspaceContext";

export interface NodeState {
  spec: SpecNode;
  selected: boolean;
  dimmed: boolean;
  highlighted: boolean;
  viewed: boolean;
  /** Function rows inside this card that are selected (Module view). */
  selectedChips: string[];
  [key: string]: unknown;
}

export type AtlasNode = Node<NodeState>;

const kindIcon: Record<string, string> = {
  function: "ƒ",
  method: "{}",
  class: "◇",
  service: "▣",
  module: "▤",
  route: "⇄",
  job: "⟳",
  queue: "☰",
  datastore: "⛁",
  cache: "⚡",
  external: "☁",
  ui: "▭",
  config: "⚙",
  test: "✓",
  other: "•",
};

function classes(data: NodeState, base: string): string {
  return [
    base,
    `delta-${data.spec.delta}`,
    data.spec.neighbour ? "neighbour" : "",
    data.selected ? "is-selected" : "",
    data.dimmed ? "is-dimmed" : "",
    data.highlighted ? "is-highlighted" : "",
    data.viewed ? "is-viewed" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function DeltaBadge({ delta, neighbour }: { delta: Delta; neighbour?: boolean }) {
  if (neighbour) return <span className="badge neighbour">outside PR</span>;
  if (delta === "unchanged") return null;
  return <span className={`badge delta-${delta}`}>{delta}</span>;
}

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <span className="line-counts">
      {additions > 0 && <span className="plus">+{additions}</span>}
      {deletions > 0 && <span className="minus">−{deletions}</span>}
    </span>
  );
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="down" className="handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="from-above" className="handle" isConnectable={false} />
      <Handle type="source" position={Position.Top} id="up" className="handle" isConnectable={false} />
      <Handle type="target" position={Position.Bottom} id="from-below" className="handle" isConnectable={false} />
    </>
  );
}

export function SymbolNode({ data }: NodeProps<AtlasNode>) {
  const { spec } = data;
  return (
    <div className={classes(data, "node symbol-node")}>
      <Handles />
      <div className="node-head">
        <span className="kind-icon">{kindIcon[spec.sublabel] ?? "ƒ"}</span>
        <span className="node-title" title={spec.id}>
          {spec.label}
        </span>
        {data.viewed && <span className="viewed-check">✓</span>}
      </div>
      <div className="node-meta">
        <span className="kind-label">{spec.sublabel}</span>
        <DeltaBadge delta={spec.delta} neighbour={spec.neighbour} />
        <LineCounts additions={spec.additions} deletions={spec.deletions} />
      </div>
      {spec.codeLines.length > 0 && <pre className="node-code">{spec.codeLines.join("\n")}</pre>}
    </div>
  );
}

export function GroupNode({ data }: NodeProps<AtlasNode>) {
  const { spec } = data;
  const icon = spec.kind === "file-group" ? "▤" : spec.kind === "class-group" ? "◇" : "";
  return (
    <div className={classes(data, `node group-node ${spec.kind}`)}>
      <Handles />
      <div className="group-head">
        {icon && <span className="kind-icon">{icon}</span>}
        <span className="group-title">{spec.label}</span>
        <span className="group-sub">{spec.kind === "file-group" ? spec.sublabel : spec.kind === "lane" ? spec.sublabel : "class"}</span>
        <DeltaBadge delta={spec.kind === "lane" ? "unchanged" : spec.delta} neighbour={spec.neighbour} />
        <LineCounts additions={spec.additions} deletions={spec.deletions} />
      </div>
    </div>
  );
}

function ChipList({ spec, selected = [] }: { spec: SpecNode; selected?: string[] }) {
  const { reveal } = useWorkspace();
  if (spec.chips.length === 0) return null;
  return (
    <div className="chips">
      {spec.chips.map((chip) => (
        <button
          key={chip.id}
          className={`chip delta-${chip.delta}${selected.includes(chip.id) ? " is-selected" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            reveal(chip.id);
          }}
        >
          <span className="chip-dot" />
          {chip.label}
        </button>
      ))}
    </div>
  );
}

export function FileNode({ data }: NodeProps<AtlasNode>) {
  const { spec } = data;
  return (
    <div className={classes(data, "node file-node")}>
      <Handles />
      <div className="node-head">
        <span className="kind-icon">▤</span>
        <span className="node-title">{spec.label}</span>
      </div>
      <div className="node-meta">
        <span className="kind-label path">{spec.sublabel}</span>
        <DeltaBadge delta={spec.delta} neighbour={spec.neighbour} />
        <LineCounts additions={spec.additions} deletions={spec.deletions} />
      </div>
      <ChipList spec={spec} selected={data.selectedChips} />
    </div>
  );
}

export function DirNode({ data }: NodeProps<AtlasNode>) {
  const { spec } = data;
  return (
    <div className={classes(data, "node dir-node")}>
      <Handles />
      <div className="node-head">
        <span className="kind-icon">▢</span>
        <span className="node-title">{spec.label}/</span>
      </div>
      <div className="node-meta">
        <span className="kind-label">{spec.sublabel}</span>
        <DeltaBadge delta={spec.delta} neighbour={spec.neighbour} />
        <LineCounts additions={spec.additions} deletions={spec.deletions} />
      </div>
    </div>
  );
}

export function ComponentNode({ data }: NodeProps<AtlasNode>) {
  const { spec } = data;
  return (
    <div className={classes(data, "node component-node")}>
      <Handles />
      <div className="node-head">
        <span className="kind-icon">{kindIcon[spec.sublabel] ?? "•"}</span>
        <span className="node-title">{spec.label}</span>
      </div>
      <div className="node-meta">
        <span className="kind-label">{spec.sublabel}</span>
        <DeltaBadge delta={spec.delta} />
      </div>
      <ChipList spec={spec} selected={data.selectedChips} />
    </div>
  );
}

export const nodeTypes = {
  symbol: SymbolNode,
  frame: GroupNode,
  file: FileNode,
  dir: DirNode,
  component: ComponentNode,
};

export function nodeTypeFor(spec: SpecNode): keyof typeof nodeTypes {
  switch (spec.kind) {
    case "symbol":
      return "symbol";
    case "file":
      return "file";
    case "dir":
      return "dir";
    case "component":
      return "component";
    default:
      return "frame";
  }
}
