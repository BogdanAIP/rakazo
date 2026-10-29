// Public, read-only OKX 15-minute candle transport for Python collector.
// Fixed origin/path and GET only. Never accepts credentials or arbitrary URLs.
const [symbol, cursorArg, limitArg] = process.argv.slice(2);
if (!/^[A-Z0-9]+-USDT-SWAP$/.test(symbol || "")) {
  process.stderr.write("Invalid OKX market symbol\n");
  process.exit(2);
}
const limit = Number(limitArg);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  process.stderr.write("Invalid page limit\n");
  process.exit(2);
}
if (cursorArg !== "-" && !/^\d{13}$/.test(cursorArg || "")) {
  process.stderr.write("Invalid backwards cursor\n");
  process.exit(2);
}
const url = new URL("https://www.okx.com/api/v5/market/history-candles");
url.searchParams.set("instId", symbol);
url.searchParams.set("bar", "15m");
url.searchParams.set("limit", String(limit));
if (cursorArg !== "-") url.searchParams.set("after", cursorArg);
try {
  const response = await fetch(url, {
    method: "GET", redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("HTTP_" + response.status);
  const data = await response.text();
  if (Buffer.byteLength(data, "utf8") > 262144) throw new Error("response_too_large");
  const body = JSON.parse(data);
  if (body?.code !== "0" || !Array.isArray(body.data)) throw new Error("bad_okx_data");
  process.stdout.write(data);
} catch (err) {
  process.stderr.write("public_history_transport: " + String(err?.message || err) + "\n");
  process.exit(1);
}
