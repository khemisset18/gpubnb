-- Runtime events authenticated with agent-v2 must always carry a durable
-- per-machine counter. Zero is reserved for legacy rows created before the
-- signed runtime-event protocol became mandatory.
UPDATE "MiningRuntimeEvent"
   SET "agentCounter" = 0
 WHERE "agentCounter" IS NULL;

ALTER TABLE "MiningRuntimeEvent"
  ALTER COLUMN "agentCounter" SET NOT NULL;

ALTER TABLE "MiningRuntimeEvent"
  ADD CONSTRAINT "MiningRuntimeEvent_agentCounter_nonnegative_check"
  CHECK ("agentCounter" >= 0);
