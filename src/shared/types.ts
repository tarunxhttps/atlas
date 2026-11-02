import type { Narrative } from "./narrative";

export type Delta = "added" | "modified" | "removed" | "unchanged";
export type LanguageId = "python" | "typescript" | "tsx" | "javascript";
export type SymbolKind = "function" | "method" | "class";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrMeta extends PrRef {
  url: string;
  title: string;
  body: string;
  author: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  language: LanguageId | null;
  excluded: boolean;
  hunks: DiffHunk[];
}

export interface SymbolSide {
  startLine: number;
  endLine: number;
  signature: string;
  code: string;
}

export interface CodeSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
  language: LanguageId;
  parentId: string | null;
  delta: Delta;
  formattingOnly: boolean;
  movedFrom: string | null;
  /** False for neighbours found outside the PR's files (the blast radius). */
  inPr: boolean;
  head: SymbolSide | null;
  base: SymbolSide | null;
  additions: number;
  deletions: number;
}

export interface CallEdge {
  id: string;
  from: string;
  to: string;
  /** "reference": the code names a class (type hint, isinstance, attribute) without calling it. Missing means "call". */
  kind?: "call" | "reference";
  delta: Delta;
  /** The head still calls a symbol this PR removed. */
  dangling: boolean;
}

export interface AnalysisFacts {
  files: ChangedFile[];
  symbols: CodeSymbol[];
  calls: CallEdge[];
  notes: string[];
}

export type NarrativeStatus = "pending" | "ready" | "failed" | "disabled";

export interface Analysis {
  key: string;
  pr: PrMeta;
  facts: AnalysisFacts;
  narrative: Narrative | null;
  narrativeStatus: NarrativeStatus;
  narrativeError: string | null;
  narrativeModel: string | null;
  createdAt: string;
  /** How the facts were parsed; a saved analysis from an older parser is re-parsed rather than loaded. */
  factsVersion?: number;
  /** Classes whose usages were searched for across the whole repo (when isolated). */
  expandedUsages?: string[];
}

export type ProgressStage = "fetch" | "clone" | "diff" | "parse" | "graph" | "ai" | "done" | "error";

export interface ProgressEvent {
  key: string;
  stage: ProgressStage;
  message: string;
}

export interface RecentEntry {
  key: string;
  url: string;
  title: string;
  /** Missing on entries saved before authors were recorded; filled from the saved analysis when listed. */
  author?: string;
  headSha: string;
  openedAt: string;
}

export interface RepoCorrections {
  exclude: string[];
  rename: Record<string, string>;
  lanePins: Record<string, string>;
}

export type AiProviderId = "claude-cli" | "anthropic-api";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThemePreference = "system" | "light" | "dark";

export interface Settings {
  aiProvider: AiProviderId;
  model: string;
  effort: Effort;
  autoNarrative: boolean;
  maxNeighbourFiles: number;
  theme: ThemePreference;
  corrections: Record<string, RepoCorrections>;
  hasApiKey: boolean;
}

export interface SettingsPatch extends Partial<Omit<Settings, "hasApiKey">> {
  /** Empty string clears the stored key. */
  anthropicApiKey?: string;
}

export interface ReviewState {
  viewed: string[];
  /** Viewed before, but the code changed in a newer commit. */
  changedSinceViewed: string[];
  githubSync: { ok: boolean; message: string | null; syncedAt: string | null };
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface PrUpdate {
  headSha: string;
  state: string;
  /** The head Atlas has analysed is no longer in the branch history. */
  forcePushed: boolean;
  commits: CommitInfo[];
  checkedAt: string;
}

export type GitHubFileViewState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export interface ToolStatus {
  gh: string | null;
  git: string | null;
  claude: string | null;
  ghAuthenticated: boolean;
}

export interface ChatTurn {
  question: string;
  answer: string;
  highlightIds: string[];
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function repoKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}`;
}
