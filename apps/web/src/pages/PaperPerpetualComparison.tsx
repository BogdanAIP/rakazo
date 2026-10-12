import type {
  PaperPerpetualWorkspaceStatus,
  TradingPaperPerpetualJournalReadOutput,
} from "@rakazo/contracts";
import { formatPaperPerpetualAmount, paperPerpetualAmount } from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

type Verified = Extract<TradingPaperPerpetualJournalReadOutput, { status: "verified" }>;
const names: Record<string, string> = {
  conservative: "Консервативная",
  moderate: "Умеренная",
  aggressive: "Агрессивная",
};
export function PaperPerpetualComparison({
  ledgerIds,
  onSelect,
}: {
  ledgerIds: string[];
  onSelect: (id: string) => void;
}) {
  const [rows, setRows] = useState<
    Array<{ journal: Verified; workspace: PaperPerpetualWorkspaceStatus }>
  >([]);
  const [error, setError] = useState(false);
  const ids = ledgerIds.join("|");
  useEffect(() => {
    let active = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await Promise.all(
          ids
            .split("|")
            .filter(Boolean)
            .map(async (ledgerId) => {
              const [journal, workspace] = await Promise.all([
                rpc.trading.perpetualJournalRead({ ledgerId }),
                rpc.trading.perpetualWorkspaceRead({ ledgerId }),
              ]);
              return journal.status === "verified" &&
                workspace.status === "verified" &&
                workspace.managed
                ? { journal, workspace }
                : null;
            }),
        );
        if (active) {
          setRows(
            result.filter(
              (r): r is { journal: Verified; workspace: PaperPerpetualWorkspaceStatus } =>
                r !== null,
            ),
          );
          setError(false);
        }
      } catch {
        if (active) {
          setRows([]);
          setError(true);
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ids]);
  if (!rows.length)
    return error ? (
      <p role="status" className="text-sm text-muted-foreground">
        Сравнение временно недоступно.
      </p>
    ) : null;
  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      aria-label="Сравнение фьючерсных профилей"
    >
      <h3 className="mb-3 font-semibold">Сравнение трёх профилей</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="p-2">Профиль</th>
              <th className="p-2">Дней с запуска</th>
              <th className="p-2">Стоимость, USDT</th>
              <th className="p-2">Результат с переоценкой, USDT</th>
              <th className="p-2">Закрыто / открыто</th>
              <th className="p-2">Recovery Rate*</th>
              <th className="p-2">Резерв для доливок, USDT</th>
              <th className="p-2">Сессия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ journal, workspace }) => (
              <tr className="border-b border-border/60" key={journal.state.ledgerId}>
                <td className="p-2">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onSelect(journal.state.ledgerId)}
                  >
                    {names[journal.state.strategy]}
                  </button>
                </td>
                <td className="p-2 tabular-nums">
                  {workspace.startedAt
                    ? Math.max(
                        0,
                        (Date.now() - Date.parse(workspace.startedAt)) / 86400000,
                      ).toFixed(1)
                    : "—"}
                </td>
                <td className="p-2 tabular-nums">{journal.state.markedEquityQuote}</td>
                <td className="p-2 tabular-nums">
                  {formatPaperPerpetualAmount(
                    paperPerpetualAmount(journal.state.markedEquityQuote) - 100000000000n,
                  )}
                </td>
                <td className="p-2 tabular-nums">
                  {journal.state.closedPositions} / {journal.state.openPositions.length}
                </td>
                <td className="p-2 tabular-nums">
                  {journal.recovery?.status === "verified"
                    ? journal.recovery.recoveryRatePercent === null
                      ? "—"
                      : `${journal.recovery.recoveryRatePercent}% (${journal.recovery.recovered}/${journal.recovery.completedUnderwater})`
                    : "—"}
                </td>
                <td className="p-2 tabular-nums">
                  {formatPaperPerpetualAmount(
                    (workspace.recoveryReservations ?? []).reduce(
                      (sum, r) => sum + paperPerpetualAmount(r.reservedNotionalQuote),
                      0n,
                    ),
                  )}
                  {(workspace.recoveryReservations ?? []).flatMap((reservation) =>
                    (reservation.stages ?? []).map((step) => (
                      <div
                        className="text-xs text-muted-foreground"
                        key={reservation.positionId + ":" + step.stepId}
                      >
                        {step.stepId}: уровень {step.triggerPriceQuote}, осталось{" "}
                        {step.remainingNotionalQuote} USDT —{" "}
                        {step.activatedAt ? "достигнут, ожидает подтверждения" : "ожидает уровня"}
                      </div>
                    )),
                  )}
                </td>
                <td className="p-2">
                  {workspace.sessionStatus === "active"
                    ? "Входы разрешены"
                    : workspace.sessionStatus === "idle"
                      ? "Не запущена"
                      : workspace.sessionStatus === "expired"
                        ? "Срок истёк"
                        : "Входы остановлены"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Резерв для доливок — зарезервированная в проверке риска мощность будущих входов, а не
        заблокированные биржей деньги и не автоматические ордера. Реальное исполнение требует
        повторного допуска и подтверждения рыночной структуры.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        * Recovery Rate пока считается по завершённым нативным позициям: доливка и частичное
        сокращение одной позиции учитываются вместе, но отдельные хедж-позиции пока не объединяются
        в одну торговую идею. Учитываются реальные исполнения, комиссии и funding. Открытая
        убыточная позиция не считается восстановленной.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        Все счета начали с 1000 USDT. Результат включает комиссии, funding и переоценку открытых
        позиций. Срок сравнения отсчитывается от ручного запуска каждого счёта; котировки
        обновляются при фоновых проверках.
      </p>
    </section>
  );
}
