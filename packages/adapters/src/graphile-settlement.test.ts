import { describe, expect, it, vi } from "vitest";
import { awaitGraphileJobSettlements } from "./graphile-settlement.js";

const locked = { rows: [{ id: "1" }] };
const done = { rows: [] };
describe("Graphile completion persistence barrier", () => {
  it("does not report a drained database while a job remains locked", async () => {
    const query = vi.fn().mockResolvedValueOnce(locked).mockResolvedValueOnce(done);
    const pause = vi.fn().mockResolvedValue(undefined);
    await awaitGraphileJobSettlements({ query } as never, { pause });
    expect(query).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      "select id from graphile_worker._private_jobs where locked_at is not null limit 1",
    );
  });
  it("fails closed when Graphile job result is not persisted before timeout", async () => {
    const query = vi.fn().mockResolvedValue(locked);
    await expect(awaitGraphileJobSettlements({ query } as never, { timeoutMs: 0 })).rejects.toThrow(
      "completion remains uncommitted",
    );
  });
  it("fails closed when PostgreSQL cannot verify the job ledger", async () => {
    const query = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(awaitGraphileJobSettlements({ query } as never)).rejects.toThrow(
      "connection lost",
    );
  });
  it("does not wait or modify the database when there is nothing locked", async () => {
    const query = vi.fn().mockResolvedValue(done);
    const pause = vi.fn();
    await awaitGraphileJobSettlements({ query } as never, { pause });
    expect(pause).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
