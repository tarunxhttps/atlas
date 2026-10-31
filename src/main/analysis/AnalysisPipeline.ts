import { minimatch } from "minimatch";
import type { Analysis, ChangedFile, CodeSymbol, ProgressStage, RepoCorrections } from "@shared/types";
import { prKey, repoKey } from "@shared/types";
import type { NarrativeService } from "../ai/NarrativeService";
import type { GitHubPrClient } from "../services/GitHubPrClient";
import type { RepoMirror } from "../services/RepoMirror";
import type { AtlasStore } from "../store/AtlasStore";
import { CallGraphBuilder, type SymbolCalls } from "./CallGraphBuilder";
import { LanguageRegistry } from "./LanguageRegistry";
import type { NeighbourFinder } from "./NeighbourFinder";
import { SymbolDiffer } from "./SymbolDiffer";
import type { SymbolExtractor } from "./SymbolExtractor";
import type { UsageFinder } from "./UsageFinder";
import { UnifiedDiffParser } from "./UnifiedDiffParser";

const defaultExcludes = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/*.lock",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/node_modules/**",
  "**/__generated__/**",
  "**/*.generated.*",
];

const maxParsedFileChars = 1_000_000;

export type ProgressReporter = (stage: ProgressStage, message: string) => void;

/** Full: explain the whole PR. Update: revise an earlier explanation from only what changed since. */
type NarrativePlan = { kind: "full" } | { kind: "update"; previous: Analysis; sincePatch: string };

const maxSincePatchChars = 150_000;

export class AnalysisPipeline {
  private readonly diffParser = new UnifiedDiffParser();
  private readonly differ = new SymbolDiffer();
  private readonly graphBuilder = new CallGraphBuilder();
  private readonly inFlightNarratives = new Set<string>();

  constructor(
    private readonly github: GitHubPrClient,
    private readonly mirror: RepoMirror,
    private readonly extractor: SymbolExtractor,
    private readonly neighbours: NeighbourFinder,
    private readonly narratives: NarrativeService,
    private readonly store: AtlasStore,
    private readonly usages: UsageFinder,
  ) {}

  /** Adds every function in the repo that calls or uses the class, then saves; isolating a model asks for this. */
  async expandUsages(key: string, symbolId: string): Promise<Analysis> {
    const analysis = this.store.loadAnalysis(key);
    if (!analysis) throw new Error(`No saved analysis for ${key}`);
    const target = analysis.facts.symbols.find((symbol) => symbol.id === symbolId);
    if (!target || analysis.expandedUsages?.includes(symbolId)) return analysis;
    const dir = await this.mirror.ensureClone(analysis.pr);
    // The clone is shared by every PR of the repo, so make sure it shows this PR's head before searching it.
    await this.mirror.checkout(dir, analysis.pr.headSha);
    const found = await this.usages.find(dir, analysis, target);
    const expanded: Analysis = {
      ...analysis,
      facts: { ...analysis.facts, symbols: [...analysis.facts.symbols, ...found.symbols], calls: [...analysis.facts.calls, ...found.calls] },
      expandedUsages: [...(analysis.expandedUsages ?? []), symbolId],
    };
    this.store.saveAnalysis(expanded);
    return expanded;
  }

