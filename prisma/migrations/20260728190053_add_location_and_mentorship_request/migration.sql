-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "MenteeProfile" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT;

-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN     "city" TEXT,
ADD COLUMN     "contactMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "country" TEXT;

-- Backfill contactMethods from the legacy single-value contactMethod column
UPDATE "MentorProfile"
SET "contactMethods" = ARRAY['Telegram ID: ' || "contactMethod"]
WHERE "contactMethod" IS NOT NULL;

-- AlterTable
ALTER TABLE "MentorProfile" DROP COLUMN "contactMethod";

-- CreateTable
CREATE TABLE "MentorshipRequest" (
    "id" SERIAL NOT NULL,
    "mentorProfileId" INTEGER NOT NULL,
    "menteeProfileId" INTEGER NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorshipRequest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MentorshipRequest" ADD CONSTRAINT "MentorshipRequest_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorshipRequest" ADD CONSTRAINT "MentorshipRequest_menteeProfileId_fkey" FOREIGN KEY ("menteeProfileId") REFERENCES "MenteeProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
