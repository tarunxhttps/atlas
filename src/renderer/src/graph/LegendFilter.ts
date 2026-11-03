import type { GraphSpec, SpecEdge } from "./GraphBuilder";

export type LegendKind = "added" | "modified" | "removed" | "unchanged" | "neighbour";

export interface HiddenElements {
  nodes: Set<string>;
  edges: Set<string>;
}

/**
 * Hides the lines of the legend kinds switched off, and any node left with only hidden lines.
 * Nodes with no lines at all stay, so turning a kind off never hides a change that calls nothing.
 */
export class LegendFilter {
  constructor(private readonly off: ReadonlySet<LegendKind>) {}

  hide(spec: GraphSpec): HiddenElements {
    if (this.off.size === 0) return { nodes: new Set(), edges: new Set() };
    const neighbours = new Set(spec.nodes.filter((node) => node.neighbour).map((node) => node.id));
    const edges = new Set(spec.edges.filter((edge) => this.kindsOf(edge, neighbours).some((kind) => this.off.has(kind))).map((edge) => edge.id));

    const total = new Map<string, number>();
    const hiddenCount = new Map<string, number>();
    for (const edge of spec.edges) {
      for (const end of [edge.source, edge.target]) {
        total.set(end, (total.get(end) ?? 0) + 1);
        if (edges.has(edge.id)) hiddenCount.set(end, (hiddenCount.get(end) ?? 0) + 1);
      }
    }
    const onlyHiddenLines = (id: string) => (total.get(id) ?? 0) === (hiddenCount.get(id) ?? 0);

    const children = new Map<string, string[]>();
    for (const node of spec.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);

    const nodes = new Set<string>();
    // Children come after their parents in the spec, so walking it backwards settles every frame's contents first.
    for (const node of [...spec.nodes].reverse()) {
      const inside = children.get(node.id);
      const hidden = inside
        ? inside.every((id) => nodes.has(id)) && onlyHiddenLines(node.id)
        : (node.neighbour && this.off.has("neighbour")) || ((total.get(node.id) ?? 0) > 0 && onlyHiddenLines(node.id));
      if (hidden) nodes.add(node.id);
    }
    for (const edge of spec.edges) if (nodes.has(edge.source) || nodes.has(edge.target)) edges.add(edge.id);
    return { nodes, edges };
  }

  private kindsOf(edge: SpecEdge, neighbours: Set<string>): LegendKind[] {
    const kinds: LegendKind[] = [];
    // A dangling line is drawn red and dashed, like a removed one.
    if (edge.dangling) kinds.push("removed");
    else kinds.push(edge.delta);
    if (neighbours.has(edge.source) || neighbours.has(edge.target)) kinds.push("neighbour");
    return kinds;
  }
}
