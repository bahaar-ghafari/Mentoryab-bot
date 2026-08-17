-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN "frameworks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
