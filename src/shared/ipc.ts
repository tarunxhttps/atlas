import type { ChatAnswer } from "./narrative";
import type {
  Analysis,
  ChatTurn,
  ProgressEvent,
  PrUpdate,
  RecentEntry,
  ReviewState,
  Settings,
  SettingsPatch,
  ToolStatus,
} from "./types";

export const IpcChannels = {
  analyze: "atlas:analyze",
  regenerateNarrative: "atlas:regenerate-narrative",
  loadAnalysis: "atlas:load-analysis",
  listRecent: "atlas:list-recent",
  ask: "atlas:ask",
  getSettings: "atlas:get-settings",
  saveSettings: "atlas:save-settings",
  getReviewState: "atlas:get-review-state",
  setViewed: "atlas:set-viewed",
  syncReview: "atlas:sync-review",
  checkForUpdates: "atlas:check-for-updates",
  readFile: "atlas:read-file",
  findUsages: "atlas:find-usages",
  exportFile: "atlas:export-file",
  openExternal: "atlas:open-external",
  checkTools: "atlas:check-tools",
  progress: "atlas:progress",
  analysisUpdated: "atlas:analysis-updated",
} as const;

export type ExportKind = "png" | "svg" | "json";

export interface AtlasApi {
  analyze(url: string, force: boolean): Promise<Analysis>;
  regenerateNarrative(key: string): Promise<void>;
  loadAnalysis(key: string): Promise<Analysis | null>;
  listRecent(): Promise<RecentEntry[]>;
  ask(key: string, question: string, focusIds: string[], history: ChatTurn[]): Promise<ChatAnswer>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: SettingsPatch): Promise<Settings>;
  getReviewState(key: string): Promise<ReviewState>;
  setViewed(key: string, ids: string[], viewed: boolean): Promise<ReviewState>;
  /** Re-checks viewed items against the latest code and syncs them with GitHub's "Viewed" boxes. */
  syncReview(key: string): Promise<ReviewState>;
  checkForUpdates(key: string): Promise<PrUpdate>;
  /** A file's full text at the PR head (or merge base), read from the local clone; null when it doesn't exist there. */
  readFile(key: string, path: string, side: "head" | "base"): Promise<string | null>;
  /** Searches the whole repo for code that calls or uses a class and adds it to the saved analysis. */
  findUsages(key: string, symbolId: string): Promise<Analysis>;
  exportFile(defaultName: string, kind: ExportKind, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  checkTools(): Promise<ToolStatus>;
  onProgress(listener: (event: ProgressEvent) => void): () => void;
  onAnalysisUpdated(listener: (analysis: Analysis) => void): () => void;
}
