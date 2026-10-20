/**
 * Explicitly expose only safe path-validation errors from a physical Windows Host.
 * Unknown host errors stay internal: never leak host paths, secrets or stack traces.
 */
const PUBLIC_WORKSPACE_ERRORS = new Set([
  "Workspace path must be relative",
  "Workspace path escapes its allowed root",
  "Windows workspace path is not a directory",
  "Workspace path is not a directory",
  "Workspace file path must be relative",
  "Workspace file path escapes its allowed root",
  "Workspace links are not accessible",
  "Windows process cwd is outside the registered trusted directories for this bot",
  "Invalid trusted Windows process working directory",
  "Trusted Windows process directory contains a link or non-directory",
  "Trusted Windows process directory escapes its registered root",
]);

export function publicWindowsWorkspaceError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return PUBLIC_WORKSPACE_ERRORS.has(error.message) ? error.message : null;
}
