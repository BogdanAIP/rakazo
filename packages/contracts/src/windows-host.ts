import * as z from "zod";

export const WINDOWS_HOST_PROTOCOL_VERSION = "1" as const;

export const WindowsHostCapabilitySchema = z.enum([
  "identity",
  "process",
  "files",
  "terminal",
  "browser",
  "screen",
  "input",
  "uia",
  "clipboard",
]);

export type WindowsHostCapability = z.infer<typeof WindowsHostCapabilitySchema>;

export const WindowsHostIdentitySchema = z.object({
  installationId: z.string().uuid(),
  hostname: z.string().trim().min(1).max(255),
  platform: z.literal("win32"),
  release: z.string().trim().min(1).max(128),
  arch: z.string().trim().min(1).max(32),
});

export type WindowsHostIdentity = z.infer<typeof WindowsHostIdentitySchema>;

export const WindowsHostAdvertisementSchema = z.object({
  protocolVersion: z.literal(WINDOWS_HOST_PROTOCOL_VERSION),
  runtimeVersion: z.string().trim().min(1).max(64),
  identity: WindowsHostIdentitySchema,
  capabilities: z.array(WindowsHostCapabilitySchema).min(1).max(32),
  startedAt: z.iso.datetime(),
});

export type WindowsHostAdvertisement = z.infer<typeof WindowsHostAdvertisementSchema>;

/**
 * A short-lived, single-use pairing capability is presented in the Authorization
 * header. It is deliberately absent from this body so credentials never enter
 * normal structured logs or persisted host metadata.
 */
export const WindowsHostPairingClaimSchema = z.object({
  advertisement: WindowsHostAdvertisementSchema,
});

export type WindowsHostPairingClaim = z.infer<typeof WindowsHostPairingClaimSchema>;

export const WindowsHostPairingResultSchema = z.object({
  hostId: z.string().min(1).max(200),
  hostCredential: z.string().min(32).max(4096),
  heartbeatIntervalMs: z.number().int().min(1_000).max(300_000),
  pairedAt: z.iso.datetime(),
});

export type WindowsHostPairingResult = z.infer<typeof WindowsHostPairingResultSchema>;

export const WindowsHostHeartbeatSchema = z.object({
  protocolVersion: z.literal(WINDOWS_HOST_PROTOCOL_VERSION),
  hostId: z.string().min(1).max(200),
  connectionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sentAt: z.iso.datetime(),
  advertisement: WindowsHostAdvertisementSchema,
});

export type WindowsHostHeartbeat = z.infer<typeof WindowsHostHeartbeatSchema>;

export const WindowsHostHeartbeatResultSchema = z.object({
  ok: z.literal(true),
  serverTime: z.iso.datetime(),
  revoked: z.boolean().default(false),
});

export type WindowsHostHeartbeatResult = z.infer<typeof WindowsHostHeartbeatResultSchema>;

export const WindowsHostRevocationSchema = z.object({
  hostId: z.string().min(1).max(200),
  revokedAt: z.iso.datetime(),
});

export type WindowsHostRevocation = z.infer<typeof WindowsHostRevocationSchema>;

export const WindowsHostCommandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity.get") }),
]);

export type WindowsHostCommandRequest = z.infer<typeof WindowsHostCommandRequestSchema>;

export const WindowsHostCommandEnvelopeSchema = z.object({
  id: z.string().uuid(),
  request: WindowsHostCommandRequestSchema,
});

export type WindowsHostCommandEnvelope = z.infer<typeof WindowsHostCommandEnvelopeSchema>;

export const WindowsHostCommandResultSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string().uuid(),
    ok: z.literal(true),
    result: z.object({
      kind: z.literal("identity"),
      identity: WindowsHostIdentitySchema,
    }),
  }),
  z.object({
    id: z.string().uuid(),
    ok: z.literal(false),
    error: z.string().trim().min(1).max(2_000),
  }),
]);

export type WindowsHostCommandResult = z.infer<typeof WindowsHostCommandResultSchema>;

export const WindowsHostInternalDispatchSchema = z.object({
  hostId: z.string().trim().min(1).max(200),
  ownerUserId: z.string().trim().min(1).max(200),
  request: WindowsHostCommandRequestSchema,
});

export type WindowsHostInternalDispatch = z.infer<typeof WindowsHostInternalDispatchSchema>;

export const WindowsHostCommandPollSchema = z.object({
  hostId: z.string().min(1).max(200),
});

export type WindowsHostCommandPoll = z.infer<typeof WindowsHostCommandPollSchema>;

export const WindowsHostCommandReportSchema = z.object({
  hostId: z.string().min(1).max(200),
  result: WindowsHostCommandResultSchema,
});

export type WindowsHostCommandReport = z.infer<typeof WindowsHostCommandReportSchema>;
