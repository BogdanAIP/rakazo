import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DpapiWindowsSecretProtector } from "./credential-store.js";
import { WindowsHostReadOnlyBackend } from "./readonly.js";
import { WindowsHostFileMutationBackend } from "./windows-files.js";

if (process.platform !== "win32") {
  throw new Error("Native Windows smoke must run on a Windows machine");
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-windows-native-smoke-"));
try {
  const protector = new DpapiWindowsSecretProtector();
  const plaintext = "RAKAZO_WINDOWS_DPAPI_SMOKE";
  const ciphertext = await protector.protect(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(await protector.unprotect(ciphertext), plaintext);

  const backend = new WindowsHostReadOnlyBackend(stateDir);
  const processes = await backend.listProcesses(10);
  assert.ok(processes.length > 0, "Windows tasklist returned no processes");
  assert.ok(processes.every((entry) => entry.pid > 0 && entry.name.length > 0));

  const workspace = path.join(stateDir, "workspaces", "smoke-bot");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "probe.txt"), "RAKAZO_WINDOWS_FILE_SMOKE", "utf8");

  const entries = await backend.listFiles("smoke-bot", ".");
  assert.ok(entries.some((entry) => entry.path === "probe.txt" && entry.kind === "file"));
  const file = await backend.readFile("smoke-bot", "probe.txt", 64);
  assert.equal(Buffer.from(file).toString("utf8"), "RAKAZO_WINDOWS_FILE_SMOKE");
  await assert.rejects(() => backend.readFile("smoke-bot", "../probe.txt", 64));

  const writer = new WindowsHostFileMutationBackend(stateDir, true);
  assert.equal(writer.available(), true, "Win32 relative-handle file writes are unavailable");
  const writeResult = await writer.writeFile(
    "smoke-bot",
    "nested/written.txt",
    Buffer.from("RAKAZO_WINDOWS_WRITE_SMOKE", "utf8"),
  );
  assert.deepEqual(writeResult, { path: "nested/written.txt", bytesWritten: 26 });
  const written = await backend.readFile("smoke-bot", "nested/written.txt", 64);
  assert.equal(Buffer.from(written).toString("utf8"), "RAKAZO_WINDOWS_WRITE_SMOKE");
  await assert.rejects(() =>
    writer.writeFile("smoke-bot", "../escape.txt", Buffer.from("NO", "utf8")),
  );

  console.log("Windows native DPAPI, tasklist and bounded workspace read/write smoke passed");
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
