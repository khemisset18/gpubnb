-- Add the independently measured Windows-native desktop streaming capability.
-- This field is diagnostic-only until physical qualification explicitly enables
-- the Windows runtime gate; it must never be inferred from CUDA/VRAM/Docker.
ALTER TABLE "Machine"
ADD COLUMN "nativeDesktopStreamingAvailable" BOOLEAN NOT NULL DEFAULT false;
