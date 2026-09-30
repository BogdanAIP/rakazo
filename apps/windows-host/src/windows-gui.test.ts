import { describe, expect, it, vi } from "vitest";
import { WindowsGuiBackend, windowsGuiAvailable } from "./windows-gui.js";

const observation = {
  imageBase64: Buffer.from("PNG_TEST").toString("base64"),
  mimeType: "image/png" as const,
  width: 1920,
  height: 1080,
  cursor: { x: 100, y: 200 },
  activeWindow: { id: "101", title: "Notepad" },
};

describe("WindowsGuiBackend", () => {
  it("requires a real Windows OS, the checked-in script and the explicit feature flag", () => {
    expect(windowsGuiAvailable("linux", true, process.execPath)).toBe(false);
    expect(windowsGuiAvailable("win32", false, process.execPath)).toBe(false);
    expect(windowsGuiAvailable("win32", true, process.execPath)).toBe(true);
  });

  it("returns a typed physical observation from a native executor", async () => {
    const runner = vi.fn(async () => ({ kind: "observation" as const, observation }));
    const backend = new WindowsGuiBackend(runner, () => true);
    await expect(backend.execute({ command: "observe" })).resolves.toMatchObject({
      kind: "observation",
      observation: { width: 1920, height: 1080 },
    });
    expect(runner).toHaveBeenCalledWith({ command: "observe" });
  });

  it("validates the action count and does not invoke an unavailable GUI", async () => {
    const runner = vi.fn(async () => ({ kind: "actions" as const, completed: 1 }));
    const backend = new WindowsGuiBackend(runner, () => false);
    await expect(backend.execute({
      command: "act", actions: [{ kind: "key", key: "Return" }], observe: false,
    })).rejects.toThrow("not enabled");
    expect(runner).not.toHaveBeenCalled();
  });

  it("routes a bounded pointer batch without generating PowerShell code", async () => {
    const runner = vi.fn(async () => ({ kind: "actions" as const, completed: 1 }));
    const backend = new WindowsGuiBackend(runner, () => true);
    const request = {
      command: "act" as const,
      actions: [{ kind: "pointer" as const, x: 200, y: 300, type: "click" as const }],
      observe: false,
    };
    await expect(backend.execute(request)).resolves.toMatchObject({
      kind: "actions", completed: 1,
    });
    expect(runner).toHaveBeenCalledWith(request);
  });
});
