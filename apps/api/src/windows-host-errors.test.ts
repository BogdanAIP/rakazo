import { describe, expect, it } from "vitest";
import { publicWindowsWorkspaceError } from "./windows-host-errors.js";

describe("publicWindowsWorkspaceError", () => {
  it("exposes only recognized workspace validation failures", () => {
    expect(publicWindowsWorkspaceError(new Error("Workspace path must be relative"))).toBe(
      "Workspace path must be relative",
    );
    expect(
      publicWindowsWorkspaceError(
        new Error("Windows process cwd is outside the registered trusted directories for this bot"),
      ),
    ).toContain("trusted directories");
  });

  it("never leaks arbitrary internal errors or host secrets", () => {
    expect(publicWindowsWorkspaceError(new Error("ECONNREFUSED token=SECRET"))).toBeNull();
    expect(publicWindowsWorkspaceError(new Error("Workspace path must be relative: C:\\secret"))).toBeNull();
    expect(publicWindowsWorkspaceError("Workspace path must be relative")).toBeNull();
  });
});
