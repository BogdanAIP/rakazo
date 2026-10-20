import { Link } from "react-router-dom";
import { useLinkedPaperJournal } from "../lib/use-linked-paper-journal";

export function LinkedPaperJournalPage() {
  const state = useLinkedPaperJournal();
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border px-4 py-3">
        <Link to="/app" className="text-sm text-muted-foreground underline">
          ← Rakazo
        </Link>
        <h1 className="text-lg font-semibold">Журнал PAPER</h1>
      </header>
      {state === "ready" ? (
        <iframe
          src="/linked-paper/view"
          title="Журнал виртуальной торговли"
          className="min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          {state === "checking" ? "Проверка доступа…" : "Журнал сейчас недоступен."}
        </p>
      )}
    </main>
  );
}
