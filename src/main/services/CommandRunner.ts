import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Exit codes treated as success; git grep exits 1 when nothing matches. */
  okCodes?: number[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${command} failed${code === null ? "" : ` (exit ${code})`}: ${stderr.trim().slice(0, 600)}`);
  }
}

export class CommandRunner {
  // An app launched from Finder gets a bare PATH, so look where Homebrew and the Claude installer put binaries.
  private static readonly extraDirs = [
    join(homedir(), "homebrew/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    "/usr/bin",
    "/bin",
  ];

  private readonly env: NodeJS.ProcessEnv;
  private readonly searchDirs: string[];

  constructor() {
    const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
    this.searchDirs = [...new Set([...CommandRunner.extraDirs, ...pathDirs])];
    this.env = {
      ...process.env,
      PATH: this.searchDirs.join(":"),
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    };
  }

  resolve(binary: string): string | null {
    for (const dir of this.searchDirs) {
      const candidate = join(dir, binary);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  require(binary: string): string {
    const found = this.resolve(binary);
    if (!found) throw new Error(`Could not find \`${binary}\` on this Mac. Install it and restart Atlas.`);
    return found;
  }

  run(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const executable = this.require(binary);
    const maxBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
    const okCodes = options.okCodes ?? [0];
    const label = `${binary} ${args.slice(0, 3).join(" ")}`;

    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;

      const finish = (error: Error | null, result?: RunResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise(result!);
      };

      const timer = options.timeoutMs
        ? setTimeout(() => {
            child.kill("SIGTERM");
            finish(new CommandError(label, null, `timed out after ${Math.round(options.timeoutMs! / 1000)}s`));
          }, options.timeoutMs)
        : null;

      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          child.kill("SIGTERM");
          finish(new CommandError(label, null, "output exceeded the size limit"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? -1,
        };
        if (okCodes.includes(result.code)) finish(null, result);
        else finish(new CommandError(label, code, result.stderr || result.stdout));
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}
