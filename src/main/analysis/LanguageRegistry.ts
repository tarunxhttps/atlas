import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import type { LanguageId } from "@shared/types";

const nodeRequire = createRequire(import.meta.url);

const grammarFiles: Record<LanguageId, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

const extensions: Record<string, LanguageId> = {
  ".py": "python",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

export class LanguageRegistry {
  static readonly grepGlobs = Object.keys(extensions).map((ext) => `*${ext}`);

  private initPromise: Promise<void> | null = null;
  private readonly languages = new Map<LanguageId, Language>();
  private readonly parsers = new Map<LanguageId, Parser>();

  static languageFor(path: string): LanguageId | null {
    if (path.endsWith(".d.ts")) return null;
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    return extensions[path.slice(dot).toLowerCase()] ?? null;
  }

  async parser(language: LanguageId): Promise<Parser> {
    await this.init();
    const cached = this.parsers.get(language);
    if (cached) return cached;
    const grammar = await this.language(language);
    const parser = new Parser();
    parser.setLanguage(grammar);
    this.parsers.set(language, parser);
    return parser;
  }

  private init(): Promise<void> {
    this.initPromise ??= Parser.init({
      locateFile: () => nodeRequire.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    });
    return this.initPromise;
  }

  private async language(id: LanguageId): Promise<Language> {
    const cached = this.languages.get(id);
    if (cached) return cached;
    const bytes = await readFile(nodeRequire.resolve(grammarFiles[id]));
    const language = await Language.load(new Uint8Array(bytes));
    this.languages.set(id, language);
    return language;
  }
}
