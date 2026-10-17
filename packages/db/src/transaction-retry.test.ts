import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

describe("bounded database transaction conflict retries", () => {
  it.each([
    { code: "P2034" },
    { code: "40001" },
    { cause: { originalCode: "40001" } },
    { cause: { kind: "TransactionWriteConflict" } },
    { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } },
  ])("retries a structured serialization/deadlock conflict", async (error) => {
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("committed");
    await expect(withTransactionRetry(operation)).resolves.toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("stops after three conflicts and does not retry unrelated failures", async () => {
    const conflict = vi.fn().mockRejectedValue({ code: "P2034" });
    await expect(withTransactionRetry(conflict)).rejects.toMatchObject({ code: "P2034" });
    expect(conflict).toHaveBeenCalledTimes(3);
    const unique = vi.fn().mockRejectedValue({ code: "P2002" });
    await expect(withTransactionRetry(unique)).rejects.toMatchObject({ code: "P2002" });
    expect(unique).toHaveBeenCalledTimes(1);
  });
});
