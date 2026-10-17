import type { PaperPerpetualDecision, PaperResearchHistory } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { PaperResearchComparison } from "./PaperResearchComparison";

const decisionLabel: Record<PaperPerpetualDecision["kind"], string> = {
  proposal: "Предложение входа",
  no_trade: "Не торговать",
  close: "Закрытие",
  reduce: "Сокращение позиции",
  tighten_stop: "Перенос стопа",
};

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
        <p className="text-xs text-muted-foreground">
          Результаты исполнения указаны в истории фьючерсных операций.
        </p>
        {history?.status === "verified" ? (
          history.decisions.length ? (
            <ol className="space-y-3">
              {history.decisions.map((record) => (
                <li key={record.id}>
                  <details className="rounded-lg bg-muted p-3">
                    <summary className="cursor-pointer text-sm">
                      {decisionLabel[record.decision.kind]}
                      {record.decision.comparison
                        ? " · " + dateTime(record.decision.comparison.asOf)
                        : ""}
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
