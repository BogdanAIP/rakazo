CREATE TABLE "market_entries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "originalContent" TEXT NOT NULL,
    "adaptedContent" TEXT,
    "adaptationMode" TEXT,
    "preferredVariant" TEXT NOT NULL DEFAULT 'original',
    "sourceUrl" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "sourcePath" TEXT,
    "sourceRef" TEXT NOT NULL,
    "license" TEXT,
    "digest" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_entries_spaceId_userId_kind_key_key"
    ON "market_entries"("spaceId", "userId", "kind", "key");

CREATE INDEX "market_entries_spaceId_userId_kind_name_idx"
    ON "market_entries"("spaceId", "userId", "kind", "name");

ALTER TABLE "market_entries"
    ADD CONSTRAINT "market_entries_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
