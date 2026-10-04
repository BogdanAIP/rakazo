import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  assertGithubContribution,
  authorizeGithubFork,
  githubAuthenticatedLogin,
  registerGithubFork,
  verifiedFork,
} from "./github-fork-policy.js";

const server = "github-server";
const context: AdapterContext = {
  operationId: "test",
  traceId: "trace",
  botId: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  projectId: "project-1",
  signal: new AbortController().signal,
};
const dest = {
  kind: "github.fork.destination",
  ref: "BogdanAIP",
  metadata: { githubAccess: "allow_fork", githubMcpServerId: server },
};
const upstream = {
  kind: "github.pr.upstream",
  ref: "otherproject/library#bogdanaip/library",
  metadata: {
    githubAccess: "contribute_via_pr",
    githubMcpServerId: server,
    upstream: "otherproject/library",
    forkRef: "bogdanaip/library",
    verifiedFork: true,
  },
};
const fork = {
  kind: "github.repo",
  ref: "bogdanaip/library",
  metadata: {
    githubAccess: "autonomous_write",
    githubMcpServerId: server,
    forkOf: "otherproject/library",
    verifiedFork: true,
  },
};
const apiResponse = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        full_name: "BogdanAIP/library",
        fork: true,
        owner: { login: "BogdanAIP" },
        parent: { full_name: "OtherProject/library" },
      }),
    },
  ],
};
function fixture(rows: unknown[] = [dest]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const findFirst = vi.fn().mockResolvedValue({ id: "project-1" });
  const create = vi.fn().mockResolvedValue({ id: "new-resource" });
  const persisted: unknown[] = [];
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    const staged: unknown[] = [];
    const result = await run({
      project: { findFirst },
      projectResource: {
        findMany,
        create: async (args: unknown) => {
          const created = await create(args);
          staged.push(args);
          return created;
        },
      },
    });
    persisted.push(...staged);
    return result;
  });
  return {
    db: {
      project: { findFirst },
      projectResource: { findMany, create },
      $transaction: transaction,
    } as never,
    findMany,
    create,
    persisted,
    transaction,
  };
}

