import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string },
): MessageBlock {
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" ||
          toolName === "paper_trading_control" ||
          toolName === "paper_position_control" ||
          toolName === "paper_worker_control" ||
          toolName === "paper_worker_start" ||
          toolName === "paper_worker_recurrence_control"
          ? `${summary}?`
          : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : toolName === "paper_trading_control"
          ? [
              {
                id: "allow",
                label: args.action === "disable" ? "Disable paper trading" : "Enable paper only",
              },
              { id: "deny", label: "Cancel" },
            ]
          : toolName === "paper_position_control"
            ? [
                { id: "allow", label: "Authorize protective paper exit" },
                { id: "deny", label: "Cancel" },
              ]
            : toolName === "paper_worker_control"
              ? [
                  {
                    id: "allow",
                    label:
                      args.action === "disable" ? "Disable paper worker" : "Enable paper worker",
                  },
                  { id: "deny", label: "Cancel" },
                ]
              : toolName === "paper_worker_start"
                ? [
                    { id: "allow", label: "Schedule one paper preflight" },
                    { id: "deny", label: "Cancel" },
                  ]
                : toolName === "paper_worker_recurrence_control"
                  ? [
                      {
                        id: "allow",
                        label:
                          args.action === "disable"
                            ? "Revoke recurring paper preflights"
                            : "Authorize recurring paper preflights",
                      },
                      { id: "deny", label: "Cancel" },
                    ]
                  : [
                    { id: "allow", label: "Allow once" },
                    { id: "always", label: "Always allow this tool" },
                    { id: "deny", label: "Deny" },
                  ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  if (toolName === "paper_trading_control") {
    const verb = args.action === "disable" ? "Disable" : "Enable";
    const ledger = args.ledger_id ? String(args.ledger_id) : "unknown ledger";
    return `${verb} paper-only trading for “${ledger}”`;
  }
  if (toolName === "paper_position_control") {
    const ledger = args.ledger_id ? String(args.ledger_id) : "unknown ledger";
    const position = args.position_id ? String(args.position_id) : "unknown position";
    return `Authorize protective paper exit for “${position}” on “${ledger}”`;
  }
  if (toolName === "paper_worker_control") {
    const verb = args.action === "disable" ? "Disable" : "Enable";
    const ledger = args.ledger_id ? String(args.ledger_id) : "unknown ledger";
    return `${verb} background paper-worker gate for “${ledger}”`;
  }
  if (toolName === "paper_worker_start") {
    const ledger = args.ledger_id ? String(args.ledger_id) : "unknown ledger";
    return `Schedule one read-only paper preflight for “${ledger}”`;
  }
  if (toolName === "paper_worker_recurrence_control") {
    const verb = args.action === "disable" ? "Revoke" : "Authorize";
    const ledger = args.ledger_id ? String(args.ledger_id) : "unknown ledger";
    return `${verb} recurring read-only paper preflights for “${ledger}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  if (toolName === "paper_trading_control") {
    lines.push(
      "This changes only the synthetic paper-only capability. It does not authorize live orders or change risk limits.",
      `ledger: ${String(args.ledger_id ?? "")}`,
      `expected policy revision: ${String(args.expected_policy_revision ?? "")}`,
    );
  }
  if (toolName === "paper_position_control") {
    lines.push(
      "This records only a short-lived authorization for one protective synthetic paper exit. It does not close the position now, enable new entries, or authorize live orders.",
      `ledger: ${String(args.ledger_id ?? "")}`,
      `position: ${String(args.position_id ?? "")}`,
      `expected policy revision: ${String(args.expected_policy_revision ?? "")}`,
    );
  }
  if (toolName === "paper_worker_control") {
    lines.push(
      "This changes only a default-deny PAPER background-worker permission. It does not create a schedule or enqueue work, and it never authorizes live orders.",
      `ledger: ${String(args.ledger_id ?? "")}`,
      `expected policy revision: ${String(args.expected_policy_revision ?? "")}`,
      ...(args.action === "enable"
        ? [`cadence minutes: ${String(args.cadence_minutes ?? "")}`]
        : []),
    );
  }
  if (toolName === "paper_worker_start") {
    lines.push(
      "This schedules exactly one delayed read-only PAPER preflight using the already-approved worker cadence. It does not schedule recurrence, wake a model, poll market data, mutate the trading ledger, or authorize live orders.",
      `ledger: ${String(args.ledger_id ?? "")}`,
      `expected worker gate revision: ${String(args.expected_gate_revision ?? "")}`,
    );
  }
  if (toolName === "paper_worker_recurrence_control") {
    lines.push(
      "This changes only permission for future recurring read-only PAPER preflights. It does not enqueue a job or activate recurrence by itself, and it never authorizes trading or live orders.",
      `ledger: ${String(args.ledger_id ?? "")}`,
      `expected worker gate revision: ${String(args.expected_gate_revision ?? "")}`,
    );
  }
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
