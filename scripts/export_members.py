from telethon import TelegramClient
import csv
import sys

if len(sys.argv) < 4:
    print("Usage: python export_members.py <api_id> <api_hash> <group_identifier>")
    print("group_identifier can be group username (without @) or invite link or group id")
    sys.exit(1)

api_id = int(sys.argv[1])
api_hash = sys.argv[2]
group = sys.argv[3]

client = TelegramClient('export_session', api_id, api_hash)

async def main():
    await client.start()
    try:
        participants = await client.get_participants(group, limit=None)
    except Exception as e:
        print("Error fetching participants:", e)
        return

    with open('group_members.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['id','username','first_name','last_name','phone'])
        for p in participants:
            writer.writerow([
                getattr(p, 'id', ''),
                getattr(p, 'username', '') or '',
                getattr(p, 'first_name', '') or '',
                getattr(p, 'last_name', '') or '',
                getattr(p, 'phone', '') or ''
            ])
    print("Wrote group_members.csv with", len(participants), "rows.")

with client:
    client.loop.run_until_complete(main())