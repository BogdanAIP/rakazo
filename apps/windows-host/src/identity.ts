import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, hostname, platform, release } from "node:os";
import path from "node:path";
import { type WindowsHostIdentity, WindowsHostIdentitySchema } from "@rakazo/contracts";

const IDENTITY_FILE = "identity.json";

export async function loadOrCreateWindowsHostIdentity(
  stateDir: string,
): Promise<WindowsHostIdentity> {
  if (platform() !== "win32") {
    throw new Error("Rakazo Windows host runtime requires Windows");
  }

  await mkdir(stateDir, { recursive: true });

  const identityPath = path.join(stateDir, IDENTITY_FILE);
  const existing = await readFile(identityPath, "utf8").catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });

  if (existing !== null) {
    return WindowsHostIdentitySchema.parse(JSON.parse(existing));
  }

  const identity = WindowsHostIdentitySchema.parse({
    installationId: randomUUID(),
    hostname: hostname(),
    platform: "win32",
    release: release(),
    arch: arch(),
  });

  const tempPath = path.join(stateDir, `.${IDENTITY_FILE}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, identityPath);

  return identity;
}

function hasCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
