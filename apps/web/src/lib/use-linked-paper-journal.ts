import { useEffect, useState } from "react";

export function useLinkedPaperJournal() {
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/linked-paper/status", { credentials: "same-origin", signal: abort.signal })
      .then(async (response) => response.ok && (await response.json()).available === true)
      .then((available) => {
        if (!abort.signal.aborted) setState(available ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!abort.signal.aborted) setState("unavailable");
      });
    return () => abort.abort();
  }, []);
  return state;
}
