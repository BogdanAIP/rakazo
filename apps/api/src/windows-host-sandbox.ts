import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { WindowsHostCommandHub } from "./windows-host-command-hub.js";

const HOST_ONLINE_WINDOW_MS = 60_000;

export class WindowsHostSandboxProvider implements SandboxProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly commands: WindowsHostCommandHub,
  ) {}

  describe() {
    return {
      id: "desktop",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const lastSeenAfter = new Date(Date.now() - HOST_ONLINE_WINDOW_MS);
    const host = await this.prisma.windowsHost.findFirst({
      where: {
        ownerUserId: context.userId,
        revokedAt: null,
        lastSeenAt: { gte: lastSeenAfter },
        ...(request.providerKind === "desktop" && request.providerRef
          ? { id: request.providerRef }
          : {}),
      },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!host) {
      throw new Error("No connected Windows host is available");
    }

    return {
      id: `desktop-${request.botId}`,
      botId: request.botId,
      kind: "desktop",
      providerRef: host.id,
      fresh: false,
    };
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const host = await this.prisma.windowsHost.findFirst({
      where: {
        id: computer.providerRef,
        ownerUserId: context.userId,
        revokedAt: null,
      },
      select: { installationId: true },
    });
    if (!host) throw new Error("Windows host is unavailable or no longer authorized");

    const result = await this.commands.dispatch(
      computer.providerRef,
      { kind: "identity.get" },
      context.signal,
    );
    if (!result.ok) throw new Error(result.error);
    if (result.result.kind !== "identity") {
      throw new Error("Windows host returned an unexpected identity response");
    }
    if (result.result.identity.installationId !== host.installationId) {
      throw new Error("Windows host identity does not match its paired installation");
    }
  }

  async *execute(
    _computer: ComputerRef,
    _request: CommandRequest,
    _context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield {
      type: "stderr",
      data: "Physical Windows process execution is not enabled yet.",
    };
    yield { type: "exit", code: 1 };
  }

  async connectScreen(_computer: ComputerRef, _request: ScreenRequest, _context: AdapterContext) {
    return {
      url: null,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ) {
    throw new Error("Physical Windows input is not enabled yet");
  }

  async observe(_computer: ComputerRef, _context: AdapterContext) {
    throw new Error("Physical Windows observation is not enabled yet");
  }

  async act(_computer: ComputerRef, _request: ComputerActionRequest, _context: AdapterContext) {
    throw new Error("Physical Windows actions are not enabled yet");
  }

  async listFiles(_computer: ComputerRef, _path: string, _context: AdapterContext) {
    throw new Error("Physical Windows file access is not enabled yet");
  }

  async readFile(
    _computer: ComputerRef,
    _path: string,
    _context: AdapterContext,
    _options?: { maxBytes?: number },
  ) {
    throw new Error("Physical Windows file access is not enabled yet");
  }

  async writeFile(_computer: ComputerRef, _file: PortableFile, _context: AdapterContext) {
    throw new Error("Physical Windows file access is not enabled yet");
  }

  async *exportWorkspace(
    _computer: ComputerRef,
    _context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    yield* [] as PortableFile[];
    throw new Error("Physical Windows workspace export is not enabled yet");
  }

  async importWorkspace(
    _computer: ComputerRef,
    _files: AsyncIterable<PortableFile>,
    _context: AdapterContext,
  ) {
    throw new Error("Physical Windows workspace import is not enabled yet");
  }

  async snapshot(_computer: ComputerRef, _context: AdapterContext) {
    throw new Error("Physical Windows snapshots are not enabled yet");
  }

  async stop(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async destroy(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}
}
