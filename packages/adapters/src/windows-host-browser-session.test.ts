import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { WindowsHostSandboxProvider } from "./windows-host-sandbox.js";

const computer: ComputerRef = {
  id: "physical-one",
  botId: "bot-a",
  providerRef: "host-one",
  kind: "desktop",
};
const context: AdapterContext = {
  operationId: "browser-test",
  traceId: "browser-test",
  userId: "user-a",
  spaceId: "space-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};

describe("physical Windows browser session route", () => {
  it("refuses generic per-bot browser calls without opening a shared tab", async () => {
    const dispatch = vi.fn();
    const sandbox = new WindowsHostSandboxProvider({} as PrismaClient, { dispatch });
    expect(await sandbox.pageBrowser(computer, { command: "snapshot" }, context)).toMatchObject({
      ok: false,
      fallback: "computer_act",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes opaque session opens and close requests through the owner-scoped dispatcher", async () => {
    const token = "501fa589-44e8-4d12-8127-bcc6d18d0029";
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({
        id: "95d9ae2e-ff46-4d23-a8fb-f01e291296ca",
        ok: true,
        result: { kind: "browser", response: { ok: true, sessionToken: token } },
      })
      .mockResolvedValueOnce({
        id: "b9a498ff-7450-487d-a311-b5e5cc73ec63",
        ok: true,
        result: { kind: "browser", response: { ok: true } },
      });
    const sandbox = new WindowsHostSandboxProvider({} as PrismaClient, { dispatch });
    expect(await sandbox.desktopBrowserSession(computer, { command: "open" }, context)).toEqual({
      ok: true,
      sessionToken: token,
    });
    expect(
      await sandbox.desktopBrowserSession(
        computer,
        { command: "close", sessionToken: token },
        context,
      ),
    ).toEqual({ ok: true });
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      "host-one",
      { kind: "browser.call", botId: "bot-a", request: { command: "open" } },
      context.signal,
      30_000,
      "user-a",
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      "host-one",
      { kind: "browser.call", botId: "bot-a", request: { command: "close", sessionToken: token } },
      context.signal,
      30_000,
      "user-a",
    );
  });
});
