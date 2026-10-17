import type { PaperResearchComparison as Comparison } from "@rakazo/contracts";

const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
export function PaperResearchComparison({ comparison }: { comparison: Comparison }) {
  return (
    <details className="mt-3" aria-label="Сравнение из предложения">
      <summary className="cursor-pointer font-medium">Сравнение кандидатов</summary>
      <p className="mt-2">{comparison.method}</p>
      <p className="mt-1">{comparison.profileRationale}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Срез: {dateTime(comparison.asOf)} · предложение до {dateTime(comparison.validUntil)}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label="Сравнение кандидатов">
          <thead>
            <tr>
              <th scope="col">Инструмент</th>
              <th scope="col">Решение</th>
              <th scope="col">Основание</th>
            </tr>
          </thead>
          <tbody>
            {comparison.candidates.map((candidate) => (
              <tr key={candidate.instrument}>
                <td className="align-top pr-3">{candidate.instrument}</td>
                <td className="align-top pr-3">
                  {candidate.verdict === "selected"
                    ? "Выбран"
                    : candidate.verdict === "rejected"
                      ? "Отклонён"
                      : "Наблюдение"}
                </td>
                <td className="align-top">
                  {candidate.reason}
                  {candidate.facts.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {candidate.facts.map((fact) => fact.name + ": " + fact.value).join(" · ")}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
