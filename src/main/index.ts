import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import { IpcChannels, type ExportKind } from "@shared/ipc";
import { prKey, type Analysis, type ChatTurn, type ProgressEvent, type SettingsPatch, type ToolStatus } from "@shared/types";
import { AnthropicApiProvider } from "./ai/AnthropicApiProvider";
import { ClaudeCliProvider } from "./ai/ClaudeCliProvider";
import type { ClaudeProvider } from "./ai/ClaudeProvider";
import { NarrativeService } from "./ai/NarrativeService";
import { AnalysisPipeline } from "./analysis/AnalysisPipeline";
import { LanguageRegistry } from "./analysis/LanguageRegistry";
import { NeighbourFinder } from "./analysis/NeighbourFinder";
import { ReviewService } from "./review/ReviewService";
import { UsageFinder } from "./analysis/UsageFinder";
import { SymbolExtractor } from "./analysis/SymbolExtractor";
import { CommandRunner } from "./services/CommandRunner";
import { GitHubPrClient } from "./services/GitHubPrClient";
import { RepoMirror } from "./services/RepoMirror";
import { AtlasStore } from "./store/AtlasStore";

class AtlasApp {
  private window: BrowserWindow | null = null;
  private readonly runner = new CommandRunner();
  private readonly store: AtlasStore;
  private readonly github: GitHubPrClient;
  private readonly narratives: NarrativeService;
  private readonly pipeline: AnalysisPipeline;
  private readonly review: ReviewService;
  private readonly mirror: RepoMirror;

  constructor() {
    const dataDir = app.getPath("userData");
    this.store = new AtlasStore(dataDir);
    this.github = new GitHubPrClient(this.runner);
    const mirror = new RepoMirror(this.runner, dataDir);
    this.mirror = mirror;
    const extractor = new SymbolExtractor(new LanguageRegistry());
    this.narratives = new NarrativeService(() => this.provider());
    this.review = new ReviewService(this.store, this.github);
    this.pipeline = new AnalysisPipeline(
      this.github,
      mirror,
      extractor,
      new NeighbourFinder(mirror, extractor),
      this.narratives,
      this.store,
      new UsageFinder(mirror, extractor),
    );
  }

  start(): void {
    app.whenReady().then(() => {
      this.applyTheme();
      this.registerIpc();
      this.createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
      });
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
  }

