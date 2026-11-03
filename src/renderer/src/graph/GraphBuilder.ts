import { isTestPath } from "@shared/paths";
import type { CallEdge, CodeSymbol, Delta } from "@shared/types";
import type { AnalysisModel } from "../lib/AnalysisModel";
import { changePreview, type PreviewLine } from "../lib/codePreview";

const maxPreviewLines = 400;
const visiblePreviewLines = 18;

export type Level = "architecture" | "package" | "module" | "code";
export type Scope = "changed" | "context" | "all";

export interface GraphOptions {
  level: Level;
  scope: Scope;
  showCode: boolean;
  hideTests: boolean;
  isolateId: string | null;
}

export type SpecNodeKind = "symbol" | "class-group" | "file-group" | "file" | "dir" | "component" | "lane";

export interface FileChip {
  id: string;
  label: string;
  delta: Delta;
}

export interface SpecNode {
  id: string;
  kind: SpecNodeKind;
  parentId: string | null;
  width: number;
  height: number;
  label: string;
  sublabel: string;
  delta: Delta;
  neighbour: boolean;
  additions: number;
  deletions: number;
  chips: FileChip[];
  /** Shown when "code" is on: lines from just above the symbol's first change. */
  codeLines: PreviewLine[];
}

export interface SpecEdge {
  id: string;
  source: string;
  target: string;
  delta: Delta;
  label: string;
  dangling: boolean;
  hero: boolean;
  /** Names a class (type hint, isinstance, attribute) rather than calling it. */
  reference: boolean;
  /** The call edges this line stands for; a file or folder line groups several, architecture lines none. */
  callIds: string[];
}

export interface GraphSpec {
  nodes: SpecNode[];
  edges: SpecEdge[];
  /** Lanes are laid out as fixed columns instead of by ELK. */
  laneLayout: boolean;
  empty: string | null;
}

export class GraphBuilder {
  constructor(private readonly model: AnalysisModel) {}

  build(options: GraphOptions): GraphSpec {
    switch (options.level) {
      case "architecture":
        return this.architecture(options);
      case "package":
        return this.aggregate(options, "dir");
      case "module":
        return this.aggregate(options, "file");
      case "code":
        return this.code(options);
    }
  }

  /** The leaf symbols (functions, methods, childless classes) the scope and filters select. */
  selectedLeaves(options: GraphOptions): Set<string> {
    const leaves = [...this.model.symbols.values()].filter(
      (symbol) => (symbol.kind !== "class" || this.model.children(symbol.id).length === 0) && !(options.hideTests && isTestPath(symbol.path)),
    );
    const leafIds = new Set(leaves.map((symbol) => symbol.id));
    const isChanged = (symbol: CodeSymbol) => symbol.delta !== "unchanged";
    const changed = leaves.filter((symbol) => symbol.inPr && isChanged(symbol)).map((symbol) => symbol.id);

    if (options.isolateId) return this.isolation(options.isolateId, leafIds);

    const selected = new Set(changed);
    if (options.scope === "all") {
      for (const symbol of leaves) if (symbol.inPr || this.edgesOf(symbol.id).length > 0) selected.add(symbol.id);
    } else if (options.scope === "context") {
      for (const id of changed) {
        for (const edge of this.edgesOf(id)) {
          const other = edge.from === id ? edge.to : edge.from;
          if (leafIds.has(other)) selected.add(other);
        }
      }
    }
    return selected;
  }

  private isolation(id: string, leafIds: Set<string>): Set<string> {
    const roots = leafIds.has(id) ? [id] : this.model.children(id).map((child) => child.id);
    const selected = new Set(roots);
    // A class's own users (type hints, construction) hang off the class itself, not its methods.
    for (const root of [id, ...roots]) {
      for (const edge of this.edgesOf(root)) {
        const other = edge.from === root ? edge.to : edge.from;
        if (leafIds.has(other)) selected.add(other);
      }
    }
    return selected;
  }

  private code(options: GraphOptions): GraphSpec {
    const leaves = this.selectedLeaves(options);
    const nodes = new Map<string, SpecNode>();
    const groupsWithChildren = new Set<string>();

    for (const id of leaves) {
      const symbol = this.model.symbols.get(id)!;
      let parentId = this.fileGroupId(symbol.path);
      const ancestors = this.classAncestors(symbol);
      for (const ancestor of ancestors) {
        groupsWithChildren.add(ancestor.id);
        if (!nodes.has(ancestor.id)) nodes.set(ancestor.id, this.classGroup(ancestor, parentId));
        parentId = ancestor.id;
      }
      groupsWithChildren.add(this.fileGroupId(symbol.path));
      nodes.set(id, this.symbolNode(symbol, parentId, options.showCode));
    }
    for (const id of groupsWithChildren) {
      if (!id.startsWith("file:")) continue;
      const path = id.slice(5);
      nodes.set(id, this.fileGroup(path));
    }

    const edges = this.model.analysis.facts.calls
      .filter((edge) => nodes.has(edge.from) && nodes.has(edge.to))
      .map((edge) => this.callEdge(edge));

    return {
      nodes: this.parentsFirst([...nodes.values()]),
      edges,
      laneLayout: false,
      empty: leaves.size === 0 ? "No functions match these filters. Try “With context” or “All”." : null,
    };
  }

