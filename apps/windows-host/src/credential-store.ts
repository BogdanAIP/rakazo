import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredWindowsHostCredential {
  hostId: string;
  hostCredential: string;
}

export interface WindowsHostCredentialStore {
  load(): Promise<StoredWindowsHostCredential | null>;
  save(value: StoredWindowsHostCredential): Promise<void>;
  clear(): Promise<void>;
}

export interface WindowsSecretProtector {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

const CREDENTIAL_FILE = "host-credential.dpapi";
const MAX_PROTECTOR_OUTPUT_BYTES = 16 * 1024;

export class DpapiWindowsSecretProtector implements WindowsSecretProtector {
  async protect(plaintext: string): Promise<string> {
    requireWindows();
    return runPowerShell(
      [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Security",
        "$value=[Console]::In.ReadToEnd()",
        "$bytes=[Text.Encoding]::UTF8.GetBytes($value)",
        "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Convert]::ToBase64String($protected))",
      ].join(";"),
      plaintext,
    );
  }

  async unprotect(ciphertext: string): Promise<string> {
    requireWindows();
    return runPowerShell(
      [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.Security",
        "$value=[Console]::In.ReadToEnd()",
        "$bytes=[Convert]::FromBase64String($value)",
        "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
      ].join(";"),
      ciphertext,
    );
  }
}

export class ProtectedWindowsHostCredentialStore implements WindowsHostCredentialStore {
  constructor(
    private readonly stateDir: string,
    private readonly protector: WindowsSecretProtector = new DpapiWindowsSecretProtector(),
  ) {}

  async load(): Promise<StoredWindowsHostCredential | null> {
    const encrypted = await readFile(path.join(this.stateDir, CREDENTIAL_FILE), "utf8").catch(
      (error: unknown) => {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (encrypted === null) return null;

    const plaintext = await this.protector.unprotect(encrypted.trim());
    return parseStoredCredential(plaintext);
  }

  async save(value: StoredWindowsHostCredential): Promise<void> {
    const parsed = parseStoredCredential(JSON.stringify(value));
    await mkdir(this.stateDir, { recursive: true });
    const encrypted = await this.protector.protect(JSON.stringify(parsed));
    const target = path.join(this.stateDir, CREDENTIAL_FILE);
    const temporary = path.join(this.stateDir, `.${CREDENTIAL_FILE}.${randomUUID()}.tmp`);
    await writeFile(temporary, encrypted, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async clear(): Promise<void> {
    await rm(path.join(this.stateDir, CREDENTIAL_FILE), { force: true });
  }
}

function parseStoredCredential(value: string): StoredWindowsHostCredential {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("hostId" in parsed) ||
    typeof parsed.hostId !== "string" ||
    parsed.hostId.length < 1 ||
    parsed.hostId.length > 200 ||
    !("hostCredential" in parsed) ||
    typeof parsed.hostCredential !== "string" ||
    parsed.hostCredential.length < 32 ||
    parsed.hostCredential.length > 4096
  ) {
    throw new Error("Stored Windows host credential is invalid");
  }
  return { hostId: parsed.hostId, hostCredential: parsed.hostCredential };
}

function requireWindows() {
  if (process.platform !== "win32") {
    throw new Error("Windows host credential protection requires Windows");
  }
}

function runPowerShell(script: string, stdin: string): Promise<string> {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROTECTOR_OUTPUT_BYTES) {
        fail(new Error("Windows credential protector output exceeded its limit"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_PROTECTOR_OUTPUT_BYTES) {
        fail(new Error("Windows credential protector error output exceeded its limit"));
      }
    });
    child.once("error", () => fail(new Error("Windows credential protector could not start")));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const diagnostic = sanitizePowerShellDiagnostic(stderr);
        reject(
          new Error(
            diagnostic
              ? `Windows credential protector failed: ${diagnostic}`
              : "Windows credential protector failed",
          ),
        );
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(stdin);
  });
}

function sanitizePowerShellDiagnostic(value: string) {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function hasCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
