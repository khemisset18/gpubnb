-- Non-destructive authentication normalization. The legacy User.wallet column is
-- intentionally retained for one release so old API binaries can be rolled back.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User" GROUP BY lower("pseudonym") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Case-insensitive pseudonym collision detected; resolve it before migration 0003';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE "pseudonym" !~ '^[A-Za-z][A-Za-z0-9_-]{2,31}$'
  ) THEN
    RAISE EXCEPTION 'Invalid legacy pseudonym detected; resolve it before migration 0003';
  END IF;
  IF EXISTS (SELECT 1 FROM "User" WHERE "wallet" = 'supabase:') THEN
    RAISE EXCEPTION 'Malformed legacy Supabase identity detected; resolve it before migration 0003';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Profile"
    WHERE length("bio") > 1000 OR length("avatarUrl") > 2048
  ) THEN
    RAISE EXCEPTION 'Oversized legacy profile detected; resolve it before migration 0003';
  END IF;
END $$;

CREATE TYPE "SecurityEventType" AS ENUM (
  'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'NEW_DEVICE', 'LOGOUT', 'LOGOUT_ALL',
  'PASSWORD_CHANGED', 'PASSWORD_RESET', 'EMAIL_CHANGE_REQUESTED', 'EMAIL_CHANGED',
  'IDENTITY_LINKED', 'IDENTITY_UNLINKED', 'WALLET_LINKED', 'WALLET_UNLINKED',
  'ACCOUNT_DELETION_REQUESTED', 'ACCOUNT_DELETED'
);
CREATE TYPE "AccountDeletionStatus" AS ENUM ('PENDING', 'CANCELLED', 'COMPLETED');

ALTER TABLE "User"
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "wallet" DROP NOT NULL,
  ALTER COLUMN "pseudonym" TYPE VARCHAR(32);

ALTER TABLE "Profile"
  ADD COLUMN "displayName" VARCHAR(80),
  ADD COLUMN "countryCode" CHAR(2),
  ADD COLUMN "locale" VARCHAR(16) NOT NULL DEFAULT 'en',
  ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
  ADD COLUMN "profilePublic" BOOLEAN NOT NULL DEFAULT true,
  ALTER COLUMN "bio" TYPE VARCHAR(1000),
  ALTER COLUMN "avatarUrl" TYPE VARCHAR(2048);

ALTER TABLE "User"
  ADD CONSTRAINT "User_pseudonym_format" CHECK ("pseudonym" ~ '^[A-Za-z][A-Za-z0-9_-]{2,31}$');
CREATE UNIQUE INDEX "User_pseudonym_case_insensitive_key" ON "User" (lower("pseudonym"));
ALTER TABLE "Profile"
  ADD CONSTRAINT "Profile_countryCode_format" CHECK ("countryCode" IS NULL OR "countryCode" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "Profile_reliabilityScore_range" CHECK ("reliabilityScore" BETWEEN 0 AND 100),
  ADD CONSTRAINT "Profile_completedSessions_nonnegative" CHECK ("completedSessions" >= 0);

CREATE TABLE "AuthIdentity" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "subject" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320),
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  CONSTRAINT "AuthIdentity_provider_subject_key" UNIQUE ("provider", "subject"),
  CONSTRAINT "AuthIdentity_provider_format" CHECK ("provider" ~ '^[a-z][a-z0-9_-]{1,31}$')
);

CREATE TABLE "UserWallet" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "address" VARCHAR(64) NOT NULL UNIQUE,
  "label" VARCHAR(80),
  "canAuthenticate" BOOLEAN NOT NULL DEFAULT false,
  "canPay" BOOLEAN NOT NULL DEFAULT true,
  "canReceive" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3)
);

CREATE TABLE "UserSession" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "sessionVersion" INTEGER NOT NULL,
  "userAgentHash" CHAR(64),
  "ipPrefixHash" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idleExpiresAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" VARCHAR(64),
  CONSTRAINT "UserSession_expiry_valid" CHECK ("idleExpiresAt" > "createdAt" AND "expiresAt" > "createdAt")
);

CREATE TABLE "SecurityEvent" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "type" "SecurityEventType" NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT true,
  "ipPrefixHash" CHAR(64),
  "userAgentHash" CHAR(64),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "NotificationPreference" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "securityEmail" BOOLEAN NOT NULL DEFAULT true,
  "bookingEmail" BOOLEAN NOT NULL DEFAULT true,
  "marketingEmail" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "AccountDeletionRequest" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "status" "AccountDeletionStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executeAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AccountDeletionRequest_schedule_valid" CHECK ("executeAt" >= "requestedAt")
);

-- Deterministic IDs make this backfill safe to resume after a transactional retry.
INSERT INTO "AuthIdentity" ("id", "userId", "provider", "subject", "lastUsedAt")
SELECT 'legacy_identity_' || md5("id"), "id", 'supabase', substring("wallet" FROM 10), "lastLoginAt"
FROM "User" WHERE "wallet" LIKE 'supabase:%'
ON CONFLICT ("provider", "subject") DO NOTHING;

INSERT INTO "AuthIdentity" ("id", "userId", "provider", "subject", "lastUsedAt")
SELECT 'legacy_identity_' || md5("id"), "id", 'phantom', "wallet", "lastLoginAt"
FROM "User" WHERE "wallet" NOT LIKE 'supabase:%'
ON CONFLICT ("provider", "subject") DO NOTHING;

INSERT INTO "UserWallet" (
  "id", "userId", "address", "canAuthenticate", "canPay", "canReceive", "verifiedAt"
)
SELECT 'legacy_wallet_' || md5("id"), "id", "wallet", true, true, true, COALESCE("lastLoginAt", "createdAt")
FROM "User" WHERE "wallet" NOT LIKE 'supabase:%'
ON CONFLICT ("address") DO NOTHING;

INSERT INTO "NotificationPreference" ("id", "userId")
SELECT 'notification_' || md5("id"), "id" FROM "User"
ON CONFLICT ("userId") DO NOTHING;

CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");
CREATE INDEX "AuthIdentity_email_idx" ON "AuthIdentity"("email");
CREATE INDEX "UserWallet_userId_idx" ON "UserWallet"("userId");
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");
CREATE INDEX "AccountDeletionRequest_userId_status_idx" ON "AccountDeletionRequest"("userId", "status");
CREATE INDEX "AccountDeletionRequest_status_executeAt_idx" ON "AccountDeletionRequest"("status", "executeAt");

ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT;

COMMIT;
