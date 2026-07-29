-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- DropForeignKey
ALTER TABLE "MentorshipRequest" DROP CONSTRAINT "MentorshipRequest_menteeProfileId_fkey";

-- DropForeignKey
ALTER TABLE "MentorshipRequest" DROP CONSTRAINT "MentorshipRequest_mentorProfileId_fkey";

-- CreateTable
CREATE TABLE "ProfileAuditLog" (
    "id" SERIAL NOT NULL,
    "telegramId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileAuditLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MentorshipRequest" ADD CONSTRAINT "MentorshipRequest_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorshipRequest" ADD CONSTRAINT "MentorshipRequest_menteeProfileId_fkey" FOREIGN KEY ("menteeProfileId") REFERENCES "MenteeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
