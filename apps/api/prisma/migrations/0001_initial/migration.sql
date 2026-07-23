CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "MachineConnectivity" AS ENUM ('OFFLINE','ONLINE');
CREATE TYPE "MachineOperational" AS ENUM ('UNAVAILABLE','VERIFYING','AVAILABLE','RESERVED','RUNNING','DEGRADED','MAINTENANCE');
CREATE TYPE "ModerationStatus" AS ENUM ('CLEAR','SUSPENDED','QUARANTINED');
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT','PENDING_GPU_VERIFICATION','ACTIVE','RESERVED','HIDDEN_OFFLINE','SUSPENDED');
CREATE TYPE "BookingStatus" AS ENUM ('CREATED','AWAITING_DEPOSIT','FUNDED','STARTING','ACTIVE','DEGRADED','COMPLETED','DISPUTED','SETTLED','REFUNDED','CANCELLED');
CREATE TYPE "PaymentStatus" AS ENUM ('ESCROW_PENDING','ESCROW_FUNDED','SETTLEMENT_PENDING','PARTIALLY_REFUNDED','FULLY_REFUNDED','RELEASED','FROZEN');

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "wallet" TEXT NOT NULL UNIQUE,
  "pseudonym" TEXT NOT NULL UNIQUE,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Profile" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "bio" TEXT,
  "avatarUrl" TEXT,
  "reliabilityScore" INTEGER NOT NULL DEFAULT 0,
  "completedSessions" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "Machine" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "agentPublicKey" TEXT NOT NULL UNIQUE,
  "connectivity" "MachineConnectivity" NOT NULL DEFAULT 'OFFLINE',
  "operational" "MachineOperational" NOT NULL DEFAULT 'UNAVAILABLE',
  "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'CLEAR',
  "lastHeartbeatAt" TIMESTAMP(3),
  "lastCounter" BIGINT NOT NULL DEFAULT 0,
  "gpuUuid" TEXT,
  "gpuModel" TEXT,
  "vramMiB" INTEGER,
  "driverVersion" TEXT,
  "lastCudaProbeOk" BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt" TIMESTAMP(3)
);
CREATE TABLE "GpuListing" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "description" VARCHAR(3000) NOT NULL,
  "hourlyLamports" BIGINT NOT NULL,
  "status" "ListingStatus" NOT NULL DEFAULT 'PENDING_GPU_VERIFICATION',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "Booking" (
  "id" TEXT PRIMARY KEY,
  "buyerId" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "quotedLamports" BIGINT NOT NULL,
  "validSeconds" INTEGER NOT NULL DEFAULT 0,
  "expectedSeconds" INTEGER NOT NULL,
  "status" "BookingStatus" NOT NULL DEFAULT 'CREATED',
  "escrowAddress" TEXT,
  "depositSignature" TEXT UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Booking_buyerId_idempotencyKey_key" UNIQUE ("buyerId","idempotencyKey")
);
CREATE TABLE "Payment" (
  "id" TEXT PRIMARY KEY,
  "bookingId" TEXT NOT NULL UNIQUE,
  "grossLamports" BIGINT NOT NULL,
  "payableLamports" BIGINT NOT NULL DEFAULT 0,
  "platformLamports" BIGINT NOT NULL DEFAULT 0,
  "providerLamports" BIGINT NOT NULL DEFAULT 0,
  "refundLamports" BIGINT NOT NULL DEFAULT 0,
  "status" "PaymentStatus" NOT NULL DEFAULT 'ESCROW_PENDING',
  "settlementSignature" TEXT UNIQUE
);
CREATE TABLE "Heartbeat" (
  "id" TEXT PRIMARY KEY,
  "machineId" TEXT NOT NULL,
  "counter" BIGINT NOT NULL,
  "agentTimestamp" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "gpuUtilization" INTEGER NOT NULL,
  "memoryUsedMiB" INTEGER NOT NULL,
  "temperatureC" INTEGER NOT NULL,
  "cudaProbeOk" BOOLEAN NOT NULL,
  "sessionId" TEXT,
  "signatureHash" TEXT NOT NULL UNIQUE,
  CONSTRAINT "Heartbeat_machineId_counter_key" UNIQUE ("machineId","counter")
);
CREATE TABLE "UsageSample" (
  "id" TEXT PRIMARY KEY,
  "bookingId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL,
  "available" BOOLEAN NOT NULL,
  "workloadProof" BOOLEAN NOT NULL,
  "gpuUtilization" INTEGER NOT NULL,
  "temperatureC" INTEGER NOT NULL,
  "sourceHash" TEXT NOT NULL UNIQUE,
  CONSTRAINT "UsageSample_bookingId_timestamp_key" UNIQUE ("bookingId","timestamp")
);
CREATE TABLE "Conversation" ("id" TEXT PRIMARY KEY,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "ConversationMember" (
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("conversationId","userId")
);
CREATE TABLE "Message" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "body" VARCHAR(4000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Review" (
  "id" TEXT PRIMARY KEY,
  "bookingId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_bookingId_reviewerId_key" UNIQUE ("bookingId","reviewerId")
);
CREATE TABLE "ForumTopic" (
  "id" TEXT PRIMARY KEY,
  "authorId" TEXT NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "body" VARCHAR(10000) NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ForumPost" (
  "id" TEXT PRIMARY KEY,
  "topicId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "body" VARCHAR(10000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "GpuListing_status_createdAt_idx" ON "GpuListing"("status","createdAt");
CREATE INDEX "Booking_listingId_startsAt_endsAt_idx" ON "Booking"("listingId","startsAt","endsAt");
CREATE INDEX "Heartbeat_machineId_receivedAt_idx" ON "Heartbeat"("machineId","receivedAt");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId","createdAt");

ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "GpuListing" ADD CONSTRAINT "GpuListing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id");
ALTER TABLE "GpuListing" ADD CONSTRAINT "GpuListing_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "GpuListing"("id");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE;
ALTER TABLE "Heartbeat" ADD CONSTRAINT "Heartbeat_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE;
ALTER TABLE "UsageSample" ADD CONSTRAINT "UsageSample_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE;
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE;
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id");
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id");
ALTER TABLE "ForumTopic" ADD CONSTRAINT "ForumTopic_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ForumTopic"("id") ON DELETE CASCADE;
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");

ALTER TABLE "Booking"
ADD CONSTRAINT "booking_no_overlap"
EXCLUDE USING gist (
  "listingId" WITH =,
  tsrange("startsAt", "endsAt", '[)') WITH &&
)
WHERE ("status" IN ('AWAITING_DEPOSIT','FUNDED','STARTING','ACTIVE'));
