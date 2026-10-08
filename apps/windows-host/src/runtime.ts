import { randomUUID } from "node:crypto";
import {
  WINDOWS_HOST_PROTOCOL_VERSION,
  type WindowsHostAdvertisement,
  WindowsHostAdvertisementSchema,
  type WindowsHostCapability,
  type WindowsHostCommandEnvelope,
  type WindowsHostCommandResult,
  WindowsHostHeartbeatSchema,
} from "@rakazo/contracts";
import type { WindowsBrowserBackend } from "./browser-backend.js";
import { createWindowsBrowserBackend } from "./browser-backend-factory.js";
import type { WindowsHostConfig } from "./config.js";
import {
  ProtectedWindowsHostCredentialStore,
  type WindowsHostCredentialStore,
} from "./credential-store.js";
import { loadOrCreateWindowsHostIdentity } from "./identity.js";
import { WindowsProcessBackend } from "./native-process.js";
import { WindowsOpenCliBackend } from "./opencli.js";
import { WindowsHostReadOnlyBackend } from "./readonly.js";
import {
  HttpWindowsHostTransport,
  WindowsHostAuthorizationError,
  type WindowsHostTransport,
} from "./transport.js";
import { WindowsHostFileMutationBackend } from "./windows-files.js";
import { WindowsGuiBackend } from "./windows-gui.js";

export const WINDOWS_HOST_RUNTIME_VERSION = "0.1.0";

const INITIAL_CAPABILITIES = [
  "identity",
  "process",
  "files",
] as const satisfies readonly WindowsHostCapability[];

interface ResolvedWindowsHostCredential {
  hostId: string;
  credential: string;
  heartbeatIntervalMs: number;
  source: "env" | "pairing" | "store";
}

export async function buildAdvertisement(
  stateDir: string,
  startedAt = new Date().toISOString(),
  browserAvailable = false,
  guiAvailable = false,
  processEnabled = false,
): Promise<WindowsHostAdvertisement> {
  const identity = await loadOrCreateWindowsHostIdentity(stateDir);
  return WindowsHostAdvertisementSchema.parse({
    protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
    runtimeVersion: WINDOWS_HOST_RUNTIME_VERSION,
    identity,
    capabilities: [
      ...INITIAL_CAPABILITIES,
      ...(browserAvailable ? ["browser" as const] : []),
      ...(guiAvailable ? (["screen", "input", "uia"] as const) : []),
      ...(processEnabled ? (["terminal"] as const) : []),
    ],
    startedAt,
  });
}

export async function resolveWindowsHostCredential(
  config: WindowsHostConfig,
  advertisement: WindowsHostAdvertisement,
  transport: WindowsHostTransport,
  credentialStore: WindowsHostCredentialStore,
  signal?: AbortSignal,
): Promise<ResolvedWindowsHostCredential> {
  const hasConfiguredHostId = Boolean(config.hostId);
  const hasConfiguredCredential = Boolean(config.hostCredential);
  if (hasConfiguredHostId !== hasConfiguredCredential) {
    throw new Error(
      "RAKAZO_WINDOWS_HOST_ID and RAKAZO_WINDOWS_HOST_CREDENTIAL must be provided together",
    );
  }

  if (config.hostId && config.hostCredential) {
    return {
      hostId: config.hostId,
      credential: config.hostCredential,
      heartbeatIntervalMs: 15_000,
      source: "env",
    };
  }

  // Pairing capabilities are single-use. Prefer the DPAPI-backed credential on
  // every subsequent start, even if the original pairing token remains in env.
  const stored = await credentialStore.load();
  if (stored) {
    return {
      hostId: stored.hostId,
      credential: stored.hostCredential,
      heartbeatIntervalMs: 15_000,
      source: "store",
    };
  }

  if (config.pairingToken) {
    const paired = await transport.pair(advertisement, config.pairingToken, signal);
    await credentialStore.save({
      hostId: paired.hostId,
      hostCredential: paired.hostCredential,
    });
    return {
      hostId: paired.hostId,
      credential: paired.hostCredential,
      heartbeatIntervalMs: paired.heartbeatIntervalMs,
      source: "pairing",
    };
  }

  throw new Error("Provide a short-lived pairing token or an existing host id/credential");
}

export class WindowsHostRuntime {
  private readonly connectionId = randomUUID();
  private sequence = 0;

  constructor(
    private readonly config: WindowsHostConfig,
    private readonly transport: WindowsHostTransport | null = config.origin
      ? new HttpWindowsHostTransport(config.origin)
      : null,
    private readonly credentialStore: WindowsHostCredentialStore = new ProtectedWindowsHostCredentialStore(
      config.stateDir,
    ),
    private readonly readOnlyBackend: WindowsHostReadOnlyBackend = new WindowsHostReadOnlyBackend(
      config.stateDir,
    ),
    private readonly browserBackend: WindowsBrowserBackend = createWindowsBrowserBackend(
      config.stateDir,
    ),
    private readonly guiBackend: WindowsGuiBackend = new WindowsGuiBackend(),
    private readonly processBackend: WindowsProcessBackend = new WindowsProcessBackend(
      config.stateDir,
    ),
    private readonly fileMutationBackend: WindowsHostFileMutationBackend = new WindowsHostFileMutationBackend(
      config.stateDir,
    ),
  ) {}

  async probe() {
    return buildAdvertisement(
      this.config.stateDir,
      undefined,
      this.browserBackend.available(),
      this.guiBackend.available(),
      this.processBackend.available(),
    );
  }

