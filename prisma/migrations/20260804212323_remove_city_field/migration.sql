/*
  Warnings:

  - You are about to drop the column `city` on the `MenteeProfile` table. All the data in the column will be lost.
  - You are about to drop the column `city` on the `MentorProfile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MenteeProfile" DROP COLUMN "city";

-- AlterTable
ALTER TABLE "MentorProfile" DROP COLUMN "city";
