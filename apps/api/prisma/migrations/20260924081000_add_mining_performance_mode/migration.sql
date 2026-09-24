-- Persist the same explicit GPU performance modes enforced by Host Desktop
-- and the resource-scoped Agent. Existing configurations safely inherit BALANCED.
CREATE TYPE "MiningPerformanceMode" AS ENUM ('ECO', 'BALANCED', 'FULL');

ALTER TABLE "MiningConfiguration"
  ADD COLUMN "performanceMode" "MiningPerformanceMode" NOT NULL DEFAULT 'BALANCED';
