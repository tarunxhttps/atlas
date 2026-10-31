import type { ChangedFile, DiffHunk, FileStatus } from "@shared/types";

type ParsedFile = Omit<ChangedFile, "language" | "excluded">;

export class UnifiedDiffParser {
  private static readonly hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

  parse(patch: string): ParsedFile[] {
    const files: ParsedFile[] = [];
    let current: ParsedFile | null = null;
    let hunk: DiffHunk | null = null;
    let oldNo = 0;
    let newNo = 0;

    for (const line of patch.split("\n")) {
      if (line.startsWith("diff --git ")) {
        current = this.startFile(line);
        files.push(current);
        hunk = null;
        continue;
      }
      if (!current) continue;

      if (!hunk) {
        this.readHeaderLine(current, line);
        const header = UnifiedDiffParser.hunkHeader.exec(line);
        if (header) {
          hunk = this.startHunk(header, line);
          current.hunks.push(hunk);
          oldNo = hunk.oldStart;
          newNo = hunk.newStart;
        }
        continue;
      }

      const header = UnifiedDiffParser.hunkHeader.exec(line);
      if (header) {
        hunk = this.startHunk(header, line);
        current.hunks.push(hunk);
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
      } else if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
        current.additions++;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
        current.deletions++;
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return files;
  }

  private startFile(line: string): ParsedFile {
    const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    const path = match ? this.unquote(match[2]) : line.slice("diff --git ".length);
    const previous = match ? this.unquote(match[1]) : path;
    return {
      path,
      previousPath: previous !== path ? previous : null,
      status: previous !== path ? "renamed" : "modified",
      additions: 0,
      deletions: 0,
      binary: false,
      hunks: [],
    };
  }

  private readHeaderLine(file: ParsedFile, line: string): void {
    const setStatus = (status: FileStatus) => (file.status = status);
    if (line.startsWith("new file mode")) setStatus("added");
    else if (line.startsWith("deleted file mode")) setStatus("removed");
    else if (line.startsWith("rename from ")) {
      file.previousPath = this.unquote(line.slice("rename from ".length));
      setStatus("renamed");
    } else if (line.startsWith("rename to ")) file.path = this.unquote(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = this.stripPrefix(line.slice(4));
    else if (line.startsWith("--- ") && line !== "--- /dev/null" && file.status === "removed") {
      file.path = this.stripPrefix(line.slice(4));
    }
  }

  private startHunk(header: RegExpExecArray, raw: string): DiffHunk {
    return {
      header: raw,
      oldStart: Number(header[1]),
      oldLines: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newLines: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
    };
  }

  private stripPrefix(path: string): string {
    return this.unquote(path).replace(/^[ab]\//, "");
  }

  private unquote(path: string): string {
    const trimmed = path.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\"/g, '"');
    return trimmed;
  }
}
