import { describe, expect, it, vi } from "vitest";
import { WindowsGuiBackend, windowsGuiAvailable } from "./windows-gui.js";

const observation = {
  imageBase64: Buffer.from("PNG_TEST").toString("base64"),
  mimeType: "image/png" as const,
  width: 1920,
  height: 1080,
  cursor: { x: 100, y: 200 },
  activeWindow: { id: "101", title: "Notepad" },
  uia: {
    source: "uia" as const,
    observationId: "a".repeat(64),
    truncated: false,
    elements: [
      {
        ref: "u1",
        role: "window",
        name: "Notepad",
        automationId: "MainWindow",
        className: "Notepad",
        enabled: true,
        focused: true,
        rect: { x: 20, y: 30, width: 800, height: 600 },
      },
      {
        ref: "u2",
        role: "edit",
        name: "Text editor",
        enabled: true,
        focused: false,
        rect: { x: 30, y: 70, width: 760, height: 540 },
      },
    ],
  },
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
      observation: {
        width: 1920,
        height: 1080,
        uia: {
          source: "uia",
          observationId: "a".repeat(64),
          truncated: false,
          elements: [
            expect.objectContaining({ ref: "u1", role: "window", name: "Notepad" }),
            expect.objectContaining({ ref: "u2", role: "edit", name: "Text editor" }),
          ],
        },
      },
    });
    expect(runner).toHaveBeenCalledWith({ command: "observe" });
  });

  it("validates the action count and does not invoke an unavailable GUI", async () => {
    const runner = vi.fn(async () => ({ kind: "actions" as const, completed: 1 }));
    const backend = new WindowsGuiBackend(runner, () => false);
    await expect(
      backend.execute({
        command: "act",
        actions: [{ kind: "key", key: "Return" }],
        observe: false,
      }),
    ).rejects.toThrow("not enabled");
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
      kind: "actions",
      completed: 1,
    });
    expect(runner).toHaveBeenCalledWith(request);
  });

  it("routes a semantic action only with the prior UIA observation guard", async () => {
    const runner = vi.fn(async () => ({
      kind: "actions" as const,
      completed: 1,
      observation,
    }));
    const backend = new WindowsGuiBackend(runner, () => true);
    const request = {
      command: "semanticAct" as const,
      semantic: {
        observationId: "a".repeat(64),
        windowId: "101",
        ref: "u2",
        action: "focus" as const,
      },
      observe: true,
    };
    await expect(backend.execute(request)).resolves.toMatchObject({
      kind: "actions",
      completed: 1,
      observation: { activeWindow: { id: "101" } },
    });
    expect(runner).toHaveBeenCalledWith(request);
  });

  it("blocks semantic retries after an uncertain action until a fresh observation", async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("Windows GUI timed out; action outcome is uncertain"))
      .mockResolvedValueOnce({ kind: "observation" as const, observation })
      .mockResolvedValueOnce({ kind: "actions" as const, completed: 1, observation });
    const backend = new WindowsGuiBackend(runner, () => true);
    const semantic = {
      command: "semanticAct" as const,
      semantic: {
        observationId: "a".repeat(64),
        windowId: "101",
        ref: "u2",
        action: "focus" as const,
      },
      observe: true,
    };

    await expect(backend.execute(semantic)).rejects.toThrow("outcome is uncertain");
    await expect(backend.execute(semantic)).rejects.toThrow("Fresh Windows observation required");
    expect(runner).toHaveBeenCalledTimes(1);

    await expect(backend.execute({ command: "observe" })).resolves.toMatchObject({
      kind: "observation",
    });
    await expect(backend.execute(semantic)).resolves.toMatchObject({
      kind: "actions",
      completed: 1,
    });
  });
});
