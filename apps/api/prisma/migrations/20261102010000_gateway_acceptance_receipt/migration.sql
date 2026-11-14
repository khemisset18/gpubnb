CREATE TABLE "WorkspaceGatewayAcceptance" (
    "id" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "channelId" UUID NOT NULL,
    "bindingSha256" CHAR(64) NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceGatewayAcceptance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceGatewayAcceptance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkspaceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceGatewayAcceptance_sessionId_key" ON "WorkspaceGatewayAcceptance"("sessionId");
ALTER TABLE "WorkspaceGatewayAcceptance" ENABLE ROW LEVEL SECURITY;
