-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN     "busyUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MentorSearchRequest" (
    "id" SERIAL NOT NULL,
    "menteeProfileId" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedByTelegramId" TEXT,
    "lastPostedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorSearchRequest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MentorSearchRequest" ADD CONSTRAINT "MentorSearchRequest_menteeProfileId_fkey" FOREIGN KEY ("menteeProfileId") REFERENCES "MenteeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
