import { createContext, useContext } from "react";
import type { PrMeta, ReviewState } from "@shared/types";
import type { AnalysisModel } from "./AnalysisModel";

export interface WorkspaceApi {
  model: AnalysisModel;
  selectedIds: string[];
  highlightIds: Set<string>;
  review: ReviewState;
  /** Selects an entity and moves the canvas to wherever it lives. */
  reveal: (id: string, options?: { additive?: boolean }) => void;
  setHighlight: (ids: string[]) => void;
  toggleViewed: (ids: string[], viewed: boolean) => void;
  isolate: (id: string | null) => void;
  github: GitHubLinks;
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace must be used inside a Workspace");
  return api;
}

export class GitHubLinks {
  constructor(private readonly pr: PrMeta) {}

  blob(path: string, side: "head" | "base", startLine?: number, endLine?: number): string {
    const sha = side === "head" ? this.pr.headSha : this.pr.mergeBaseSha;
    const range = startLine ? `#L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ""}` : "";
    return `https://github.com/${this.pr.owner}/${this.pr.repo}/blob/${sha}/${path}${range}`;
  }

  /** GitHub anchors each file in the PR diff by the SHA-256 of its path. */
  async prDiff(path: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${this.pr.url}/files#diff-${hex}`;
  }

  open(url: string): void {
    void window.atlas.openExternal(url);
  }
}
