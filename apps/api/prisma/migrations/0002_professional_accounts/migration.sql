ALTER TABLE "User"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "countryCode" TEXT,
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'fr',
  ADD COLUMN "canRent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "canHost" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "profileCompletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

ALTER TABLE "Profile"
  ADD COLUMN "companyName" TEXT,
  ADD COLUMN "websiteUrl" TEXT;
