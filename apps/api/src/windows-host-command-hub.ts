import { randomUUID } from "node:crypto";
import {
  type WindowsHostCommandEnvelope,
  WindowsHostCommandEnvelopeSchema,
  type WindowsHostCommandRequest,
  type WindowsHostCommandResult,
  WindowsHostCommandResultSchema,
} from "@rakazo/contracts";

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const MAX_PENDING_PER_HOST = 32;

interface PendingCommand {
  hostId: string;
  resolve: (result: WindowsHostCommandResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class WindowsHostCommandHub {
  private readonly queues = new Map<string, WindowsHostCommandEnvelope[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pending = new Map<string, PendingCommand>();
  private closed = false;

  async dispatch(
    hostId: string,
    request: WindowsHostCommandRequest,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
  ): Promise<WindowsHostCommandResult> {
    if (this.closed) throw new Error("Windows host command hub is closed");
    if (this.pendingForHost(hostId) >= MAX_PENDING_PER_HOST) {
      throw new Error("Windows host command queue is full");
    }

    const envelope = WindowsHostCommandEnvelopeSchema.parse({
      id: randomUUID(),
      request,
    });

    return new Promise<WindowsHostCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeQueued(hostId, envelope.id);
        this.pending.delete(envelope.id);
        cleanup();
        reject(new Error("Windows host command timed out"));
      }, timeoutMs);

      const onAbort = () => {
        this.removeQueued(hostId, envelope.id);
        this.pending.delete(envelope.id);
        cleanup();
        reject(new Error("Windows host command aborted"));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(envelope.id, { hostId, resolve, reject, cleanup });
      const queue = this.queues.get(hostId) ?? [];
      queue.push(envelope);
      this.queues.set(hostId, queue);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.wake(hostId);
    });
  }

  async poll(
    hostId: string,
    waitMs = 25_000,
    signal?: AbortSignal,
  ): Promise<WindowsHostCommandEnvelope | null> {
    const immediate = this.shift(hostId);
    if (immediate || this.closed || signal?.aborted) return immediate;

    await new Promise<void>((resolve) => {
      const listeners = this.waiters.get(hostId) ?? new Set<() => void>();
      let settled = false;
      const timeout = setTimeout(done, waitMs);

      const onAbort = () => done();
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        listeners.delete(done);
        resolve();
      }

      listeners.add(done);
      this.waiters.set(hostId, listeners);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    return this.shift(hostId);
  }

  settle(hostId: string, result: WindowsHostCommandResult): boolean {
    const parsed = WindowsHostCommandResultSchema.parse(result);
    const pending = this.pending.get(parsed.id);
    if (!pending || pending.hostId !== hostId) return false;

    this.pending.delete(parsed.id);
    pending.cleanup();
    pending.resolve(parsed);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      pending.cleanup();
      pending.reject(new Error("Windows host command hub closed"));
      this.pending.delete(id);
    }
    for (const hostId of this.waiters.keys()) this.wake(hostId);
    this.queues.clear();
  }

  private shift(hostId: string) {
    const queue = this.queues.get(hostId);
    const command = queue?.shift() ?? null;
    if (queue && queue.length === 0) this.queues.delete(hostId);
    return command;
  }

  private wake(hostId: string) {
    for (const notify of this.waiters.get(hostId) ?? []) notify();
    this.waiters.delete(hostId);
  }

  private removeQueued(hostId: string, id: string) {
    const queue = this.queues.get(hostId);
    if (!queue) return;
    const next = queue.filter((command) => command.id !== id);
    if (next.length) this.queues.set(hostId, next);
    else this.queues.delete(hostId);
  }

  private pendingForHost(hostId: string) {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.hostId === hostId) count += 1;
    }
    return count;
  }
}