  /** Returns the parsed facts straight away; the AI narrative follows through `onNarrative`. */
  async analyze(url: string, force: boolean, report: ProgressReporter, onNarrative: (analysis: Analysis) => void): Promise<Analysis> {
    const ref = this.github.parseRef(url);
    const key = prKey(ref);
    report("fetch", `Reading ${key} from GitHub`);
    const meta = await this.github.fetchMeta(ref);

    const cached = force ? null : this.store.loadAnalysis(key, meta.headSha);
    if (cached) {
      this.store.saveAnalysis(cached);
      // A pending narrative means the app quit mid-run; failed ones wait for the user to retry.
      if (cached.narrativeStatus === "pending") this.startNarrative(cached, report, onNarrative, { kind: "full" });
      report("done", "Loaded the saved analysis for this commit");
      return cached;
    }

    // The last saved analysis, possibly for an older commit: its explanation is the starting point for this one.
    const previous = this.store.loadAnalysis(key);

    report("clone", `Syncing ${repoKey(ref)} (the first time clones the repo)`);
    const dir = await this.mirror.ensureClone(ref);
    await this.mirror.fetchPr(dir, ref.number, meta.baseRef);
    const mergeBaseSha = await this.mirror.mergeBase(dir, meta.baseSha, meta.headSha);
    report("clone", "Checking out the PR head");
    await this.mirror.checkout(dir, meta.headSha);

    report("diff", "Diffing against the merge base");
    const corrections = this.corrections(repoKey(ref));
    const isExcluded = this.excluder(corrections);
    const files: ChangedFile[] = this.diffParser.parse(await this.mirror.diff(dir, mergeBaseSha, meta.headSha)).map((file) => ({
      ...file,
      language: file.binary ? null : LanguageRegistry.languageFor(file.path),
      excluded: isExcluded(file.path),
    }));

    report("parse", `Parsing ${files.filter((file) => file.language && !file.excluded).length} source files`);
    const prEntries = await this.parsePrFiles(dir, files, mergeBaseSha, meta.headSha);

    report("graph", "Finding callers and callees outside the PR");
    const neighbourEntries = await this.neighbours.find(dir, prEntries, isExcluded, this.store.settings().maxNeighbourFiles);
    const calls = this.graphBuilder.build([...prEntries, ...neighbourEntries]);
    const symbols = this.keepConnectedNeighbours([...prEntries, ...neighbourEntries].map((entry) => entry.symbol), calls);
    const symbolIds = new Set(symbols.map((symbol) => symbol.id));

    const settings = this.store.settings();
    const analysis: Analysis = {
      key,
      pr: { ...meta, mergeBaseSha },
      facts: {
        files,
        symbols,
        calls: calls.filter((edge) => symbolIds.has(edge.from) && symbolIds.has(edge.to)),
        notes: this.notes(files),
      },
      narrative: null,
      narrativeStatus: settings.autoNarrative ? "pending" : "disabled",
      narrativeError: null,
      narrativeModel: null,
      createdAt: new Date().toISOString(),
    };
    const plan = await this.narrativePlan(dir, previous, analysis);
    if (plan === "reuse") {
      const reused: Analysis = {
        ...analysis,
        narrative: this.narratives.reuse(previous!.narrative!, analysis, corrections),
        narrativeStatus: "ready",
        narrativeModel: previous!.narrativeModel,
      };
      this.store.saveAnalysis(reused);
      report("done", "Map refreshed; nothing in the PR's code changed, so the explanation was kept");
      return reused;
    }
    this.store.saveAnalysis(analysis);
    if (settings.autoNarrative) this.startNarrative(analysis, report, onNarrative, plan);
    report("done", "Map ready");
    return analysis;
  }

  /**
   * Reuse when the PR's code is unchanged since the last explanation (same head, or new commits that only
   * touched files outside the PR, such as a merge from the base branch). Otherwise update from the diff
   * since then, falling back to a full run when there's no earlier explanation or its commit is gone.
   */
  private async narrativePlan(dir: string, previous: Analysis | null, current: Analysis): Promise<NarrativePlan | "reuse"> {
    if (!previous?.narrative || previous.narrativeStatus !== "ready") return { kind: "full" };
    if (previous.pr.headSha === current.pr.headSha) return "reuse";
    let patch: string;
    try {
      patch = await this.mirror.diff(dir, previous.pr.headSha, current.pr.headSha);
    } catch {
      return { kind: "full" };
    }
    const prFiles = new Set(current.facts.files.filter((file) => !file.excluded).map((file) => file.path));
    const removedFiles = new Set(previous.facts.files.map((file) => file.path));
    const relevant = this.diffParser.parse(patch).filter((file) => prFiles.has(file.path) || removedFiles.has(file.path));
    if (relevant.length === 0) return "reuse";
    let text = "";
    for (const file of relevant) {
      text += `\n--- ${file.previousPath ?? file.path}\n+++ ${file.path}\n`;
      for (const hunk of file.hunks) {
        text += `${hunk.header}\n`;
        for (const line of hunk.lines) text += `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}\n`;
      }
    }
    // A change too big to summarise as a delta is cheaper and clearer explained from scratch.
    if (text.length > maxSincePatchChars) return { kind: "full" };
    return { kind: "update", previous, sincePatch: text };
  }

  regenerate(key: string, report: ProgressReporter, onNarrative: (analysis: Analysis) => void): void {
    const analysis = this.store.loadAnalysis(key);
    if (!analysis) throw new Error(`No saved analysis for ${key}`);
    this.startNarrative({ ...analysis, narrativeStatus: "pending", narrativeError: null }, report, onNarrative, { kind: "full" });
  }

  corrections(repo: string): RepoCorrections {
    return this.store.settings().corrections[repo] ?? { exclude: [], rename: {}, lanePins: {} };
  }

