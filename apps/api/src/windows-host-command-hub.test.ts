import { describe, expect, it } from "vitest";
import { WindowsHostCommandHub } from "./windows-host-command-hub.js";

describe("WindowsHostCommandHub", () => {
  it("delivers a queued command to the matching host and resolves its result", async () => {
    const hub = new WindowsHostCommandHub();
    const pending = hub.dispatch("host-a", { kind: "identity.get" });

    const command = await hub.poll("host-a", 1);
    expect(command?.request).toEqual({ kind: "identity.get" });

    expect(
      hub.settle("host-a", {
        id: command!.id,
        ok: true,
        result: {
          kind: "identity",
          identity: {
            installationId: "4f8f9018-9022-40f4-a99d-18de278fa4de",
            hostname: "test-host",
            platform: "win32",
            release: "10.0",
            arch: "x64",
          },
        },
      }),
    ).toBe(true);

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("does not leak commands across hosts", async () => {
    const hub = new WindowsHostCommandHub();
    const pending = hub.dispatch("host-a", { kind: "identity.get" });

    await expect(hub.poll("host-b", 1)).resolves.toBeNull();
    const command = await hub.poll("host-a", 1);
    expect(command).not.toBeNull();

    hub.close();
    await expect(pending).rejects.toThrow("closed");
  });

  it("removes an aborted command before delivery", async () => {
    const hub = new WindowsHostCommandHub();
    const controller = new AbortController();
    const pending = hub.dispatch("host-a", { kind: "identity.get" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    await expect(hub.poll("host-a", 1)).resolves.toBeNull();
  });
});
