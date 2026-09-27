const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface ChatGptSessionHandoff {
  callback: URL;
  state: string;
}

export function parseChatGptSessionHandoff(search: string): ChatGptSessionHandoff | null {
  const params = new URLSearchParams(search);
  if (params.getAll("callback").length !== 1 || params.getAll("state").length !== 1) {
    return null;
  }

  const rawCallback = params.get("callback");
  const state = params.get("state");
  if (!rawCallback || !state || !STATE_PATTERN.test(state)) return null;

  let callback: URL;
  try {
    callback = new URL(rawCallback);
  } catch {
    return null;
  }

  const port = Number(callback.port);
  if (
    callback.protocol !== "http:" ||
    callback.username ||
    callback.password ||
    !LOOPBACK_HOSTS.has(callback.hostname) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    callback.pathname !== "/callback" ||
    callback.search ||
    callback.hash
  ) {
    return null;
  }

  return { callback, state };
}

export async function deliverChatGptSessionToken(
  handoff: ChatGptSessionHandoff,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!token.trim() || token.length > 16_384) {
    throw new Error("Rakazo session token is unavailable.");
  }

  await request(handoff.callback.href, {
    method: "POST",
    mode: "no-cors",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ state: handoff.state, token }),
  });
}
