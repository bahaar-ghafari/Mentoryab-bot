-- AlterTable
ALTER TABLE "MentorshipRequest" ADD COLUMN     "feedbackRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MentorFeedback" (
    "id" SERIAL NOT NULL,
    "mentorshipRequestId" INTEGER NOT NULL,
    "mentorProfileId" INTEGER NOT NULL,
    "menteeProfileId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "mentorApproved" BOOLEAN,
    "adminApproved" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MentorFeedback_mentorshipRequestId_key" ON "MentorFeedback"("mentorshipRequestId");

-- AddForeignKey
ALTER TABLE "MentorFeedback" ADD CONSTRAINT "MentorFeedback_mentorshipRequestId_fkey" FOREIGN KEY ("mentorshipRequestId") REFERENCES "MentorshipRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorFeedback" ADD CONSTRAINT "MentorFeedback_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorFeedback" ADD CONSTRAINT "MentorFeedback_menteeProfileId_fkey" FOREIGN KEY ("menteeProfileId") REFERENCES "MenteeProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
