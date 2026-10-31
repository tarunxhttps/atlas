import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { Analysis, RecentEntry, ReviewState, Settings, SettingsPatch } from "@shared/types";

/** Review progress for one PR. Fingerprints are hashes of the code as it was when marked viewed. */
export interface StoredReview {
  viewed: string[];
  fingerprints: Record<string, string>;
  changedSinceViewed: string[];
  /** Files ticked on github.com at the last sync, so an untick there can be told apart from a file never ticked. */
  githubViewedFiles: string[];
  githubSync: ReviewState["githubSync"];
}

export function emptyReview(): StoredReview {
  return { viewed: [], fingerprints: {}, changedSinceViewed: [], githubViewedFiles: [], githubSync: { ok: true, message: null, syncedAt: null } };
}

interface StoredSettings extends Omit<Settings, "hasApiKey"> {
  encryptedApiKey: string | null;
}

const defaultSettings: StoredSettings = {
  aiProvider: "claude-cli",
  model: "claude-opus-5-5",
  effort: "high",
  autoNarrative: true,
  maxNeighbourFiles: 60,
  theme: "system",
  corrections: {},
  encryptedApiKey: null,
};

/** JSON files under the app's data folder; one analysis file per PR head commit. */
export class AtlasStore {
  private readonly analysesDir: string;
  private readonly reviewDir: string;

  constructor(private readonly rootDir: string) {
    this.analysesDir = join(rootDir, "analyses");
    this.reviewDir = join(rootDir, "review");
    mkdirSync(this.analysesDir, { recursive: true });
    mkdirSync(this.reviewDir, { recursive: true });
  }

  settings(): Settings {
    const { encryptedApiKey, ...rest } = this.storedSettings();
    return { ...rest, hasApiKey: Boolean(encryptedApiKey) };
  }

  apiKey(): string | null {
    const { encryptedApiKey } = this.storedSettings();
    if (!encryptedApiKey) return null;
    return safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
  }

  saveSettings(patch: SettingsPatch): Settings {
    const { anthropicApiKey, ...rest } = patch;
    const next: StoredSettings = { ...this.storedSettings(), ...rest };
    if (anthropicApiKey !== undefined) {
      next.encryptedApiKey = anthropicApiKey ? safeStorage.encryptString(anthropicApiKey).toString("base64") : null;
    }
    this.writeJson(join(this.rootDir, "settings.json"), next);
    return this.settings();
  }

  saveAnalysis(analysis: Analysis): void {
    this.writeJson(this.analysisPath(analysis.key, analysis.pr.headSha), analysis);
    this.touchRecent({
      key: analysis.key,
      url: analysis.pr.url,
      title: analysis.pr.title,
      author: analysis.pr.author,
      headSha: analysis.pr.headSha,
      openedAt: new Date().toISOString(),
    });
  }

  loadAnalysis(key: string, headSha?: string): Analysis | null {
    const sha = headSha ?? this.recent().find((entry) => entry.key === key)?.headSha;
    if (!sha) return null;
    return this.readJson<Analysis | null>(this.analysisPath(key, sha), null);
  }

  recent(): RecentEntry[] {
    return this.readJson<RecentEntry[]>(join(this.rootDir, "recent.json"), []);
  }

  /** The recent list for the home page, with authors filled in for entries saved before they were recorded. */
  recentWithAuthors(): RecentEntry[] {
    return this.recent().map((entry) => (entry.author ? entry : { ...entry, author: this.loadAnalysis(entry.key, entry.headSha)?.pr.author }));
  }

  review(key: string): StoredReview {
    return { ...emptyReview(), ...this.readJson<Partial<StoredReview>>(join(this.reviewDir, `${this.slug(key)}.json`), {}) };
  }

  saveReview(key: string, review: StoredReview): void {
    this.writeJson(join(this.reviewDir, `${this.slug(key)}.json`), review);
  }

  private touchRecent(entry: RecentEntry): void {
    const rest = this.recent().filter((existing) => existing.key !== entry.key);
    this.writeJson(join(this.rootDir, "recent.json"), [entry, ...rest].slice(0, 50));
  }

  private storedSettings(): StoredSettings {
    return { ...defaultSettings, ...this.readJson<Partial<StoredSettings>>(join(this.rootDir, "settings.json"), {}) };
  }

  private analysisPath(key: string, headSha: string): string {
    return join(this.analysesDir, `${this.slug(key)}__${headSha.slice(0, 12)}.json`);
  }

  private slug(key: string): string {
    return key.replace(/[^A-Za-z0-9._-]+/g, "_");
  }

  private readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  // Write then rename so a crash mid-write can't leave a half-written file.
  private writeJson(path: string, value: unknown): void {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
  }
}
