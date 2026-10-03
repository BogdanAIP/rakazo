import os from "node:os";
import path from "node:path";

export interface WindowsHostConfig {
  origin: string | null;
  stateDir: string;
  pairingToken: string | null;
  hostId: string | null;
  hostCredential: string | null;
}

export function loadWindowsHostConfig(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): WindowsHostConfig {
  const localAppData = env.LOCALAPPDATA?.trim();
  const stateDir =
    env.RAKAZO_WINDOWS_HOST_STATE_DIR?.trim() ||
    path.join(localAppData || homeDir, "Rakazo", "windows-host");

  return {
    origin: env.RAKAZO_WINDOWS_HOST_ORIGIN?.trim() || null,
    stateDir,
    pairingToken: env.RAKAZO_WINDOWS_HOST_PAIRING_TOKEN?.trim() || null,
    hostId: env.RAKAZO_WINDOWS_HOST_ID?.trim() || null,
    hostCredential: env.RAKAZO_WINDOWS_HOST_CREDENTIAL?.trim() || null,
  };
}
