import { describe, expect, it } from "vitest";
import {
  chatGptSessionHandoffNext,
  deliverChatGptSessionToken,
  parseChatGptSessionHandoff,
} from "./chatgpt-session-handoff";

const STATE = "abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789_-";

describe("ChatGPT session handoff", () => {
  it("accepts only one fixed loopback callback and a strong state", () => {
    const handoff = parseChatGptSessionHandoff(
      `?callback=${encodeURIComponent("http://127.0.0.1:49152/callback")}&state=${STATE}`,
    );

    expect(handoff?.callback.href).toBe("http://127.0.0.1:49152/callback");
    expect(handoff?.state).toBe(STATE);
  });

  it.each([
    "https://127.0.0.1:49152/callback",
    "http://example.com:49152/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:49152/other",
    "http://127.0.0.1:49152/callback?x=1",
  ])("rejects unsafe callback %s", (callback) => {
    expect(
      parseChatGptSessionHandoff(`?callback=${encodeURIComponent(callback)}&state=${STATE}`),
    ).toBeNull();
  });

  it("rejects duplicate and weak handoff parameters", () => {
    expect(
      parseChatGptSessionHandoff(
        `?callback=${encodeURIComponent("http://127.0.0.1:49152/callback")}&callback=${encodeURIComponent("http://127.0.0.1:49153/callback")}&state=${STATE}`,
      ),
    ).toBeNull();
    expect(
      parseChatGptSessionHandoff(
        `?callback=${encodeURIComponent("http://127.0.0.1:49152/callback")}&state=short`,
      ),
    ).toBeNull();
  });


  it("preserves only a fully validated handoff as an auth next target", () => {
    const next = `/chatgpt/session?callback=${encodeURIComponent(
      "http://127.0.0.1:49152/callback",
    )}&state=${STATE}`;
    expect(chatGptSessionHandoffNext(next)).toBe(next);
    expect(chatGptSessionHandoffNext("/app")).toBeNull();
    expect(chatGptSessionHandoffNext("/chatgpt/session?state=short")).toBeNull();
    expect(chatGptSessionHandoffNext("https://example.com/chatgpt/session")).toBeNull();
  });

  it("posts the token only in a no-cors loopback request body", async () => {
    const handoff = parseChatGptSessionHandoff(
      `?callback=${encodeURIComponent("http://localhost:49152/callback")}&state=${STATE}`,
    );
    expect(handoff).not.toBeNull();

    let observed: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed = { input, init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await deliverChatGptSessionToken(handoff!, "session-secret", request);

    expect(String(observed?.input)).toBe("http://localhost:49152/callback");
    expect(observed?.init).toMatchObject({
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    expect(observed?.init?.body).toBe(JSON.stringify({ state: STATE, token: "session-secret" }));
  });
});