  private aggregate(options: GraphOptions, unit: "file" | "dir"): GraphSpec {
    const leaves = this.selectedLeaves(options);
    const keyOf = (path: string) => (unit === "file" ? path : this.dirOf(path));
    const members = new Map<string, CodeSymbol[]>();
    for (const id of leaves) {
      const symbol = this.model.symbols.get(id)!;
      const key = keyOf(symbol.path);
      members.set(key, [...(members.get(key) ?? []), symbol]);
    }
    // Changed files the parser can't read (other languages, config) still belong on the map.
    if (!options.isolateId) {
      for (const file of this.model.analysis.facts.files) {
        if (file.excluded || (options.hideTests && isTestPath(file.path))) continue;
        const key = keyOf(file.path);
        if (!members.has(key) && (file.language === null || options.scope === "all")) members.set(key, []);
      }
    }

    const nodes: SpecNode[] = [...members.entries()].map(([key, symbols]) => (unit === "file" ? this.fileNode(key, symbols) : this.dirNode(key, symbols)));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const idOf = (path: string) => (unit === "file" ? `file:${path}` : `dir:${this.dirOf(path)}`);

    const grouped = new Map<string, CallEdge[]>();
    for (const edge of this.model.analysis.facts.calls) {
      if (!leaves.has(edge.from) || !leaves.has(edge.to)) continue;
      const source = idOf(this.model.symbols.get(edge.from)!.path);
      const target = idOf(this.model.symbols.get(edge.to)!.path);
      if (source === target || !nodeIds.has(source) || !nodeIds.has(target)) continue;
      const key = `${source}->${target}`;
      grouped.set(key, [...(grouped.get(key) ?? []), edge]);
    }
    const edges: SpecEdge[] = [...grouped.entries()].map(([key, list]) => {
      const [source, target] = key.split("->");
      return {
        id: key,
        source,
        target,
        delta: this.edgeDelta(list),
        label: list.length > 1 ? `${list.length} calls` : "",
        dangling: list.some((edge) => edge.dangling),
        hero: false,
        reference: list.every((edge) => edge.kind === "reference"),
        callIds: list.map((edge) => edge.id),
      };
    });

    return { nodes, edges, laneLayout: false, empty: nodes.length === 0 ? "Nothing matches these filters." : null };
  }

