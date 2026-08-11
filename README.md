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
1. Copy `.env.example` to `.env`, fill in the production values, and keep this file private.
2. Deploy with the production compose file:
   ```bash
docker compose -f docker-compose.prod.yml up -d
```
3. The bot image runs `npx prisma migrate deploy` before startup, so migrations are applied automatically.

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

## Database access

Production is the single source of truth. There is no separate staging database — all reads, writes, and imports should target the production Postgres instance, not a local Docker copy.

The `postgres` container on the VPS does not publish a port to the host, so external tools (DBeaver, `psql`, scripts) need an SSH tunnel:

```bash
# find the container's internal IP first, since it can change on container recreation:
ssh root@<VPS_HOST> "docker inspect <compose-project>-postgres-1 --format '{{.NetworkSettings.Networks}}'"

# then tunnel a local port to that IP on the VPS:
ssh -L 5433:<container_ip>:5432 root@<VPS_HOST>
```

With the tunnel open, point any client (or `DATABASE_URL`) at `localhost:5433`, using the `POSTGRES_USER`/`POSTGRES_PASSWORD` from the VPS's `.env` (never committed — see `/opt/mentoryab-bot/.env` on the server).

## Group member import

To backfill Telegram group members as mentee users in the database:

1. Export the group's member list with `scripts/export_members.py` (requires `telethon`; needs a Telegram API id/hash and creates a local session file — never commit `*.session` files, they're live login credentials):
   ```bash
   python scripts/export_members.py <api_id> <api_hash> <group_identifier>
   ```
   This writes `group_members.csv` (gitignored — contains real names/usernames/phone numbers).
2. Import it into the database with `scripts/import_group_members.ts`:
   ```bash
   DATABASE_URL=<prod connection string, see "Database access" above> npm run import:group_members
   ```
3. Delete `group_members.csv` and the `.session` file locally once the import succeeds — per the policy above, this data should only live in the production database.
