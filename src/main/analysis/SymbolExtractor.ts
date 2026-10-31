import type { Node } from "web-tree-sitter";
import type { LanguageId, SymbolKind } from "@shared/types";
import type { LanguageRegistry } from "./LanguageRegistry";

export type CallReceiver = "self" | "super" | "other" | null;

export interface CallSite {
  name: string;
  receiver: CallReceiver;
  line: number;
}

export interface ExtractedSymbol {
  /** Unique within the file: Class.method, outer.inner, with #2 for repeats. */
  qualifiedName: string;
  name: string;
  kind: SymbolKind;
  parentQualifiedName: string | null;
  classQualifiedName: string | null;
  startLine: number;
  endLine: number;
  signature: string;
  code: string;
  /** What decides added/modified/unchanged; a class excludes its methods' bodies. */
  compareText: string;
  calls: CallSite[];
  /** Capitalised names the symbol mentions (type hints, isinstance, attributes); how models get "uses" lines. */
  references: string[];
}

interface Scope {
  symbol: ExtractedSymbol;
  node: Node;
}

const maxCodeChars = 30_000;

export class SymbolExtractor {
  private static readonly functionTypes = new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "function_definition",
  ]);
  private static readonly classTypes = new Set(["class_declaration", "abstract_class_declaration", "class_definition"]);
  private static readonly functionValueTypes = new Set([
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
  ]);

  constructor(private readonly registry: LanguageRegistry) {}

  async extract(source: string, language: LanguageId): Promise<ExtractedSymbol[]> {
    const parser = await this.registry.parser(language);
    const tree = parser.parse(source);
    if (!tree) return [];
    const symbols: ExtractedSymbol[] = [];
    const seen = new Map<string, number>();
    try {
      this.visit(tree.rootNode, [], symbols, seen, language);
    } finally {
      tree.delete();
    }
    return symbols;
  }

  private visit(node: Node, scopes: Scope[], out: ExtractedSymbol[], seen: Map<string, number>, language: LanguageId): void {
    const declared = this.declare(node, scopes, seen, language);
    if (declared) {
      out.push(declared.symbol);
      scopes = [...scopes, declared];
    }

    const call = this.callSite(node, language);
    if (call) {
      const owner = this.innermostCallable(scopes);
      owner?.calls.push(call);
    }
    if ((node.type === "identifier" || node.type === "type_identifier") && /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(node.text)) {
      const owner = this.innermostCallable(scopes);
      if (owner && owner.name !== node.text && !owner.references.includes(node.text) && owner.references.length < 200) owner.references.push(node.text);
    }

    for (const child of node.namedChildren) {
      if (child) this.visit(child, scopes, out, seen, language);
    }

    if (declared?.symbol.kind === "class") {
      declared.symbol.compareText = this.classCompareText(declared.node, out, declared.symbol);
    }
  }

  private declare(node: Node, scopes: Scope[], seen: Map<string, number>, language: LanguageId): Scope | null {
    const shape = this.symbolShape(node);
    if (!shape) return null;

    const parent = scopes.at(-1)?.symbol ?? null;
    const enclosingClass = [...scopes].reverse().find((scope) => scope.symbol.kind === "class")?.symbol ?? null;
    const baseName = parent ? `${parent.qualifiedName}.${shape.name}` : shape.name;
    const count = (seen.get(baseName) ?? 0) + 1;
    seen.set(baseName, count);

    const outer = this.decoratedWrapper(node, language) ?? shape.rangeNode;
    const kind: SymbolKind = shape.isClass ? "class" : parent?.kind === "class" ? "method" : "function";
    const code = outer.text.length > maxCodeChars ? `${outer.text.slice(0, maxCodeChars)}\n…` : outer.text;

    return {
      node: shape.rangeNode,
      symbol: {
        qualifiedName: count > 1 ? `${baseName}#${count}` : baseName,
        name: shape.name,
        kind,
        parentQualifiedName: parent?.qualifiedName ?? null,
        classQualifiedName: shape.isClass ? null : (enclosingClass?.qualifiedName ?? null),
        startLine: outer.startPosition.row + 1,
        endLine: outer.endPosition.row + 1,
        signature: this.signature(outer, shape.bodyNode),
        code,
        compareText: outer.text,
        calls: [],
        references: [],
      },
    };
  }

  private symbolShape(node: Node): { name: string; isClass: boolean; rangeNode: Node; bodyNode: Node | null } | null {
    if (SymbolExtractor.functionTypes.has(node.type) || SymbolExtractor.classTypes.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      return {
        name,
        isClass: SymbolExtractor.classTypes.has(node.type),
        rangeNode: node,
        bodyNode: node.childForFieldName("body"),
      };
    }
    // `const handler = () => …` and class fields holding arrow functions.
    if (node.type === "variable_declarator" || node.type === "public_field_definition" || node.type === "field_definition") {
      const value = node.childForFieldName("value");
      const nameNode = node.childForFieldName("name") ?? node.childForFieldName("property");
      if (!value || !nameNode || !SymbolExtractor.functionValueTypes.has(value.type)) return null;
      if (nameNode.type !== "identifier" && nameNode.type !== "property_identifier") return null;
      const rangeNode = node.type === "variable_declarator" && node.parent ? node.parent : node;
      return { name: nameNode.text, isClass: false, rangeNode, bodyNode: value.childForFieldName("body") };
    }
    return null;
  }

  private decoratedWrapper(node: Node, language: LanguageId): Node | null {
    if (language !== "python") return null;
    return node.parent?.type === "decorated_definition" ? node.parent : null;
  }

  private signature(outer: Node, body: Node | null): string {
    const end = body ? body.startIndex - outer.startIndex : outer.text.indexOf("\n");
    const head = outer.text.slice(0, end > 0 ? end : 240);
    return head.replace(/\s+/g, " ").replace(/[\s{:=>]+$/, "").trim().slice(0, 240);
  }

  private callSite(node: Node, language: LanguageId): CallSite | null {
    const line = node.startPosition.row + 1;
    if (node.type === "call" || node.type === "call_expression") {
      const target = node.childForFieldName("function");
      return target ? this.callTarget(target, line) : null;
    }
    if (node.type === "new_expression") {
      const target = node.childForFieldName("constructor");
      return target ? this.callTarget(target, line) : null;
    }
    // Rendering <Component /> is how React code calls a component.
    if (language !== "python" && (node.type === "jsx_self_closing_element" || node.type === "jsx_opening_element")) {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return null;
      const name = nameNode.type === "member_expression" ? nameNode.childForFieldName("property")?.text : nameNode.text;
      return name && /^[A-Z]/.test(name) ? { name, receiver: null, line } : null;
    }
    return null;
  }

  private callTarget(target: Node, line: number): CallSite | null {
    if (target.type === "identifier") return { name: target.text, receiver: null, line };
    if (target.type === "member_expression" || target.type === "attribute") {
      const property = target.childForFieldName("property") ?? target.childForFieldName("attribute");
      const object = target.childForFieldName("object");
      if (!property) return null;
      const objectText = object?.text ?? "";
      const receiver: CallReceiver =
        objectText === "this" || objectText === "self" || objectText === "cls"
          ? "self"
          : objectText === "super" || objectText.startsWith("super(")
            ? "super"
            : "other";
      return { name: property.text, receiver, line };
    }
    return null;
  }

  private innermostCallable(scopes: Scope[]): ExtractedSymbol | null {
    return scopes.at(-1)?.symbol ?? null;
  }

  private classCompareText(classNode: Node, all: ExtractedSymbol[], cls: ExtractedSymbol): string {
    const text = classNode.text;
    const offset = classNode.startPosition.row;
    const lines = text.split("\n");
    const members = all.filter((symbol) => symbol.parentQualifiedName === cls.qualifiedName && symbol.kind !== "class");
    for (const member of members) {
      for (let row = member.startLine - 1 - offset + 1; row <= member.endLine - 1 - offset; row++) {
        if (row >= 0 && row < lines.length) lines[row] = "";
      }
    }
    return lines.join("\n");
  }
}
