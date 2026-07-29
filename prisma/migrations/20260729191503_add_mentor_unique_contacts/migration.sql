-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN     "telegramContact" TEXT,
ADD COLUMN     "phoneContact" TEXT,
ADD COLUMN     "emailContact" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_telegramContact_key" ON "MentorProfile"("telegramContact");

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_phoneContact_key" ON "MentorProfile"("phoneContact");

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_emailContact_key" ON "MentorProfile"("emailContact");
