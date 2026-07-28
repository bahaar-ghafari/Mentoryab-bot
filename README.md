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

## Production deployment

This repo includes a production compose file at `docker-compose.prod.yml` and a GitHub Actions workflow at `.github/workflows/deploy.yml`.

Required GitHub repository secrets:
- `SSH_HOST` — your VPS IP or hostname
- `SSH_USER` — SSH user name
- `SSH_PRIVATE_KEY` — private key for SSH login
- `SSH_PORT` — SSH port (optional, defaults to 22)
- `APP_DIR` — application directory on the VPS where the repo is checked out
- `GHCR_USERNAME` — GitHub Container Registry username
- `GHCR_TOKEN` — token for GHCR pull access

Deploy workflow behavior:
1. Build and push the Docker image to `ghcr.io/bahaar-ghafari/mentoryab-bot`
2. SSH into the VPS
3. Pull latest repo changes
4. Pull the updated bot image
5. Restart only the `bot` service via `docker compose -f docker-compose.prod.yml`
