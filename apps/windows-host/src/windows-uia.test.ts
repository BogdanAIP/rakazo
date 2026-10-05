import { describe, expect, it, vi } from "vitest";
import { WindowsUiaBackend, windowsUiaAvailable } from "./windows-uia.js";

const snapshot = {
  activeWindow: { id: "42", title: "Settings" },
  nodes: [
    {
      ref: "u1",
      depth: 0,
      controlType: "Window",
      name: "Settings",
      enabled: true,
      focusable: false,
      offscreen: false,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    },
    {
      ref: "u2",
      parentRef: "u1",
      depth: 1,
      controlType: "Button",
      name: "Save",
      automationId: "save-button",
      enabled: true,
      focusable: true,
      offscreen: false,
    },
  ],
  truncated: false,
};

describe("WindowsUiaBackend", () => {
  it("requires Windows, the checked-in script and an explicit feature flag", () => {
    expect(windowsUiaAvailable("linux", true, process.execPath)).toBe(false);
    expect(windowsUiaAvailable("win32", false, process.execPath)).toBe(false);
    expect(windowsUiaAvailable("win32", true, process.execPath)).toBe(true);
  });

  it("returns a bounded typed read-only UI Automation snapshot", async () => {
    const runner = vi.fn(async () => snapshot);
    const backend = new WindowsUiaBackend(runner, () => true);
    await expect(backend.snapshot()).resolves.toEqual(snapshot);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the runner when UI Automation is unavailable", async () => {
    const runner = vi.fn(async () => snapshot);
    const backend = new WindowsUiaBackend(runner, () => false);
    await expect(backend.snapshot()).rejects.toThrow("not enabled");
    expect(runner).not.toHaveBeenCalled();
  });
});
