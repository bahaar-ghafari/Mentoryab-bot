-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN     "approved" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather in every mentor that already existed before the approval
-- workflow shipped — only newly-created mentors should start pending.
UPDATE "MentorProfile" SET "approved" = true;
