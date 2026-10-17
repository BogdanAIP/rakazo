import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import { z } from "zod";

const localUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "")
    );
  }, "A loopback origin is required");
export const RpcTargetsSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            apiUrl: localUrl,
            origin: localUrl,
            spaceId: z.string().min(1).max(200),
            accessToken: z
              .string()
              .regex(/^rkg_[A-Za-z0-9_-]{43}$/)
              .optional(),
            accessTokenEnv: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
              .optional(),
            procedures: z
              .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)+$/))
              .min(1)
              .max(64),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>(),
      procedures = new Set<string>();
    for (const target of value.targets) {
      if (Number(Boolean(target.accessToken)) + Number(Boolean(target.accessTokenEnv)) !== 1)
        ctx.addIssue({ code: "custom", message: "Exactly one RPC credential source is required" });
      if (names.has(target.name)) ctx.addIssue({ code: "custom", message: "Duplicate target" });
      names.add(target.name);
      for (const procedure of target.procedures) {
        if (procedures.has(procedure))
          ctx.addIssue({ code: "custom", message: "Ambiguous RPC target" });
        procedures.add(procedure);
      }
    }
  });
type RawTarget = z.infer<typeof RpcTargetsSchema>["targets"][number];
export type RpcTarget = Omit<RawTarget, "accessToken"> & { accessToken: string };
/** Explicit exact-procedure routing. A failed scoped target never falls back
 * to the default instance or borrows that instance's session credentials. */
export function configuredRpcTarget(procedure: string): RpcTarget | undefined {
  const file = process.env.RAKAZO_RPC_TARGETS_FILE;
  if (!file) return undefined;
  try {
    if (statSync(file).size > 65536) throw new Error("Oversized configuration");
    const config = RpcTargetsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const target = config.targets.find((item) => item.procedures.includes(procedure));
    if (!target) return undefined;
    const accessToken =
      target.accessToken ??
      (target.accessTokenEnv ? process.env[target.accessTokenEnv] : undefined);
    if (!accessToken || !/^rkg_[A-Za-z0-9_-]{43}$/.test(accessToken))
      throw new Error("Scoped credential unavailable");
    return { ...target, accessToken };
  } catch {
    // JSON/schema errors can include input snippets. Never expose tokens.
    throw new Error("Local RPC target configuration is unavailable or invalid");
  }
}
