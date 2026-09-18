-- Bind the machine-level Windows native streaming diagnostic to the exact GPU
-- that passed the physical helper self-test. Bookability remains disabled until
-- physical qualification and an explicit runtime gate are added.
ALTER TABLE "Machine"
ADD COLUMN "nativeDesktopStreamingGpuUuid" VARCHAR(200);
