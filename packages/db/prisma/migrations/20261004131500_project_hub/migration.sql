-- Project-aware persistent context below a Space.
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "memory" TEXT NOT NULL DEFAULT '',
    "memoryRevision" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_resources" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_resources_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "scratchpad_items" ADD COLUMN "projectId" TEXT;

CREATE UNIQUE INDEX "projects_spaceId_userId_slug_key"
    ON "projects"("spaceId", "userId", "slug");
CREATE INDEX "projects_spaceId_userId_archivedAt_updatedAt_idx"
    ON "projects"("spaceId", "userId", "archivedAt", "updatedAt");

CREATE UNIQUE INDEX "project_resources_projectId_kind_ref_key"
    ON "project_resources"("projectId", "kind", "ref");
CREATE INDEX "project_resources_spaceId_userId_projectId_idx"
    ON "project_resources"("spaceId", "userId", "projectId");

CREATE INDEX "scratchpad_items_spaceId_projectId_status_idx"
    ON "scratchpad_items"("spaceId", "projectId", "status");

ALTER TABLE "projects"
    ADD CONSTRAINT "projects_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_resources"
    ADD CONSTRAINT "project_resources_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_resources"
    ADD CONSTRAINT "project_resources_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scratchpad_items"
    ADD CONSTRAINT "scratchpad_items_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
