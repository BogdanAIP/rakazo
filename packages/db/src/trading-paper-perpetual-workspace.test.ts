import { describe, expect, it } from "vitest";
import { parsePerpetualControl, perpetualPaperHash } from "./trading-paper-perpetual-workspace.js";

const base = {
  maxLeverage: 5,
  sessionStatus: "paused",
  startedAt: null,
  expiresAt: null,
  protectionExpiresAt: null,
  instruments: [],
  source: null,
  researchMode: "model",
  pendingExternalProposal: null,
  orders: [],
  plans: [],
  closeAll: false,
  runtimeError: null,
  lastResearchAt: null,
  lastDecision: null,
};
describe("legacy external PAPER control persistence", () => {
  it("translates legacy mode and pending proposal only after validating the original hash", () => {
    const { pendingExternalProposal: _unused, ...old } = base;
    const pending = {
      commandId: "00000000-0000-4000-8000-000000000001",
      submittedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:02:00.000Z",
      decision: { kind: "no_trade", reason: "fixture" },
    };
    const control = { ...old, researchMode: "chatgpt-r", pendingChatgptProposal: pending };
    const row = { control, controlSha256: perpetualPaperHash(control) };
    expect(parsePerpetualControl(row)).toMatchObject({
      researchMode: "external",
      pendingExternalProposal: pending,
    });
    expect(control).toHaveProperty("pendingChatgptProposal", pending);
    expect(() =>
      parsePerpetualControl({ ...row, control: { ...control, maxLeverage: 20 } }),
    ).toThrow("integrity");
  });
  it("rejects conflicting old and canonical proposal fields", () => {
    const control = { ...base, researchMode: "chatgpt-r", pendingChatgptProposal: null };
    expect(() =>
      parsePerpetualControl({ control, controlSha256: perpetualPaperHash(control) }),
    ).toThrow("Conflicting");
  });
});
