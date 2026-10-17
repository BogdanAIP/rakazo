CREATE TABLE "rpc_access_grants" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "procedures" JSONB NOT NULL,
  "tokenSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "rpc_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rpc_access_grants_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "rpc_access_grants_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "rpc_access_grants_tokenSha256_key" ON "rpc_access_grants"("tokenSha256");
CREATE INDEX "rpc_access_grants_owner_idx" ON "rpc_access_grants"("spaceId", "ownerUserId", "createdAt");
