import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { WindowsHostCommandHub } from "./windows-host-command-hub.js";
import { WindowsHostSandboxProvider } from "./windows-host-sandbox.js";

const context = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "owner-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

describe("WindowsHostSandboxProvider", () => {
  it("provisions the latest live paired host as a normal desktop computer", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "host-1" });
    const provider = new WindowsHostSandboxProvider(
      { windowsHost: { findFirst } } as unknown as PrismaClient,
      new WindowsHostCommandHub(),
    );

    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/home/rakazo" },
      context,
    );

    expect(computer).toMatchObject({
      botId: "bot-1",
      kind: "desktop",
      providerRef: "host-1",
      fresh: false,
    });
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("verifies the paired installation identity during prepare", async () => {
    const installationId = "4f8f9018-9022-40f4-a99d-18de278fa4de";
    const findFirst = vi.fn().mockResolvedValue({ installationId });
    const hub = new WindowsHostCommandHub();
    const provider = new WindowsHostSandboxProvider(
      { windowsHost: { findFirst } } as unknown as PrismaClient,
      hub,
    );
    const computer = {
      id: "desktop-bot-1",
      botId: "bot-1",
      kind: "desktop" as const,
      providerRef: "host-1",
      fresh: false,
    };

    const preparing = provider.prepare(computer, context);
    const command = await hub.poll("host-1", 1);
    expect(command?.request).toEqual({ kind: "identity.get" });
    hub.settle("host-1", {
      id: command!.id,
      ok: true,
      result: {
        kind: "identity",
        identity: {
          installationId,
          hostname: "target-host",
          platform: "win32",
          release: "10.0",
          arch: "x64",
        },
      },
    });

    await expect(preparing).resolves.toBeUndefined();
  });

  it("fails closed when no connected host belongs to the current owner", async () => {
    const provider = new WindowsHostSandboxProvider(
      {
        windowsHost: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient,
      new WindowsHostCommandHub(),
    );

    await expect(
      provider.provision({ botId: "bot-1", homePath: "/home/rakazo" }, context),
    ).rejects.toThrow("No connected Windows host");
  });
  it("routes bounded workspace reads with bot and owner identity", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        id: "35633dcb-8c94-4f55-9517-8b76f28676df",
        ok: true,
        result: {
          kind: "files",
          entries: [{ path: "sample.txt", kind: "file", size: 5 }],
        },
      })
      .mockResolvedValueOnce({
        id: "35633dcb-8c94-4f55-9517-8b76f28676df",
        ok: true,
        result: { kind: "file", contentBase64: Buffer.from("HELLO").toString("base64") },
      });
    const provider = new WindowsHostSandboxProvider({} as PrismaClient, { dispatch });
    const computer = {
      id: "desktop-bot-1",
      botId: "bot-1",
      kind: "desktop" as const,
      providerRef: "host-1",
    };

    await expect(provider.listFiles(computer, ".", context)).resolves.toEqual([
      { path: "sample.txt", kind: "file", size: 5 },
    ]);
    await expect(
      provider.readFile(computer, "sample.txt", context, { maxBytes: 5 }),
    ).resolves.toEqual(new Uint8Array(Buffer.from("HELLO")));
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "host-1",
      { kind: "files.list", botId: "bot-1", directory: "." },
      context.signal,
      undefined,
      "owner-1",
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "host-1",
      { kind: "files.read", botId: "bot-1", path: "sample.txt", maxBytes: 5 },
      context.signal,
      undefined,
      "owner-1",
    );
    await expect(
      provider.readFile(computer, "sample.txt", context, { maxBytes: 65_537 }),
    ).rejects.toThrow("64 KiB");
  });

  it("routes tasklist and bounded argv execution through the paired Windows host", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        id: "35633dcb-8c94-4f55-9517-8b76f28676df",
        ok: true,
        result: { kind: "processes", processes: [{ pid: 123, name: "notepad.exe" }] },
      })
      .mockResolvedValueOnce({
        id: "35633dcb-8c94-4f55-9517-8b76f28676df",
        ok: true,
        result: {
          kind: "process",
          value: { stdout: "hello\n", stderr: "", code: 0 },
        },
      });
    const provider = new WindowsHostSandboxProvider({} as PrismaClient, { dispatch });
    const computer = {
      id: "desktop-bot-1",
      botId: "bot-1",
      kind: "desktop" as const,
      providerRef: "host-1",
    };

    const inventory = [];
    for await (const event of provider.execute(computer, { argv: ["tasklist"] }, context)) {
      inventory.push(event);
    }
    expect(inventory).toEqual([
      { type: "stdout", data: '[{"pid":123,"name":"notepad.exe"}]' },
      { type: "exit", code: 0 },
    ]);

    const executed = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["cmd.exe", "/d", "/c", "echo", "hello"], timeoutMs: 5_000 },
      context,
    )) {
      executed.push(event);
    }
    expect(executed).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "host-1",
      {
        kind: "process.run",
        botId: "bot-1",
        argv: ["cmd.exe", "/d", "/c", "echo", "hello"],
        cwd: undefined,
        timeoutMs: 5_000,
      },
      context.signal,
      30_000,
      "owner-1",
    );
  });
});
