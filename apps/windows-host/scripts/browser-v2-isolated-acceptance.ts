import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWindowsBrowserBackend } from "../src/browser-backend-factory.js";

const dir = await mkdtemp(path.join(tmpdir(), "bv2-accept-"));
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    req.url === "/frame"
      ? '<title>Frame</title><input type="search" aria-label="Test field" oninput="document.getElementById(\'out\').textContent=this.value"><p id="out">Waiting</p>'
      : '<title>Acceptance</title><h1>Local only</h1><iframe title="Test frame" src="/frame"></iframe>',
  );
});
let token: string | undefined;
const backend = createWindowsBrowserBackend(path.join(dir, "state"), {
  ...process.env,
  RAKAZO_BROWSER_BACKEND: "auto",
  RAKAZO_PLAYWRIGHT_USER_DATA_DIR: path.join(dir, "profile"),
  RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "chrome",
  RAKAZO_PLAYWRIGHT_HEADED: "false",
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  const url = `http://127.0.0.1:${addr.port}`;
  const o = await backend.browser("bv2-accept", { command: "open", mode: "auto" });
  token = o.sessionToken;
  console.log("OPEN", o.ok, o.backendMode);
  if (!o.ok || !token || o.backendMode !== "playwright-cli-persistent")
    throw Error("Wrong auto route");
  const n = await backend.browser("bv2-accept", { command: "navigate", sessionToken: token, url });
  console.log("NAV", n.ok, n.error ?? "");
  if (!n.ok) throw Error("Navigation failure");
  const s = await backend.browser("bv2-accept", { command: "snapshot", sessionToken: token });
  const f = s.elements?.find((e) => e.name.includes("Test field"));
  console.log("FRAME_REF", f?.ref ?? "missing");
  if (!f) throw Error("Missing iframe field");
  const a = await backend.browser("bv2-accept", {
    command: "act",
    sessionToken: token,
    actions: [{ kind: "fill", ref: f.ref, text: "hydrogen" }],
  });
  console.log("ACT", a.ok, a.error ?? "");
  if (!a.ok) throw Error("Fill failed");
  const v = await backend.browser("bv2-accept", { command: "snapshot", sessionToken: token });
  console.log("VERIFIED", v.ok && (v.tree ?? "").includes("hydrogen"));
  if (!v.ok || !(v.tree ?? "").includes("hydrogen")) throw Error("Value not reflected");
  console.log("PHYSICAL_PASS");
} catch (e) {
  console.log("PHYSICAL_FAIL", String(e));
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      const r = await backend.browser("bv2-accept", { command: "close", sessionToken: token });
      console.log("CLOSE", r.ok);
    } catch (e) {
      console.log("CLOSE_FAIL", String(e));
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
