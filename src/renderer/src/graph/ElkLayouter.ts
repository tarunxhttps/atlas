import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { GraphSpec, SpecNode } from "./GraphBuilder";

export interface PositionedNode {
  spec: SpecNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

const groupKinds = new Set(["file-group", "class-group", "lane"]);

export class ElkLayouter {
  private readonly elk = new ELK();

  async layout(spec: GraphSpec): Promise<PositionedNode[]> {
    if (spec.nodes.length === 0) return [];
    return spec.laneLayout ? this.lanes(spec) : this.layered(spec);
  }

  private async layered(spec: GraphSpec): Promise<PositionedNode[]> {
    const byParent = new Map<string | null, SpecNode[]>();
    for (const node of spec.nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);

    const toElk = (node: SpecNode): ElkNode => {
      const children = byParent.get(node.id) ?? [];
      if (groupKinds.has(node.kind) && children.length > 0) {
        return {
          id: node.id,
          layoutOptions: { "elk.padding": "[top=46,left=16,bottom=16,right=16]", "elk.direction": "RIGHT" },
          children: children.map(toElk),
        };
      }
      return { id: node.id, width: node.width, height: node.height };
    };

    const edges: ElkExtendedEdge[] = spec.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }));
    const root: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "80",
        "elk.spacing.nodeNode": "28",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": "60",
      },
      children: (byParent.get(null) ?? []).map(toElk),
      edges,
    };

    const result = await this.elk.layout(root);
    const specById = new Map(spec.nodes.map((node) => [node.id, node]));
    const positioned: PositionedNode[] = [];
    const collect = (node: ElkNode) => {
      const nodeSpec = specById.get(node.id);
      if (nodeSpec) {
        positioned.push({ spec: nodeSpec, x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? nodeSpec.width, height: node.height ?? nodeSpec.height });
      }
      for (const child of node.children ?? []) collect(child);
    };
    for (const child of result.children ?? []) collect(child);
    return positioned;
  }

  /** Architecture lanes are columns in a fixed order, so the picture reads left to right like the system. */
  private lanes(spec: GraphSpec): PositionedNode[] {
    const laneWidth = 290;
    const gap = 110;
    const lanes = spec.nodes.filter((node) => node.kind === "lane");
    const positioned: PositionedNode[] = [];
    let tallest = 0;
    const laneChildren = lanes.map((lane, index) => {
      let y = 58;
      const children = spec.nodes
        .filter((node) => node.parentId === lane.id)
        .map((child) => {
          const placed = { spec: child, x: (laneWidth - child.width) / 2, y, width: child.width, height: child.height };
          y += child.height + 30;
          return placed;
        });
      tallest = Math.max(tallest, y);
      return { lane, index, children };
    });
    for (const { lane, index, children } of laneChildren) {
      positioned.push({ spec: lane, x: index * (laneWidth + gap), y: 0, width: laneWidth, height: Math.max(tallest, 200) });
      positioned.push(...children);
    }
    return positioned;
  }
}
