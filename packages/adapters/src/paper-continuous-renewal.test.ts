import { describe, expect, it } from "vitest";
import {
	continuousPaperRenewalDue,
	isTransientPaperMarketNetworkError,
} from "./paper-perpetual-workspace.js";

const now = new Date("2026-11-07T16:00:00.000Z");
const base: Parameters<typeof continuousPaperRenewalDue>[0] = {
	autoExtend: true,
	sessionStatus: "active",
	researchMode: "external",
	source: {} as NonNullable<
		Parameters<typeof continuousPaperRenewalDue>[0]["source"]
	>,
	expiresAt: new Date(now.getTime() + 23 * 3600000).toISOString(),
	closeAll: false,
	runtimeError: null,
};

describe("native PAPER worker continuous renewal", () => {
	it("renews within 24 hours only for an explicitly opted-in active session", () => {
		expect(continuousPaperRenewalDue(base, now)).toBe(true);
	});
	it("never renews a session too early or already expired", () => {
		expect(
			continuousPaperRenewalDue(
				{
					...base,
					expiresAt: new Date(now.getTime() + 36 * 3600000).toISOString(),
				},
				now,
			),
		).toBe(false);
		expect(
			continuousPaperRenewalDue(
				{ ...base, expiresAt: new Date(now.getTime() - 1).toISOString() },
				now,
			),
		).toBe(false);
	});
	it("does not reactivate paused, ended, errored or close-all sessions", () => {
		for (const override of [
			{ autoExtend: false },
			{ sessionStatus: "paused" as const },
			{ sessionStatus: "ended" as const },
			{ closeAll: true },
			{ runtimeError: "market_data_unavailable" },
			{ source: null },
			{ researchMode: "model" as const },
		]) {
			expect(continuousPaperRenewalDue({ ...base, ...override }, now)).toBe(
				false,
			);
		}
	});
});
describe("transient PAPER market transport policy", () => {
	it("retries transport failures while leaving parsing, venue and risk errors fail-closed", () => {
		expect(
			isTransientPaperMarketNetworkError(new TypeError("fetch failed")),
		).toBe(true);
		expect(
			isTransientPaperMarketNetworkError(
				Object.assign(new Error("timed out"), { name: "TimeoutError" }),
			),
		).toBe(true);
		expect(
			isTransientPaperMarketNetworkError(
				Object.assign(new Error("aborted"), { name: "AbortError" }),
			),
		).toBe(true);
		expect(
			isTransientPaperMarketNetworkError(
				new Error("Closed market history is stale"),
			),
		).toBe(false);
		expect(
			isTransientPaperMarketNetworkError(
				new Error("Nautilus PAPER unavailable (process_exited)"),
			),
		).toBe(false);
		expect(
			isTransientPaperMarketNetworkError(
				new Error("Futures research integrity failed"),
			),
		).toBe(false);
		expect(isTransientPaperMarketNetworkError("fetch failed")).toBe(false);
	});
});
