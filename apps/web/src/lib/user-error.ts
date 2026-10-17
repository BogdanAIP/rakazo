import { t } from "@lingui/core/macro";
import { userErrorMessage } from "@rakazo/core";

/** Text for a failure: human messages pass through; transport/technical failures become friendly copy. */
export function errorText(error: unknown, fallback: string): string {
  return userErrorMessage(error, { fallback, offline: t`Could not reach the server` });
}