  private architecture(options: GraphOptions): GraphSpec {
    const narrative = this.model.narrative;
    if (!narrative) return { nodes: [], edges: [], laneLayout: true, empty: "The architecture view appears once Claude has explained the PR." };

    let components = narrative.components.filter((component) => !options.hideTests || component.kind !== "test");
    if (options.isolateId && this.model.components.has(options.isolateId)) {
      const connected = new Set([options.isolateId]);
      for (const edge of narrative.componentEdges) {
        if (edge.from === options.isolateId) connected.add(edge.to);
        if (edge.to === options.isolateId) connected.add(edge.from);
      }
      components = components.filter((component) => connected.has(component.id));
    } else if (options.scope === "changed") {
      components = components.filter((component) => component.delta !== "unchanged");
    }
    const ids = new Set(components.map((component) => component.id));
    const usedLanes = narrative.lanes.filter((lane) => components.some((component) => component.lane === lane.id));

    const nodes: SpecNode[] = [
      ...usedLanes.map((lane) => this.blank(`lane:${lane.id}`, "lane", null, lane.label, lane.subtitle)),
      ...components.map((component) => {
        const node = this.blank(component.id, "component", `lane:${component.lane}`, component.label, component.kind);
        node.width = 250;
        node.height = 96;
        node.delta = component.delta;
        node.chips = component.symbolIds.slice(0, 4).map((id) => {
          const symbol = this.model.symbols.get(id)!;
          return { id, label: symbol.name, delta: symbol.delta };
        });
        node.height += node.chips.length * 22;
        return node;
      }),
    ];
    const edges: SpecEdge[] = narrative.componentEdges
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({
        id: `c:${edge.id}`,
        source: edge.from,
        target: edge.to,
        delta: edge.delta,
        label: edge.label,
        dangling: false,
        hero: edge.hero,
        reference: false,
        callIds: [],
      }));
    return { nodes, edges, laneLayout: true, empty: components.length === 0 ? "No components match these filters." : null };
  }

  private symbolNode(symbol: CodeSymbol, parentId: string, showCode: boolean): SpecNode {
    const codeLines = showCode ? changePreview(symbol, maxPreviewLines) : [];
    const node = this.blank(symbol.id, "symbol", parentId, this.model.label(symbol).split(".").pop() ?? symbol.name, symbol.kind);
    node.delta = symbol.delta;
    node.neighbour = !symbol.inPr;
    node.additions = symbol.additions;
    node.deletions = symbol.deletions;
    node.codeLines = codeLines;
    node.width = showCode ? 420 : 250;
    // The box shows up to visiblePreviewLines and scrolls for the rest.
    node.height = 58 + (codeLines.length > 0 ? Math.min(codeLines.length, visiblePreviewLines) * 15 + 14 : 0);
    return node;
  }

  private classGroup(symbol: CodeSymbol, parentId: string): SpecNode {
    const node = this.blank(symbol.id, "class-group", parentId, symbol.name, "class");
    node.delta = symbol.delta;
    node.neighbour = !symbol.inPr;
    return node;
  }

  private fileGroup(path: string): SpecNode {
    const file = this.model.files.get(path);
    const node = this.blank(`file:${path}`, "file-group", null, this.model.fileLabel(path), this.dirOf(path));
    node.delta = file ? this.fileDelta(file.status) : "unchanged";
    node.neighbour = !file;
    node.additions = file?.additions ?? 0;
    node.deletions = file?.deletions ?? 0;
    return node;
  }

  private fileNode(path: string, symbols: CodeSymbol[]): SpecNode {
    const node = this.fileGroup(path);
    node.kind = "file";
    node.width = 270;
    node.chips = symbols
      .filter((symbol) => symbol.kind !== "class")
      .slice(0, 10)
      .map((symbol) => ({ id: symbol.id, label: this.model.label(symbol), delta: symbol.delta }));
    node.height = 64 + node.chips.length * 22 + (symbols.length > 10 ? 20 : 0);
    if (symbols.length > 10) node.sublabel = `${node.sublabel} · ${symbols.length} symbols`;
    return node;
  }

  private dirNode(dir: string, symbols: CodeSymbol[]): SpecNode {
    const files = this.model.analysis.facts.files.filter((file) => this.dirOf(file.path) === dir);
    const paths = new Set([...symbols.map((symbol) => symbol.path), ...files.map((file) => file.path)]);
    const node = this.blank(`dir:${dir}`, "dir", null, dir || "(root)", `${paths.size} file${paths.size === 1 ? "" : "s"}`);
    node.width = 260;
    node.height = 78;
    node.delta = this.model.aggregateDelta([...files.map((file) => this.fileDelta(file.status)), ...symbols.map((symbol) => symbol.delta)]);
    node.neighbour = files.length === 0;
    node.additions = files.reduce((sum, file) => sum + file.additions, 0);
    node.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return node;
  }

  private callEdge(edge: CallEdge): SpecEdge {
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      delta: edge.delta,
      label: edge.dangling ? (edge.kind === "reference" ? "uses removed class" : "calls removed code") : "",
      dangling: edge.dangling,
      hero: false,
      reference: edge.kind === "reference",
      callIds: [edge.id],
    };
  }

  private edgeDelta(edges: CallEdge[]): Delta {
    if (edges.every((edge) => edge.delta === "added")) return "added";
    if (edges.every((edge) => edge.delta === "removed")) return "removed";
    if (edges.some((edge) => edge.delta !== "unchanged")) return "modified";
    return "unchanged";
  }

  private edgesOf(id: string): CallEdge[] {
    return [...this.model.callers(id), ...this.model.callees(id)];
  }

  private classAncestors(symbol: CodeSymbol): CodeSymbol[] {
    const chain: CodeSymbol[] = [];
    let parent = symbol.parentId ? this.model.symbols.get(symbol.parentId) : undefined;
    while (parent) {
      if (parent.kind === "class") chain.unshift(parent);
      parent = parent.parentId ? this.model.symbols.get(parent.parentId) : undefined;
    }
    return chain;
  }

  private fileDelta(status: string): Delta {
    return status === "added" ? "added" : status === "removed" ? "removed" : "modified";
  }

  private fileGroupId(path: string): string {
    return `file:${path}`;
  }

  private dirOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }

  /** React Flow needs every parent before its children. */
  private parentsFirst(nodes: SpecNode[]): SpecNode[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depth = (node: SpecNode): number => (node.parentId && byId.has(node.parentId) ? 1 + depth(byId.get(node.parentId)!) : 0);
    return nodes.sort((a, b) => depth(a) - depth(b));
  }

  private blank(id: string, kind: SpecNodeKind, parentId: string | null, label: string, sublabel: string): SpecNode {
    return {
      id,
      kind,
      parentId,
      width: 250,
      height: 60,
      label,
      sublabel,
      delta: "unchanged",
      neighbour: false,
      additions: 0,
      deletions: 0,
      chips: [],
      codeLines: [],
    };
  }
}
