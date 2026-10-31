import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PrRef } from "@shared/types";
import type { CommandRunner } from "./CommandRunner";

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/**
 * One blobless clone per repo under the app's data folder. Blobless keeps the first clone small;
 * checking out the PR head then pulls just that tree's blobs so git grep runs on local files.
 */
export class RepoMirror {
  constructor(
    private readonly runner: CommandRunner,
    private readonly rootDir: string,
  ) {}

  directoryFor(ref: PrRef): string {
    return join(this.rootDir, "repos", ref.owner, ref.repo);
  }

  async ensureClone(ref: PrRef): Promise<string> {
    const dir = this.directoryFor(ref);
    if (existsSync(join(dir, ".git"))) return dir;
    mkdirSync(join(this.rootDir, "repos", ref.owner), { recursive: true });
    await this.runner.run(
      "gh",
      ["repo", "clone", `${ref.owner}/${ref.repo}`, dir, "--", "--filter=blob:none", "--no-checkout", "--quiet"],
      { timeoutMs: 30 * 60_000 },
    );
    return dir;
  }

  async fetchPr(dir: string, number: number, baseRef: string): Promise<void> {
    await this.git(
      dir,
      [
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "origin",
        `+refs/pull/${number}/head:refs/atlas/pull/${number}`,
        `+refs/heads/${baseRef}:refs/atlas/base/${baseRef}`,
      ],
      true,
      15 * 60_000,
    );
  }

  async mergeBase(dir: string, baseSha: string, headSha: string): Promise<string> {
    const { stdout } = await this.git(dir, ["merge-base", baseSha, headSha]);
    return stdout.trim();
  }

  async checkout(dir: string, sha: string): Promise<void> {
    await this.git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", sha], true, 30 * 60_000);
  }

  async diff(dir: string, fromSha: string, toSha: string): Promise<string> {
    const { stdout } = await this.git(dir, ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", fromSha, toSha], true, 10 * 60_000);
    return stdout;
  }

  async show(dir: string, sha: string, path: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(dir, ["show", `${sha}:${path}`], true, 5 * 60_000);
      return stdout;
    } catch {
      return null;
    }
  }

  /** Whole-word matches in the checked-out tree, for the given file globs. */
  async grepWords(dir: string, words: string[], globs: string[]): Promise<GrepHit[]> {
    if (words.length === 0) return [];
    const alternation = words.map((word) => word.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&")).join("|");
    // One PCRE alternation is ~75x faster than many `-w -F -e` patterns on a large repo (0.4s vs 28s).
    const run = (pattern: string[]) =>
      this.runner.run("git", ["-C", dir, "grep", "-n", "-I", "--no-color", ...pattern, "--", ...globs], {
        okCodes: [0, 1],
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
    const { stdout } = await run(["-P", `\\b(?:${alternation})\\b`]).catch(() => run(["-w", "-E", `(${alternation})`]));
    const hits: GrepHit[] = [];
    for (const row of stdout.split("\n")) {
      const match = /^(.+?):(\d+):(.*)$/.exec(row);
      if (match) hits.push({ path: match[1], line: Number(match[2]), text: match[3] });
    }
    return hits;
  }

  private git(dir: string, args: string[], network = false, timeoutMs = 120_000) {
    const auth = network ? this.credentialArgs() : [];
    return this.runner.run("git", ["-C", dir, ...auth, ...args], { timeoutMs });
  }

  // Reuse the gh login for git's network calls instead of relying on the user's global credential helper.
  private credentialArgs(): string[] {
    const gh = this.runner.resolve("gh");
    if (!gh) return [];
    return ["-c", "credential.helper=", "-c", `credential.helper=!${gh} auth git-credential`];
  }
}
