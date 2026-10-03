import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProtectedWindowsHostCredentialStore,
  type WindowsSecretProtector,
} from "./credential-store.js";

const temporaryDirectories: string[] = [];

class FakeProtector implements WindowsSecretProtector {
  async protect(plaintext: string) {
    return Buffer.from(`protected:${plaintext}`, "utf8").toString("base64");
  }

  async unprotect(ciphertext: string) {
    const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
    if (!decoded.startsWith("protected:")) throw new Error("invalid fake ciphertext");
    return decoded.slice("protected:".length);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProtectedWindowsHostCredentialStore", () => {
  it("persists only protected credential material and restores it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rakazo-windows-host-"));
    temporaryDirectories.push(directory);
    const store = new ProtectedWindowsHostCredentialStore(directory, new FakeProtector());
    const credential = {
      hostId: "host-1",
      hostCredential: "c".repeat(48),
    };

    await store.save(credential);

    const disk = await readFile(path.join(directory, "host-credential.dpapi"), "utf8");
    expect(disk).not.toContain(credential.hostId);
    expect(disk).not.toContain(credential.hostCredential);
    await expect(store.load()).resolves.toEqual(credential);
  });

  it("returns null when no credential has been paired yet", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rakazo-windows-host-"));
    temporaryDirectories.push(directory);
    const store = new ProtectedWindowsHostCredentialStore(directory, new FakeProtector());

    await expect(store.load()).resolves.toBeNull();
  });

  it("clears persisted credentials for revocation or re-pairing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rakazo-windows-host-"));
    temporaryDirectories.push(directory);
    const store = new ProtectedWindowsHostCredentialStore(directory, new FakeProtector());

    await store.save({ hostId: "host-1", hostCredential: "c".repeat(48) });
    await store.clear();

    await expect(store.load()).resolves.toBeNull();
  });
});
