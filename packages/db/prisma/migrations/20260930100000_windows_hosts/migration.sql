-- Durable physical-Windows host identity and single-use pairing capabilities.
CREATE TABLE "windows_hosts" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "release" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastConnectionId" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "windows_hosts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "windows_host_pairings" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "windows_host_pairings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "windows_hosts_installationId_key"
    ON "windows_hosts"("installationId");

CREATE UNIQUE INDEX "windows_hosts_credentialHash_key"
    ON "windows_hosts"("credentialHash");

CREATE INDEX "windows_hosts_ownerUserId_revokedAt_lastSeenAt_idx"
    ON "windows_hosts"("ownerUserId", "revokedAt", "lastSeenAt");

CREATE UNIQUE INDEX "windows_host_pairings_tokenHash_key"
    ON "windows_host_pairings"("tokenHash");

CREATE INDEX "windows_host_pairings_ownerUserId_expiresAt_idx"
    ON "windows_host_pairings"("ownerUserId", "expiresAt");
