import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useMemo, useState } from "react";
import {
  deliverChatGptSessionToken,
  parseChatGptSessionHandoff,
} from "../lib/chatgpt-session-handoff";

export function ChatGptSessionBridgePage({ sessionToken }: { sessionToken: string }) {
  const handoff = useMemo(() => parseChatGptSessionHandoff(window.location.search), []);
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");

  if (!handoff) {
    return (
      <main className="grid h-full place-items-center bg-background px-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">
            <Trans>Invalid ChatGPT connection request</Trans>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <Trans>Return to the Rakazo launcher and start the connection again.</Trans>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid h-full place-items-center bg-background px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold">
          <Trans>Connect Rakazo to ChatGPT</Trans>
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          <Trans>
            Rakazo will send your current local session to the one-time launcher callback on this
            computer. The session token is never shown or placed in the URL.
          </Trans>
        </p>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {handoff.callback.origin}
        </p>

        {status === "done" ? (
          <p className="mt-6 text-sm">
            <Trans>Connected. You can close this tab and return to ChatGPT.</Trans>
          </p>
        ) : (
          <div className="mt-6">
            <Button
              disabled={status === "sending"}
              onClick={() => {
                setStatus("sending");
                void deliverChatGptSessionToken(handoff, sessionToken)
                  .then(() => setStatus("done"))
                  .catch(() => setStatus("error"));
              }}
            >
              {status === "sending" ? <Trans>Connecting…</Trans> : <Trans>Connect ChatGPT</Trans>}
            </Button>
            {status === "error" ? (
              <p className="mt-3 text-sm text-destructive">
                <Trans>The launcher did not accept the session. Retry from the launcher.</Trans>
              </p>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
