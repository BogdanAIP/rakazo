import { useEffect, useState } from "react";

export function useLinkedPaperJournal() {
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");
  useEffect(() => {
    let mounted = true;
    void fetch("/linked-paper/status", { credentials: "same-origin" })
      .then(async (response) => response.ok && (await response.json()).available === true)
      .then((available) => {
        if (mounted) setState(available ? "ready" : "unavailable");
      })
      .catch(() => {
        if (mounted) setState("unavailable");
      });
    return () => {
      mounted = false;
    };
  }, []);
  return state;
}
