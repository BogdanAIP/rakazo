import { describe, expect, it, vi } from "vitest";
import { RemoteWindowsHostCommandDispatcher } from "./windows-host-remote-dispatcher.js";

const identity = {
  installationId: "4f8f9018-9022-40f4-a99d-18de278fa4de",
  hostname: "windows-laptop",
  platform: "win32",
  release: "10.0",
  arch: "x64",
};

describe("RemoteWindowsHostCommandDispatcher", () => {
  it("sends a bounded typed worker dispatch without the token in the body", async () => {
    const token = "t".repeat(48);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
      expect(JSON.parse(String(init?.body))).toEqual({
        hostId: "host-a",
        ownerUserId: "owner-a",
        request: { kind: "identity.get" },
      });
      expect(String(init?.body)).not.toContain(token);
      return new Response(
        JSON.stringify({
          id: "35633dcb-8c94-4f55-9517-8b76f28676df",
          ok: true,
          result: { kind: "identity", identity },
        }),
        { status: 200 },
      );
    });

    const dispatcher = new RemoteWindowsHostCommandDispatcher(
      "http://api:3100",
      token,
      fetchImpl,
    );
    const result = await dispatcher.dispatch(
      "host-a",
      { kind: "identity.get" },
      undefined,
      undefined,
      "owner-a",
    );

    expect(result.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://api:3100/api/windows-host/internal/dispatch",
    );
  });

  it("refuses a missing owner and invalid internal credentials", async () => {
    expect(
      () => new RemoteWindowsHostCommandDispatcher("http://api:3100", "short"),
    ).toThrow("at least 32");
    const dispatcher = new RemoteWindowsHostCommandDispatcher(
      "http://api:3100",
      "t".repeat(48),
      vi.fn<typeof fetch>(),
    );
    await expect(dispatcher.dispatch("host-a", { kind: "identity.get" })).rejects.toThrow(
      "requires an owner",
    );
  });

  it("reports HTTP refusal without echoing secrets", async () => {
    const token = "t".repeat(48);
    const dispatcher = new RemoteWindowsHostCommandDispatcher(
      "http://api:3100",
      token,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      ),
    );
    await expect(
      dispatcher.dispatch("host-a", { kind: "identity.get" }, undefined, undefined, "owner-a"),
    ).rejects.toThrow("dispatch failed (401)");
  });
});
