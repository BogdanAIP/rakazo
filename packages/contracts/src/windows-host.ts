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

export const WindowsHostBrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ref: z.string().regex(/^e\d{1,6}$/u) }),
  z.object({
    kind: z.enum(["fill", "type"]),
    ref: z.string().regex(/^e\d{1,6}$/u),
    text: z.string().max(10_000),
    origin: z.string().url().optional(),
  }),
]);

export const WindowsHostBrowserRequestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("navigate"), url: z.string().url().max(4_096) }),
  z.object({ command: z.literal("snapshot") }),
  z.object({
    command: z.literal("act"),
    actions: z.array(WindowsHostBrowserActionSchema).min(1).max(4),
  }),
]);

export type WindowsHostBrowserRequest = z.infer<typeof WindowsHostBrowserRequestSchema>;

export const WindowsHostBrowserResultSchema = z.object({
  ok: z.boolean(),
  completed: z.number().int().min(0).max(4).optional(),
  uncertain: z.boolean().optional(),
  url: z.string().max(4_096).optional(),
  title: z.string().max(2_048).optional(),
  tree: z.string().max(65_536).optional(),
  elements: z.array(z.object({
    ref: z.string().regex(/^e\d{1,6}$/u),
    role: z.string().max(200),
    name: z.string().max(200),
  })).max(500).optional(),
  error: z.string().max(500).optional(),
});

export type WindowsHostBrowserResult = z.infer<typeof WindowsHostBrowserResultSchema>;

export const WindowsHostCommandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity.get") }),
  z.object({
    kind: z.literal("process.list"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    kind: z.literal("files.list"),
    botId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    directory: z.string().max(4_096),
  }),
  z.object({
    kind: z.literal("files.read"),
    botId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    path: z.string().min(1).max(4_096),
    maxBytes: z.number().int().min(1).max(65_536).default(32_768),
  }),
  z.object({
    kind: z.literal("browser.call"),
    botId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    request: WindowsHostBrowserRequestSchema,
  }),
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
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("identity"),
        identity: WindowsHostIdentitySchema,
      }),
      z.object({
        kind: z.literal("processes"),
        processes: z
          .array(
            z.object({
              pid: z.number().int().positive(),
              name: z.string().trim().min(1).max(256),
            }),
          )
          .max(100),
      }),
      z.object({
        kind: z.literal("files"),
        entries: z
          .array(
            z.object({
              path: z.string().max(4_096),
              kind: z.enum(["file", "dir"]),
              size: z.number().int().nonnegative(),
            }),
          )
          .max(128),
      }),
      z.object({
        kind: z.literal("file"),
        contentBase64: z.string().max(90_000),
      }),
      z.object({
        kind: z.literal("browser"),
        response: WindowsHostBrowserResultSchema,
      }),
    ]),
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
