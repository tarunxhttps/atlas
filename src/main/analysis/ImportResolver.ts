import { posix } from "node:path";

/**
 * Decides whether an import names a given file. Relative imports resolve exactly. Absolute ones match
 * as a path suffix, since the repo may keep its code under `src/` or a service folder.
 */
export class ImportResolver {
  /** True when `module`, imported from `fromPath`, is the file at `targetPath` or a package containing it (re-exported). */
  provides(fromPath: string, module: string, targetPath: string): boolean {
    const stem = this.stem(targetPath);
    const dir = posix.dirname(targetPath);
    if (module.startsWith(".")) {
      const resolved = posix.normalize(posix.join(posix.dirname(fromPath), module));
      return stem === resolved || dir === resolved || resolved === "." || dir.startsWith(`${resolved}/`);
    }
    return `/${stem}`.endsWith(`/${module}`) || `/${dir}/`.includes(`/${module}/`);
  }

  /** `a/b.py` and `a/b/__init__.py` (or `a/b/index.ts`) are both the module `a/b`. */
  private stem(path: string): string {
    const withoutExtension = path.replace(/\.[^./]+$/, "");
    return withoutExtension.replace(/\/(__init__|index)$/, "");
  }
}