  async run(signal?: AbortSignal): Promise<never> {
    if (!this.transport || !this.config.origin) {
      throw new Error("RAKAZO_WINDOWS_HOST_ORIGIN is required");
    }

    const advertisement = await this.probe();
    const resolved = await resolveWindowsHostCredential(
      this.config,
      advertisement,
      this.transport,
      this.credentialStore,
      signal,
    );

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();

    const heartbeat = this.runHeartbeatLoop(advertisement, resolved, controller.signal);
    const commands = this.runCommandLoop(advertisement, resolved, controller.signal);

    try {
      await Promise.race([heartbeat, commands]);
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", onAbort);
      await Promise.allSettled([heartbeat, commands]);
    }

    throw new Error("Windows host runtime stopped");
  }

  private async runHeartbeatLoop(
    advertisement: WindowsHostAdvertisement,
    resolved: ResolvedWindowsHostCredential,
    signal: AbortSignal,
  ) {
    while (!signal.aborted) {
      try {
        const heartbeat = WindowsHostHeartbeatSchema.parse({
          protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
          hostId: resolved.hostId,
          connectionId: this.connectionId,
          sequence: this.sequence++,
          sentAt: new Date().toISOString(),
          advertisement,
        });
        const result = await this.transport!.heartbeat(heartbeat, resolved.credential, signal);
        if (result.revoked) {
          if (resolved.source !== "env") await this.credentialStore.clear();
          throw new Error("Windows host credential was revoked");
        }
        await sleep(resolved.heartbeatIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WindowsHostAuthorizationError) {
          if (resolved.source !== "env") await this.credentialStore.clear();
          throw error;
        }
        if (error instanceof Error && error.message.includes("revoked")) throw error;
        await sleep(Math.min(resolved.heartbeatIntervalMs, 30_000), signal);
      }
    }
  }

  private async runCommandLoop(
    advertisement: WindowsHostAdvertisement,
    resolved: ResolvedWindowsHostCredential,
    signal: AbortSignal,
  ) {
    while (!signal.aborted) {
      try {
        const command = await this.transport!.poll(resolved.hostId, resolved.credential, signal);
        if (!command) continue;

        let result: WindowsHostCommandResult;
        try {
          result = await executeWindowsHostCommand(
            command,
            advertisement,
            this.readOnlyBackend,
            this.browserBackend,
            this.guiBackend,
            this.processBackend,
            this.fileMutationBackend,
          );
        } catch (error) {
          result = {
            id: command.id,
            ok: false,
            error: boundedCommandError(error),
          };
        }

        await this.transport!.report(resolved.hostId, result, resolved.credential, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WindowsHostAuthorizationError) {
          if (resolved.source !== "env") await this.credentialStore.clear();
          throw error;
        }
        await sleep(1_000, signal);
      }
    }
  }
}

export async function executeWindowsHostCommand(
  command: WindowsHostCommandEnvelope,
  advertisement: WindowsHostAdvertisement,
  backend: WindowsHostReadOnlyBackend = new WindowsHostReadOnlyBackend("."),
  browserBackend: WindowsBrowserBackend = new WindowsOpenCliBackend(),
  guiBackend: WindowsGuiBackend = new WindowsGuiBackend(),
  processBackend: WindowsProcessBackend = new WindowsProcessBackend("."),
  fileMutationBackend: WindowsHostFileMutationBackend = new WindowsHostFileMutationBackend("."),
): Promise<WindowsHostCommandResult> {
  switch (command.request.kind) {
    case "identity.get":
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "identity",
          identity: advertisement.identity,
        },
      };
    case "process.list":
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "processes",
          processes: await backend.listProcesses(command.request.limit),
        },
      };
    case "files.list":
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "files",
          entries: await backend.listFiles(command.request.botId, command.request.directory),
        },
      };
    case "browser.call":
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "browser",
          response: await browserBackend.browser(command.request.botId, command.request.request),
        },
      };
    case "process.run": {
      const value = await processBackend.execute(
        command.request.botId,
        command.request.argv,
        command.request.cwd,
        command.request.timeoutMs,
      );
      return { id: command.id, ok: true, result: { kind: "process", value } };
    }
    case "screen.observe": {
      const result = await guiBackend.execute({ command: "observe" });
      if (result.kind !== "observation") throw new Error("Unexpected Windows GUI observation");
      return {
        id: command.id,
        ok: true,
        result: { kind: "screen", observation: result.observation },
      };
    }
    case "screen.act": {
      const result = await guiBackend.execute({
        command: "act",
        actions: command.request.actions,
        observe: command.request.observe,
        settleMs: command.request.settleMs,
      });
      if (result.kind !== "actions") throw new Error("Unexpected Windows GUI action result");
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "actions",
          completed: result.completed,
          ...(result.observation ? { observation: result.observation } : {}),
        },
      };
    }
    case "files.read":
      return {
        id: command.id,
        ok: true,
        result: {
          kind: "file",
          contentBase64: Buffer.from(
            await backend.readFile(
              command.request.botId,
              command.request.path,
              command.request.maxBytes,
            ),
          ).toString("base64"),
        },
      };
    case "files.write": {
      const content = Buffer.from(command.request.contentBase64, "base64");
      if (
        content.toString("base64").replace(/=+$/u, "") !==
        command.request.contentBase64.replace(/=+$/u, "")
      ) {
        throw new Error("Windows host received invalid base64 file content");
      }
      const result = await fileMutationBackend.writeFile(
        command.request.botId,
        command.request.path,
        content,
        command.request.executable,
      );
      return {
        id: command.id,
        ok: true,
        result: { kind: "file-write", path: result.path, bytesWritten: result.bytesWritten },
      };
    }
  }
}

function boundedCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000) || "Windows host command failed";
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done();

    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
