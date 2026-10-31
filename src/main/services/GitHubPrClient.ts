import type { CommitInfo, GitHubFileViewState, PrMeta, PrRef, PrUpdate } from "@shared/types";
import type { CommandRunner } from "./CommandRunner";

interface GhPrView {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
}

export type PrMetaWithoutMergeBase = Omit<PrMeta, "mergeBaseSha">;

export class GitHubPrClient {
  private static readonly urlPattern = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
  private static readonly shortPattern = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

  constructor(private readonly runner: CommandRunner) {}

  parseRef(input: string): PrRef {
    const trimmed = input.trim();
    const match = GitHubPrClient.urlPattern.exec(trimmed) ?? GitHubPrClient.shortPattern.exec(trimmed);
    if (!match) throw new Error("That doesn't look like a PR link. Use https://github.com/owner/repo/pull/123 or owner/repo#123.");
    return { owner: match[1], repo: match[2].replace(/\.git$/, ""), number: Number(match[3]) };
  }

  async fetchMeta(ref: PrRef): Promise<PrMetaWithoutMergeBase> {
    const fields = [
      "number",
      "title",
      "body",
      "url",
      "state",
      "isDraft",
      "author",
      "baseRefName",
      "headRefName",
      "baseRefOid",
      "headRefOid",
      "additions",
      "deletions",
      "changedFiles",
      "createdAt",
      "updatedAt",
    ];
    const { stdout } = await this.runner.run(
      "gh",
      ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", fields.join(",")],
      { timeoutMs: 60_000 },
    );
    const view = JSON.parse(stdout) as GhPrView;
    return {
      ...ref,
      url: view.url,
      title: view.title,
      body: view.body ?? "",
      author: view.author?.login ?? "unknown",
      state: view.state,
      isDraft: view.isDraft,
      baseRef: view.baseRefName,
      headRef: view.headRefName,
      baseSha: view.baseRefOid,
      headSha: view.headRefOid,
      additions: view.additions,
      deletions: view.deletions,
      changedFiles: view.changedFiles,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  }

  /** New commits since `knownHeadSha`, or a force-push when that commit left the branch history. */
  async checkForUpdates(ref: PrRef, knownHeadSha: string): Promise<PrUpdate> {
    const { stdout } = await this.runner.run(
      "gh",
      ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "headRefOid,state"],
      { timeoutMs: 30_000 },
    );
    const head = JSON.parse(stdout) as { headRefOid: string; state: string };
    const update: PrUpdate = { headSha: head.headRefOid, state: head.state, forcePushed: false, commits: [], checkedAt: new Date().toISOString() };
    if (head.headRefOid === knownHeadSha) return update;

    try {
      const compare = await this.runner.run(
        "gh",
        ["api", `repos/${ref.owner}/${ref.repo}/compare/${knownHeadSha}...${head.headRefOid}`, "--jq", "{status, commits: [.commits[] | {sha, message: .commit.message, author: (.author.login // .commit.author.name), date: .commit.author.date}]}"],
        { timeoutMs: 30_000 },
      );
      const result = JSON.parse(compare.stdout) as { status: string; commits: CommitInfo[] };
      update.forcePushed = result.status !== "ahead";
      update.commits = result.commits.map((commit) => ({ ...commit, message: commit.message.split("\n")[0] })).reverse();
    } catch {
      // GitHub can't compare against a commit a force-push removed.
      update.forcePushed = true;
    }
    return update;
  }

  /** Read-only: Atlas never changes GitHub's Viewed boxes. */
  async viewedStates(ref: PrRef): Promise<Map<string, GitHubFileViewState>> {
    const query = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } }
        }
      }
    }`;
    const states = new Map<string, GitHubFileViewState>();
    let after: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repo}`, "-F", `number=${ref.number}`];
      if (after) args.push("-f", `after=${after}`);
      const { stdout } = await this.runner.run("gh", args, { timeoutMs: 30_000 });
      const page = JSON.parse(stdout).data.repository.pullRequest as {
        files: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { path: string; viewerViewedState: GitHubFileViewState }[] };
      };
      for (const file of page.files.nodes) states.set(file.path, file.viewerViewedState);
      after = page.files.pageInfo.hasNextPage ? page.files.pageInfo.endCursor : null;
    } while (after);
    return states;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.runner.run("gh", ["auth", "status"], { timeoutMs: 20_000 });
      return true;
    } catch {
      return false;
    }
  }
}
