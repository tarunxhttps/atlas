const testPath = /(^|\/)(tests?|__tests__|__mocks__|spec|specs)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)conftest\.py$/;

export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

export function isTestPath(path: string): boolean {
  return testPath.test(path);
}
