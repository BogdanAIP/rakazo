import type {
  AgentHomeStore,
  AgentRuntime,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { handlePaperWorkerPreflightWithSuccessor } from "./paper-worker-recurring-handler.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));
vi.mock("./paper-worker-recurring-handler.js", () => ({
  handlePaperWorkerPreflightWithSuccessor: vi.fn(async () => ({
    status: "stop",
    preflight: { status: "deny", reason: "worker_gate_disabled" },
  })),
}));

describe("createBackgroundJobHandlers", () => {
  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const handlers = createBackgroundJobHandlers({
      executor: {
        continueRun: vi.fn(async () => undefined),
      } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {} as unknown as PrismaClient,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      messaging: {} as unknown as MessagingSurface,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(sink.events.some((event) => event.message === "messaging.deliver enqueue error")).toBe(
      true,
    );
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("routes paper worker wake through guarded observation and recurrence without model execution", async () => {
    const prisma = {} as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
    const executor = {
      continueRun: vi.fn(async () => undefined),
      wakeRoutine: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createRunExecutor>;
    const handlers = createBackgroundJobHandlers({
      executor,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });
    const payload = {
      ledgerId: "paper-1",
      spaceId: "space-1",
      userId: "user-1",
      gateRevision: 7,
      sessionRevision: 3,
      scheduledFor: "2026-10-05T12:00:00.000Z",
    };

    vi.mocked(handlePaperWorkerPreflightWithSuccessor).mockClear();
    const { sessionRevision: _revision, ...legacyPayload } = payload;
    await handlers["paper.worker-preflight"](legacyPayload);
    expect(handlePaperWorkerPreflightWithSuccessor).not.toHaveBeenCalled();
    await handlers["paper.worker-preflight"](payload);

    expect(handlePaperWorkerPreflightWithSuccessor).toHaveBeenCalledWith({ prisma, jobs }, payload);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(executor.continueRun).not.toHaveBeenCalled();
    expect(executor.wakeRoutine).not.toHaveBeenCalled();
  });

  it("compacts the requested thread with the runtime, job publisher, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memoryProviders,
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        runtime,
        jobs,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        resolveModel,
      },
      "thread-1",
    );
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "openai/gpt-6-luna",
      apiKey: "deployment-key",
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });
});