  private createWindow(): void {
    const here = fileURLToPath(new URL(".", import.meta.url));
    this.window = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1100,
      minHeight: 700,
      title: "Atlas",
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#121316" : "#f7f7f5",
      webPreferences: {
        preload: join(here, "../preload/index.mjs"),
        // ESM preloads need the sandbox off; the renderer still has no Node access thanks to context isolation.
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    if (process.env.ELECTRON_RENDERER_URL) void this.window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void this.window.loadFile(join(here, "../renderer/index.html"));
  }

  private registerIpc(): void {
    ipcMain.handle(IpcChannels.analyze, (_event, url: string, force: boolean) =>
      this.pipeline.analyze(url, force, this.reporterFor(prKey(this.github.parseRef(url))), (analysis) => this.pushAnalysis(analysis)),
    );
    ipcMain.handle(IpcChannels.regenerateNarrative, (_event, key: string) =>
      this.pipeline.regenerate(key, this.reporterFor(key), (analysis) => this.pushAnalysis(analysis)),
    );
    ipcMain.handle(IpcChannels.loadAnalysis, (_event, key: string) => this.store.loadAnalysis(key));
    ipcMain.handle(IpcChannels.listRecent, () => this.store.recentWithAuthors());
    ipcMain.handle(IpcChannels.ask, (_event, key: string, question: string, focusIds: string[], history: ChatTurn[]) => {
      const analysis = this.store.loadAnalysis(key);
      if (!analysis) throw new Error(`No saved analysis for ${key}`);
      const settings = this.store.settings();
      return this.narratives.ask(analysis, question, focusIds, history, settings.model, settings.effort);
    });
    ipcMain.handle(IpcChannels.getSettings, () => this.store.settings());
    ipcMain.handle(IpcChannels.saveSettings, (_event, patch: SettingsPatch) => {
      const settings = this.store.saveSettings(patch);
      this.applyTheme();
      return settings;
    });
    ipcMain.handle(IpcChannels.getReviewState, (_event, key: string) => this.review.state(key));
    ipcMain.handle(IpcChannels.setViewed, (_event, key: string, ids: string[], viewed: boolean) => this.review.setViewed(key, ids, viewed));
    ipcMain.handle(IpcChannels.syncReview, (_event, key: string) => this.review.sync(key));
    ipcMain.handle(IpcChannels.findUsages, async (_event, key: string, symbolId: string) => {
      const analysis = await this.pipeline.expandUsages(key, symbolId);
      this.pushAnalysis(analysis);
      return analysis;
    });
    ipcMain.handle(IpcChannels.readFile, (_event, key: string, path: string, side: "head" | "base") => {
      const analysis = this.store.loadAnalysis(key);
      if (!analysis) throw new Error(`No saved analysis for ${key}`);
      const file = analysis.facts.files.find((candidate) => candidate.path === path);
      const atPath = side === "base" ? (file?.previousPath ?? path) : path;
      return this.mirror.show(this.mirror.directoryFor(analysis.pr), side === "head" ? analysis.pr.headSha : analysis.pr.mergeBaseSha, atPath);
    });
    ipcMain.handle(IpcChannels.checkForUpdates, (_event, key: string) => {
      const analysis = this.store.loadAnalysis(key);
      if (!analysis) throw new Error(`No saved analysis for ${key}`);
      return this.github.checkForUpdates(analysis.pr, analysis.pr.headSha);
    });
    ipcMain.handle(IpcChannels.exportFile, (_event, defaultName: string, kind: ExportKind, content: string) => this.exportFile(defaultName, kind, content));
    ipcMain.handle(IpcChannels.openExternal, (_event, url: string) => {
      if (/^https:\/\//.test(url)) return shell.openExternal(url);
      return undefined;
    });
    ipcMain.handle(IpcChannels.checkTools, () => this.checkTools());
  }

  private provider(): ClaudeProvider {
    const settings = this.store.settings();
    if (settings.aiProvider === "anthropic-api") {
      const key = this.store.apiKey();
      if (!key) throw new Error("Add an Anthropic API key in Settings, or switch the AI engine to the Claude Code CLI.");
      return new AnthropicApiProvider(key);
    }
    return new ClaudeCliProvider(this.runner);
  }

  private reporterFor(key: string) {
    return (stage: ProgressEvent["stage"], message: string) => {
      const event: ProgressEvent = { key, stage, message };
      this.window?.webContents.send(IpcChannels.progress, event);
    };
  }

  private pushAnalysis(analysis: Analysis): void {
    this.window?.webContents.send(IpcChannels.analysisUpdated, analysis);
  }

  private applyTheme(): void {
    nativeTheme.themeSource = this.store.settings().theme;
  }

  private async exportFile(defaultName: string, kind: ExportKind, content: string): Promise<string | null> {
    if (!this.window) return null;
    const result = await dialog.showSaveDialog(this.window, {
      defaultPath: this.freePath(app.getPath("downloads"), defaultName, kind),
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
    });
    if (result.canceled || !result.filePath) return null;
    const data = kind === "png" ? Buffer.from(content.replace(/^data:image\/png;base64,/, ""), "base64") : content;
    await writeFile(result.filePath, data);
    return result.filePath;
  }

  /** `name.kind`, or `name-1.kind`, `name-2.kind`, … when an earlier export already took it. */
  private freePath(dir: string, name: string, kind: ExportKind): string {
    let path = join(dir, `${name}.${kind}`);
    for (let copy = 1; existsSync(path); copy++) path = join(dir, `${name}-${copy}.${kind}`);
    return path;
  }

  private async checkTools(): Promise<ToolStatus> {
    return {
      gh: this.runner.resolve("gh"),
      git: this.runner.resolve("git"),
      claude: this.runner.resolve("claude"),
      ghAuthenticated: await this.github.isAuthenticated(),
    };
  }
}

new AtlasApp().start();
