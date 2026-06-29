# Mentoryab Bot

A Telegram-based mentorship bot MVP built with Node.js, TypeScript, Prisma, and PostgreSQL.

## Features
- Telegram bot entry points for mentors and mentees
- User registration via Telegram profile
- Prisma-backed persistence for users and profiles
- Mentor matching for mentees
- Connection requests with accept/decline flow
- Mentor availability toggle for busy/offline states
- Basic health endpoint

## Setup
1. Copy `.env.example` to `.env` and fill in your values.
2. Create a PostgreSQL database and update `DATABASE_URL`.
3. Run `npx prisma migrate dev --name init`.
4. Start the bot with `npm run dev`.

## Commands
- `/start` to begin the experience
- `/mentor` to enter the mentor flow
- `/mentee` to enter the mentee flow
- `/match` to view recommended mentors
- `/request_<mentorId>` to request a mentor
- `/accept_<menteeId>` to accept a request
- `/decline_<menteeId>` to decline a request
- `/busy` to hide your profile from matches
- `/available` to show your profile again
