import { createHash } from "node:crypto";
import { reviewItems, type ReviewItem } from "@shared/review";
import type { Analysis, GitHubFileViewState, ReviewState } from "@shared/types";
import type { GitHubPrClient } from "../services/GitHubPrClient";
import type { AtlasStore, StoredReview } from "../store/AtlasStore";

/**
 * Atlas reviews per function. It reads GitHub's per-file "Viewed" box but never writes it:
 * a file ticked on github.com counts as read in Atlas, and unticking it there clears it again.
 */
export class ReviewService {
  constructor(
    private readonly store: AtlasStore,
    private readonly github: GitHubPrClient,
  ) {}

  state(key: string): ReviewState {
    return this.toPublic(this.store.review(key));
  }

  setViewed(key: string, ids: string[], viewed: boolean): ReviewState {
    const items = this.itemsById(this.requireAnalysis(key));
    const review = this.store.review(key);
    const set = new Set(review.viewed);
    for (const id of ids) {
      const item = items.get(id);
      if (!item) continue;
      if (viewed) {
        set.add(id);
        review.fingerprints[id] = this.fingerprint(item);
      } else {
        set.delete(id);
        delete review.fingerprints[id];
      }
    }
    review.viewed = [...set];
    review.changedSinceViewed = review.changedSinceViewed.filter((id) => !ids.includes(id));
    this.store.saveReview(key, review);
    return this.toPublic(review);
  }

  /** Unmarks items whose code changed since they were viewed, then picks up ticks made on github.com. */
  async sync(key: string): Promise<ReviewState> {
    const analysis = this.requireAnalysis(key);
    const items = this.itemsById(analysis);
    const review = this.store.review(key);
    const justChanged = this.invalidateChanged(review, items);

    try {
      const states = await this.github.viewedStates(analysis.pr);
      const tickedNow: string[] = [];
      for (const [path, pathItems] of this.itemsByPath(items)) {
        const remote: GitHubFileViewState = states.get(path) ?? "UNVIEWED";
        const wasTicked = review.githubViewedFiles.includes(path);
        if (remote === "VIEWED") {
          tickedNow.push(path);
          // A newly ticked file counts as read, unless Atlas just saw new code in one of its functions.
          if (!wasTicked && !pathItems.some((item) => justChanged.has(item.id))) {
            for (const item of pathItems) this.mark(review, item);
          }
        } else if (wasTicked) {
          // Ticked at the last sync and not any more: unticked on github.com.
          this.unmark(review, pathItems);
        }
      }
      review.githubViewedFiles = tickedNow;
      review.githubSync = { ok: true, message: null, syncedAt: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      review.githubSync = { ok: false, message: `Couldn't read GitHub's Viewed boxes: ${message.slice(0, 200)}`, syncedAt: review.githubSync.syncedAt };
    }
    this.store.saveReview(key, review);
    return this.toPublic(review);
  }

  /** Returns the ids that this call found changed. */
  private invalidateChanged(review: StoredReview, items: Map<string, ReviewItem>): Set<string> {
    const changed = new Set(review.changedSinceViewed.filter((id) => items.has(id)));
    const newlyChanged = new Set<string>();
    const stillViewed: string[] = [];
    for (const id of review.viewed) {
      const item = items.get(id);
      if (!item) {
        delete review.fingerprints[id];
        continue;
      }
      const current = this.fingerprint(item);
      // Reviews saved before fingerprints existed adopt the current code instead of being reset.
      if (review.fingerprints[id] === undefined) review.fingerprints[id] = current;
      if (review.fingerprints[id] === current) {
        stillViewed.push(id);
      } else {
        changed.add(id);
        newlyChanged.add(id);
        delete review.fingerprints[id];
      }
    }
    review.viewed = stillViewed;
    review.changedSinceViewed = [...changed].filter((id) => !stillViewed.includes(id));
    return newlyChanged;
  }

  private mark(review: StoredReview, item: ReviewItem): void {
    if (!review.viewed.includes(item.id)) review.viewed.push(item.id);
    review.fingerprints[item.id] = this.fingerprint(item);
    review.changedSinceViewed = review.changedSinceViewed.filter((id) => id !== item.id);
  }

  private unmark(review: StoredReview, items: ReviewItem[]): void {
    const ids = new Set(items.map((item) => item.id));
    review.viewed = review.viewed.filter((id) => !ids.has(id));
    for (const id of ids) delete review.fingerprints[id];
  }

  private itemsById(analysis: Analysis): Map<string, ReviewItem> {
    return new Map(reviewItems(analysis).map((item) => [item.id, item]));
  }

  private itemsByPath(items: Map<string, ReviewItem>): Map<string, ReviewItem[]> {
    const byPath = new Map<string, ReviewItem[]>();
    for (const item of items.values()) byPath.set(item.path, [...(byPath.get(item.path) ?? []), item]);
    return byPath;
  }

  private fingerprint(item: ReviewItem): string {
    return createHash("sha1").update(item.content).digest("hex");
  }

  private requireAnalysis(key: string): Analysis {
    const analysis = this.store.loadAnalysis(key);
    if (!analysis) throw new Error(`No saved analysis for ${key}`);
    return analysis;
  }

  private toPublic(review: StoredReview): ReviewState {
    return { viewed: review.viewed, changedSinceViewed: review.changedSinceViewed, githubSync: review.githubSync };
  }
}