describe("safe fork and upstream PR permissions", () => {
  it("resolves the OAuth identity from GitHub MCP get_me, not caller args", () => {
    expect(
      githubAuthenticatedLogin({ content: [{ type: "text", text: '{"login":"BogdanAIP"}' }] }),
    ).toBe("bogdanaip");
    expect(() => githubAuthenticatedLogin({ isError: true })).toThrow();
    expect(() =>
      githubAuthenticatedLogin({ content: [{ type: "text", text: '{"login":"unknown/user"}' }] }),
    ).toThrow();
  });
  it("permits forking external source only into an explicitly granted destination", async () => {
    const f = fixture();
    await expect(
      authorizeGithubFork(
        f.db,
        context,
        server,
        {
          owner: "OtherProject",
          repo: "library",
        },
        "BogdanAIP",
      ),
    ).resolves.toEqual({
      source: "otherproject/library",
      destination: "bogdanaip",
    });
    await expect(
      authorizeGithubFork(
        f.db,
        context,
        server,
        {
          owner: "OtherProject",
          repo: "library",
          organization: "OtherOrg",
        },
        "BogdanAIP",
      ),
    ).rejects.toThrow("no allow_fork");
    await expect(
      authorizeGithubFork(
        f.db,
        context,
        "other-server",
        {
          owner: "OtherProject",
          repo: "library",
        },
        "BogdanAIP",
      ),
    ).rejects.toThrow("no allow_fork");
  });
  it("registers writable fork only after GitHub returns verified fork + parent", async () => {
    const f = fixture();
    const planned = { source: "otherproject/library", destination: "bogdanaip" };
    expect(verifiedFork(apiResponse, planned.source, planned.destination)).toBe(
      "bogdanaip/library",
    );
    await expect(registerGithubFork(f.db, context, server, planned, apiResponse)).resolves.toBe(
      true,
    );
    expect(f.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "github.repo",
        ref: "bogdanaip/library",
        metadata: expect.objectContaining({
          githubAccess: "autonomous_write",
          forkOf: "otherproject/library",
          verifiedFork: true,
          githubMcpServerId: server,
        }),
      }),
    });
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "github.pr.upstream",
        ref: "otherproject/library#bogdanaip/library",
        metadata: expect.objectContaining({
          githubAccess: "contribute_via_pr",
          upstream: "otherproject/library",
          forkRef: "bogdanaip/library",
          verifiedFork: true,
        }),
      }),
    });
  });
  it("atomically rolls back both grants when the second insert fails", async () => {
    const f = fixture();
    f.create
      .mockResolvedValueOnce({ id: "first" })
      .mockRejectedValueOnce(new Error("second insert failed"));
    await expect(
      registerGithubFork(
        f.db,
        context,
        server,
        {
          source: "otherproject/library",
          destination: "bogdanaip",
        },
        apiResponse,
      ),
    ).resolves.toBe(false);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.persisted).toHaveLength(0);
  });
  it("recognizes the official v1.14.0 CreateFork minimal receipt without exposing credentials", async () => {
    const f = fixture();
    const actual = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "123456",
            url: "https://github.com/BogdanAIP/library",
          }),
        },
      ],
    };
    expect(verifiedFork(actual, "otherproject/library", "bogdanaip")).toBe("bogdanaip/library");
    await expect(
      registerGithubFork(
        f.db,
        context,
        server,
        {
          source: "otherproject/library",
          destination: "bogdanaip",
        },
        actual,
      ),
    ).resolves.toBe(true);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it.each([
    { id: "0", url: "https://github.com/BogdanAIP/library" },
    { id: "123", url: "https://evil.example/BogdanAIP/library" },
    { id: "123", url: "https://github.com/OtherOrg/library" },
    { id: "123", url: "https://github.com/BogdanAIP/library/extra" },
    { id: "123", url: "https://github.com/BogdanAIP/library?redirect=1" },
  ])("never auto-grants malformed minimal fork receipts", (receipt) => {
    expect(
      verifiedFork(
        { content: [{ type: "text", text: JSON.stringify(receipt) }] },
        "otherproject/library",
        "bogdanaip",
      ),
    ).toBeNull();
  });
  it("does not infer a fork grant from an asynchronous GitHub progress message", () => {
    expect(
      verifiedFork(
        { content: [{ type: "text", text: "Fork is in progress" }] },
        "otherproject/library",
        "bogdanaip",
      ),
    ).toBeNull();
  });
  it.each([
    [{ isError: true }],
    [{ content: [{ type: "text", text: '{"full_name":"BogdanAIP/library","fork":true}' }] }],
    [
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              full_name: "AnotherUser/library",
              fork: true,
              owner: { login: "AnotherUser" },
              parent: { full_name: "OtherProject/library" },
            }),
          },
        ],
      },
    ],
    [
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              full_name: "BogdanAIP/library",
              fork: true,
              owner: { login: "BogdanAIP" },
              parent: { full_name: "OtherProject/other" },
            }),
          },
        ],
      },
    ],
  ])("never auto-grants for missing or inconsistent fork provenance", async (reply) => {
    const f = fixture(),
      planned = { source: "otherproject/library", destination: "bogdanaip" };
    await expect(registerGithubFork(f.db, context, server, planned, reply)).resolves.toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not auto-grant when the destination permission was revoked", async () => {
    const f = fixture([]);
    await expect(
      registerGithubFork(
        f.db,
        context,
        server,
        {
          source: "otherproject/library",
          destination: "bogdanaip",
        },
        apiResponse,
      ),
    ).resolves.toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not overwrite any existing resource/grant", async () => {
    const f = fixture([dest, fork]);
    await expect(
      registerGithubFork(
        f.db,
        context,
        server,
        {
          source: "otherproject/library",
          destination: "bogdanaip",
        },
        apiResponse,
      ),
    ).resolves.toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("allows a fork PR only with upstream grant and linked writable fork", async () => {
    const f = fixture([upstream, fork]);
    const args = {
      owner: "OtherProject",
      repo: "library",
      head: "BogdanAIP:feature/change",
      base: "main",
    };
    await expect(assertGithubContribution(f.db, context, server, args)).resolves.toBe(
      "otherproject/library",
    );
    for (const rows of [
      [upstream],
      [fork],
      [upstream, { ...fork, metadata: { ...fork.metadata, forkOf: "OtherProject/another" } }],
    ]) {
      const denied = fixture(rows);
      await expect(assertGithubContribution(denied.db, context, server, args)).rejects.toThrow(
        "requires upstream PR grant",
      );
    }
    await expect(
      assertGithubContribution(f.db, context, server, {
        ...args,
        head: "SomeoneElse:branch",
      }),
    ).rejects.toThrow("requires upstream PR grant");
    await expect(
      assertGithubContribution(f.db, context, server, {
        ...args,
        head_repo: "SomeoneElse/library",
      }),
    ).rejects.toThrow("Invalid or ambiguous");
  });
});
