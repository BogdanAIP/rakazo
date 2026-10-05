import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses one-time paper controls and never offers always allow", () => {
    const enable = buildApprovalAskBlock(
      "effect-paper-enable",
      "paper_trading_control",
      { action: "enable", ledger_id: "paper-1", expected_policy_revision: 2 },
      [],
    );
    expect(enable).toMatchObject({
      kind: "ask",
      text: "Enable paper-only trading for “paper-1”?",
      actions: [
        { id: "allow", label: "Enable paper only" },
        { id: "deny", label: "Cancel" },
      ],
    });
    expect(JSON.stringify(enable)).not.toContain("Always allow");
    if (enable.kind !== "ask") throw new Error("expected ask block");
    expect(enable.detail).toContain("does not authorize live orders");
    expect(enable.detail).toContain("expected policy revision: 2");
  });

  it("uses one-time protective paper position authorization with no always allow", () => {
    const block = buildApprovalAskBlock(
      "effect-paper-exit",
      "paper_position_control",
      {
        action: "authorize_protective_stop_exit",
        ledger_id: "paper-1",
        position_id: "position-1",
        expected_policy_revision: 4,
      },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: "Authorize protective paper exit for “position-1” on “paper-1”?",
      actions: [
        { id: "allow", label: "Authorize protective paper exit" },
        { id: "deny", label: "Cancel" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("Always allow");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("does not close the position now");
    expect(block.detail).toContain("position: position-1");
    expect(block.detail).toContain("expected policy revision: 4");
  });

  it("uses one-time paper worker control and never offers always allow", () => {
    const block = buildApprovalAskBlock(
      "effect-paper-worker",
      "paper_worker_control",
      {
        action: "enable",
        ledger_id: "paper-1",
        expected_policy_revision: 5,
        cadence_minutes: 15,
      },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: "Enable background paper-worker gate for “paper-1”?",
      actions: [
        { id: "allow", label: "Enable paper worker" },
        { id: "deny", label: "Cancel" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("Always allow");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("does not create a schedule or enqueue work");
    expect(block.detail).toContain("expected policy revision: 5");
    expect(block.detail).toContain("cadence minutes: 15");
  });

  it("uses one-time paper worker start approval with no recurrence or always allow", () => {
    const block = buildApprovalAskBlock(
      "effect-paper-worker-start",
      "paper_worker_start",
      { ledger_id: "paper-1", expected_gate_revision: 7 },
      [],
    );
    expect(block).toMatchObject({
      kind: "ask",
      text: "Schedule one read-only paper preflight for “paper-1”?",
      actions: [
        { id: "allow", label: "Schedule one paper preflight" },
        { id: "deny", label: "Cancel" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("Always allow");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("exactly one delayed read-only PAPER preflight");
    expect(block.detail).toContain("does not schedule recurrence");
    expect(block.detail).toContain("expected worker gate revision: 7");
  });

  it("uses explicit recurrence permission approval with no always allow", () => {
    const enable = buildApprovalAskBlock(
      "effect-paper-worker-recurrence",
      "paper_worker_recurrence_control",
      { action: "enable", ledger_id: "paper-1", expected_gate_revision: 7 },
      [],
    );
    expect(enable).toMatchObject({
      kind: "ask",
      text: "Authorize recurring read-only paper preflights for “paper-1”?",
      actions: [
        { id: "allow", label: "Authorize recurring paper preflights" },
        { id: "deny", label: "Cancel" },
      ],
    });
    expect(JSON.stringify(enable)).not.toContain("Always allow");
    if (enable.kind !== "ask") throw new Error("expected ask block");
    expect(enable.detail).toContain("does not enqueue a job or activate recurrence by itself");
    expect(enable.detail).toContain("expected worker gate revision: 7");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});