  private startNarrative(analysis: Analysis, report: ProgressReporter, onNarrative: (analysis: Analysis) => void, plan: NarrativePlan): void {
    const runKey = `${analysis.key}@${analysis.pr.headSha}`;
    if (this.inFlightNarratives.has(runKey)) return;
    this.inFlightNarratives.add(runKey);
    const settings = this.store.settings();
    const pending: Analysis = { ...analysis, narrativeStatus: "pending", narrativeError: null };
    this.store.saveAnalysis(pending);
    onNarrative(pending);
    const corrections = this.corrections(`${analysis.pr.owner}/${analysis.pr.repo}`);
    report("ai", plan.kind === "update" ? `Asking ${settings.model} to update the explanation for the new commits` : `Asking ${settings.model} to explain the change`);

    const run =
      plan.kind === "update"
        ? this.narratives.update(plan.previous, pending, plan.sincePatch, corrections, settings.model, settings.effort)
        : this.narratives.generate(pending, corrections, settings.model, settings.effort);
    run
      .then(({ narrative, model }) => {
        const ready: Analysis = { ...pending, narrative, narrativeStatus: "ready", narrativeModel: model };
        this.store.saveAnalysis(ready);
        onNarrative(ready);
        report("done", "Walkthrough and architecture ready");
      })
      .catch((error: unknown) => {
        const failed: Analysis = { ...pending, narrativeStatus: "failed", narrativeError: error instanceof Error ? error.message : String(error) };
        this.store.saveAnalysis(failed);
        onNarrative(failed);
        report("error", `Claude couldn't explain this PR: ${failed.narrativeError}`);
      })
      .finally(() => this.inFlightNarratives.delete(runKey));
  }

  private async parsePrFiles(dir: string, files: ChangedFile[], baseSha: string, headSha: string): Promise<SymbolCalls[]> {
    const entries: SymbolCalls[] = [];
    for (const file of files) {
      if (!file.language || file.excluded) continue;
      const [baseSource, headSource] = await Promise.all([
        file.status === "added" ? null : this.mirror.show(dir, baseSha, file.previousPath ?? file.path),
        file.status === "removed" ? null : this.mirror.show(dir, headSha, file.path),
      ]);
      const [base, head] = await Promise.all([this.extractIfSmall(baseSource, file), this.extractIfSmall(headSource, file)]);
      entries.push(...this.differ.diffFile(file, file.language, base, head));
    }
    this.differ.linkMoves(entries.map((entry) => entry.symbol));
    this.markClassesWithChangedMembers(entries.map((entry) => entry.symbol));
    return entries;
  }

  private async extractIfSmall(source: string | null, file: ChangedFile) {
    if (source === null || source.length > maxParsedFileChars || !file.language) return [];
    return this.extractor.extract(source, file.language);
  }

  // A class whose own lines didn't change but whose methods did still reads as modified on the map.
  private markClassesWithChangedMembers(symbols: CodeSymbol[]): void {
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    for (const symbol of symbols) {
      if (symbol.delta === "unchanged") continue;
      let parent = symbol.parentId ? byId.get(symbol.parentId) : undefined;
      while (parent) {
        if (parent.delta === "unchanged") parent.delta = "modified";
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
    }
  }

  /** PR symbols always stay; neighbours stay only if an edge ties them to the PR. */
  private keepConnectedNeighbours(symbols: CodeSymbol[], calls: { from: string; to: string }[]): CodeSymbol[] {
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const keep = new Set<string>();
    for (const edge of calls) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to || (!from.inPr && !to.inPr)) continue;
      keep.add(edge.from);
      keep.add(edge.to);
    }
    // Keep the class around a kept neighbour method so the map can group it.
    for (const id of [...keep]) {
      const parentId = byId.get(id)?.parentId;
      if (parentId) keep.add(parentId);
    }
    return symbols.filter((symbol) => symbol.inPr || keep.has(symbol.id));
  }

  private excluder(corrections: RepoCorrections): (path: string) => boolean {
    const patterns = [...defaultExcludes, ...corrections.exclude];
    return (path) => patterns.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: !pattern.includes("/") }));
  }

  private notes(files: ChangedFile[]): string[] {
    const notes: string[] = [];
    const unsupported = files.filter((file) => !file.language && !file.binary && !file.excluded);
    if (unsupported.length > 0) {
      notes.push(`${unsupported.length} changed file(s) aren't Python, TypeScript or JavaScript, so they appear in the file list but not on the function map.`);
    }
    const excluded = files.filter((file) => file.excluded);
    if (excluded.length > 0) notes.push(`${excluded.length} generated or excluded file(s) were left out of the map.`);
    return notes;
  }
}
