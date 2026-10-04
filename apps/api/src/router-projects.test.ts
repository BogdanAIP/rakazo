import { RPCHandler } from "@orpc/server/fetch";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function rpc(path: string, json: unknown) {
  return new Request(`http://127.0.0.1/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json }),
  });
}

function baseDeps(prisma: PrismaClient, connectors?: RouterDeps["connectors"]): RouterDeps {
  return {
    prisma,
    connectors:
      connectors ??
      ({
        managed: vi.fn(),
        managedProviders: vi.fn(() => []),
        discoverTools: vi.fn(async () => []),
        execute: vi.fn(),
      } as unknown as RouterDeps["connectors"]),
    secrets: {} as RouterDeps["secrets"],
    events: {} as RouterDeps["events"],
    jobs: {} as RouterDeps["jobs"],
    sandbox: {} as RouterDeps["sandbox"],
    memory: {} as RouterDeps["memory"],
    memoryProviders: {} as RouterDeps["memoryProviders"],
    home: {} as RouterDeps["home"],
    oauthLogins: {} as RouterDeps["oauthLogins"],
    artifacts: {} as RouterDeps["artifacts"],
    dataDir: "/tmp/rakazo-project-router-test",
    env: {
      agentRuntime: "pi",
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
  };
}

describe("projects", () => {
  it("returns project memory, resources, and open project tasks", async () => {
    const now = new Date("2026-10-04T10:00:00.000Z");
    const project = {
      id: "project-1",
      spaceId: "space-1",
      userId: "user-1",
      slug: "rakazo",
      name: "Rakazo",
      description: "Control plane",
      memory: "Persistent project context",
      memoryRevision: 3,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue(project) },
      projectResource: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "resource-1",
            projectId: "project-1",
            kind: "github.repo",
            ref: "BogdanAIP/rakazo",
            label: "Repository",
            metadata: { defaultBranch: "main" },
            createdAt: now,
            updatedAt: now,
          },
        ]),
      },
      scratchpadItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "task-1",
            botId: "bot-1",
            projectId: "project-1",
            title: "Capability bridge",
            status: "open",
            notes: "Continue",
            createdAt: now,
            updatedAt: now,
          },
        ]),
      },
    } as unknown as PrismaClient;
    const handler = new RPCHandler(createRouter(baseDeps(prisma)));
    const { response } = await handler.handle(rpc("projects/context", { projectId: "project-1" }), {
      prefix: "/rpc",
      context: { actor },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      json: {
        project: { id: "project-1", slug: "rakazo", memoryRevision: 3 },
        resources: [{ kind: "github.repo", ref: "BogdanAIP/rakazo" }],
        openTasks: [{ id: "task-1", projectId: "project-1" }],
      },
    });
  });

  it("uses a memory revision guard and reports concurrent changes", async () => {
    const now = new Date("2026-10-04T10:00:00.000Z");
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      project: {
        findFirst: vi.fn().mockResolvedValue({
          id: "project-1",
          spaceId: "space-1",
          userId: "user-1",
          slug: "rakazo",
          name: "Rakazo",
          description: "",
          memory: "newer",
          memoryRevision: 4,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const handler = new RPCHandler(createRouter(baseDeps(prisma)));
    const { response } = await handler.handle(
      rpc("projects/update", {
        projectId: "project-1",
        memory: "stale write",
        expectedMemoryRevision: 3,
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(409);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "project-1", memoryRevision: 3 }),
      }),
    );
  });
});

describe("capability execution bridge", () => {
  const readTool: ConnectorTool = {
    name: "mcp__github__get_file",
    description: "Read a repository file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: "github-server",
      resourceRevision: 1,
      toolName: "get_file",
      catalogGroup: "github",
    },
  };
  const writeTool: ConnectorTool = {
    ...readTool,
    name: "mcp__github__create_issue",
    description: "Create an issue",
    readOnly: false,
    route: { ...readTool.route!, toolName: "create_issue" },
  };

  function capabilityDeps() {
    const discoverTools = vi.fn(async () => [readTool, writeTool]);
    const calls: ConnectorCall[] = [];
    const contexts: AdapterContext[] = [];
    const execute = async function* (
      call: ConnectorCall,
      context: AdapterContext,
    ): AsyncIterable<ConnectorEvent> {
      calls.push(call);
      contexts.push(context);
      yield { type: "result", data: { ok: true, tool: call.route?.toolName } };
    };
    const connectors = {
      discoverTools,
      execute,
      resolveCall: vi.fn(async () => undefined),
      managed: vi.fn(),
      managedProviders: vi.fn(() => []),
    } as unknown as RouterDeps["connectors"];
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
      connection: { findMany: vi.fn().mockResolvedValue([]) },
      project: { findFirst: vi.fn().mockResolvedValue({ id: "project-1" }) },
    } as unknown as PrismaClient;
    return { deps: baseDeps(prisma, connectors), calls, contexts, discoverTools };
  }

  it("discovers tools and blocks write tools on the read path", async () => {
    const { deps, calls } = capabilityDeps();
    const handler = new RPCHandler(createRouter(deps));
    const search = await handler.handle(
      rpc("capabilities/tools", { botId: "bot-1", query: "repository", limit: 10 }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(search.response.status).toBe(200);
    await expect(search.response.json()).resolves.toMatchObject({
      json: [{ name: "mcp__github__get_file", readOnly: true }],
    });

    const read = await handler.handle(
      rpc("capabilities/read", {
        botId: "bot-1",
        tool: readTool.name,
        route: readTool.route,
        args: { path: "README.md" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(read.response.status).toBe(200);
    expect(calls).toHaveLength(1);

    const writeViaRead = await handler.handle(
      rpc("capabilities/read", {
        botId: "bot-1",
        tool: writeTool.name,
        route: writeTool.route,
        args: { title: "test" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(writeViaRead.response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("re-discovers authorization before explicit write execution", async () => {
    const { deps, calls, discoverTools } = capabilityDeps();
    const handler = new RPCHandler(createRouter(deps));
    discoverTools.mockResolvedValueOnce([writeTool]).mockResolvedValueOnce([]);
    const first = await handler.handle(
      rpc("capabilities/execute", {
        botId: "bot-1",
        tool: writeTool.name,
        route: writeTool.route,
        args: { title: "first" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(first.response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const second = await handler.handle(
      rpc("capabilities/execute", {
        botId: "bot-1",
        tool: writeTool.name,
        route: writeTool.route,
        args: { title: "stale" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(second.response.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
  it("passes an owned projectId into the write execution context", async () => {
    const { deps, calls, contexts } = capabilityDeps();
    const handler = new RPCHandler(createRouter(deps));
    const result = await handler.handle(
      rpc("capabilities/execute", {
        botId: "bot-1",
        projectId: "project-1",
        tool: writeTool.name,
        route: writeTool.route,
        args: { owner: "BogdanAIP", repo: "rakazo", title: "test" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(result.response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(contexts[0]?.projectId).toBe("project-1");
  });

  it("rejects an inaccessible project before executing a write", async () => {
    const { deps, calls } = capabilityDeps();
    vi.mocked(deps.prisma.project.findFirst).mockResolvedValueOnce(null);
    const handler = new RPCHandler(createRouter(deps));
    const result = await handler.handle(
      rpc("capabilities/execute", {
        botId: "bot-1",
        projectId: "foreign-project",
        tool: writeTool.name,
        route: writeTool.route,
        args: { owner: "BogdanAIP", repo: "rakazo", title: "test" },
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(result.response.status).not.toBe(200);
    expect(calls).toHaveLength(0);
  });
});
