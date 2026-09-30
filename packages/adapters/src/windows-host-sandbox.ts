import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SnapshotRef,
} from "@rakazo/adapter-kit";
import type { WindowsHostCommandRequest, WindowsHostCommandResult } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export interface WindowsHostCommandDispatcher {
  dispatch(
    hostId: string,
    request: WindowsHostCommandRequest,
    signal?: AbortSignal,
    timeoutMs?: number,
    ownerUserId?: string,
  ): Promise<WindowsHostCommandResult>;
}

const HOST_ONLINE_WINDOW_MS = 60_000;

export class WindowsHostSandboxProvider implements SandboxProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly commands: WindowsHostCommandDispatcher,
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
      undefined,
      context.userId,
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
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (
      request.argv.length !== 1 ||
      request.argv[0] !== "tasklist" ||
      request.cwd !== undefined ||
      request.env !== undefined ||
      request.pty
    ) {
      yield { type: "stderr", data: "Physical Windows command execution is not enabled yet." };
      yield { type: "exit", code: 1 };
      return;
    }
    const result = await this.commands.dispatch(
      computer.providerRef,
      { kind: "process.list", limit: 100 },
      context.signal,
      undefined,
      context.userId,
    );
    if (!result.ok) throw new Error(result.error);
    if (result.result.kind !== "processes") {
      throw new Error("Windows host returned an unexpected process response");
    }
    yield { type: "stdout", data: JSON.stringify(result.result.processes) };
    yield { type: "exit", code: 0 };
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

  async observe(_computer: ComputerRef, _context: AdapterContext): Promise<ComputerObservation> {
    throw new Error("Physical Windows observation is not enabled yet");
  }

  async act(
    _computer: ComputerRef,
    _request: ComputerActionRequest,
    _context: AdapterContext,
  ): Promise<ComputerActionResult> {
    throw new Error("Physical Windows actions are not enabled yet");
  }

  async listFiles(computer: ComputerRef, directory: string, context: AdapterContext) {
    const result = await this.commands.dispatch(
      computer.providerRef,
      { kind: "files.list", botId: computer.botId, directory },
      context.signal,
      undefined,
      context.userId,
    );
    if (!result.ok) throw new Error(result.error);
    if (result.result.kind !== "files") {
      throw new Error("Windows host returned an unexpected directory response");
    }
    return result.result.entries;
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const maxBytes = options?.maxBytes ?? 32_768;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
      throw new Error("Windows host file reads are limited to 64 KiB");
    }
    const result = await this.commands.dispatch(
      computer.providerRef,
      { kind: "files.read", botId: computer.botId, path: filePath, maxBytes },
      context.signal,
      undefined,
      context.userId,
    );
    if (!result.ok) throw new Error(result.error);
    if (result.result.kind !== "file") {
      throw new Error("Windows host returned an unexpected file response");
    }
    const encoded = result.result.contentBase64;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error("Windows host returned invalid file encoding");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > maxBytes) throw new Error("Windows host exceeded the file read limit");
    return new Uint8Array(bytes);
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

  async snapshot(_computer: ComputerRef, _context: AdapterContext): Promise<SnapshotRef> {
    throw new Error("Physical Windows snapshots are not enabled yet");
  }

  async stop(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async destroy(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}
}
