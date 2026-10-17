import type { PaperResearchHistory } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { PaperResearchComparison } from "./PaperResearchComparison";
import { paperPerpetualOutcomeLabel } from "./paper-perpetual-outcomes";

const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");

export function PaperPerpetualResearchHistory({ ledgerId }: { ledgerId: string }) {
  const [history, setHistory] = useState<PaperResearchHistory | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function load() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      setHistory(await rpc.trading.perpetualResearchRead({ ledgerId, limit: 20 }));
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <details
      className="rounded-xl border border-border p-4"
      aria-label="Последние решения"
      onToggle={(event) => {
        if (
          event.target === event.currentTarget &&
          event.currentTarget.open &&
          history === null &&
          !pending
        )
          void load();
      }}
    >
      <summary className="cursor-pointer font-medium">Последние решения</summary>
      <div className="mt-3 space-y-3">
        <Button variant="outline" disabled={pending} onClick={() => void load()}>
          Обновить решения
        </Button>
        {pending ? (
          <p role="status" className="text-sm">
            Загрузка решений…
          </p>
        ) : null}
        {error || history?.status === "integrity_blocked" ? (
          <p role="alert" className="text-sm text-destructive">
            Не удалось проверить историю решений.
          </p>
        ) : null}
        {history?.status === "verified" ? (
          history.decisions.length ? (
            <ol className="space-y-3">
              {history.decisions.map((record) => (
                <li key={record.id}>
                  <details className="rounded-lg bg-muted p-3">
                    <summary className="cursor-pointer text-sm">
                      {dateTime(record.at)} · {paperPerpetualOutcomeLabel(record.outcome)}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {record.decision.kind === "proposal"
                        ? record.decision.rationale
                        : record.decision.reason}
                    </p>
                    {record.decision.comparison ? (
                      <PaperResearchComparison comparison={record.decision.comparison} />
                    ) : null}
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">Решений пока нет.</p>
          )
        ) : null}
      </div>
    </details>
  );
}
