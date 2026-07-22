-- Enforce domain invariants at the database boundary so every writer, not only
-- the HTTP API, is held to the same rules.
ALTER TABLE "GpuListing"
  ADD CONSTRAINT "GpuListing_hourlyLamports_positive" CHECK ("hourlyLamports" > 0);
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_period_valid" CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "Booking_amount_positive" CHECK ("quotedLamports" > 0),
  ADD CONSTRAINT "Booking_seconds_valid" CHECK ("expectedSeconds" > 0 AND "validSeconds" >= 0 AND "validSeconds" <= "expectedSeconds");
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amounts_nonnegative" CHECK (
    "grossLamports" >= 0 AND "payableLamports" >= 0 AND
    "platformLamports" >= 0 AND "providerLamports" >= 0 AND "refundLamports" >= 0
  );
ALTER TABLE "Review"
  ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- PostgreSQL does not automatically index foreign-key columns. These indexes
-- prevent table scans during joins and parent deletes as the marketplace grows.
CREATE INDEX "Machine_ownerId_idx" ON "Machine"("ownerId");
CREATE INDEX "GpuListing_machineId_idx" ON "GpuListing"("machineId");
CREATE INDEX "GpuListing_ownerId_idx" ON "GpuListing"("ownerId");
CREATE INDEX "Booking_buyerId_idx" ON "Booking"("buyerId");
CREATE INDEX "ConversationMember_userId_idx" ON "ConversationMember"("userId");
CREATE INDEX "Review_reviewerId_idx" ON "Review"("reviewerId");
CREATE INDEX "ForumTopic_authorId_idx" ON "ForumTopic"("authorId");
CREATE INDEX "ForumPost_authorId_idx" ON "ForumPost"("authorId");
