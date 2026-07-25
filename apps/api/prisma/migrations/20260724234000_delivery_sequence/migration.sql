-- Per-machine monotonic counters avoid MAX(sequence) races under horizontal concurrency.
CREATE TABLE "MachineCommandSequence" (
    "machineId" TEXT PRIMARY KEY,
    "nextSequence" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineCommandSequence_next_check" CHECK ("nextSequence" > 0),
    CONSTRAINT "MachineCommandSequence_machineId_fkey"
        FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION reserve_machine_command_sequence(target_machine_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    reserved BIGINT;
BEGIN
    INSERT INTO "MachineCommandSequence" ("machineId", "nextSequence")
    VALUES (target_machine_id, 2)
    ON CONFLICT ("machineId") DO UPDATE
      SET "nextSequence" = "MachineCommandSequence"."nextSequence" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextSequence" - 1 INTO reserved;

    RETURN reserved;
END;
$$;
