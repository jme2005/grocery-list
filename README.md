# Grocery List (shared)

A tiny shared grocery list for two people, built as a Cloudflare Worker with a
D1 database. Johan and Krista both open the same link on their phones, add
items, tag them for H-E-B / Trader Joe's / Either, filter the view by store,
and tap to check things off in the aisle. The list re-syncs every 10 seconds
and whenever the page becomes visible, so both phones stay near-live.

## How access works

There are no accounts or logins. Every route — the page and the JSON API —
lives under a secret first path segment:

```
https://grocery-list.<your-subdomain>.workers.dev/{LIST_SECRET}/
```

Without the correct segment the Worker returns 404. Save that URL on both
phones (home-screen bookmark works well). Anyone with the link can view and
edit the list, so treat it like a password.

## Deploy

Requires `wrangler` and a connected Cloudflare account.

```bash
# 1. Create the D1 database
wrangler d1 create grocery-list-db

# 2. Put the returned database_id into wrangler.toml
#    (replace REPLACE_WITH_D1_DATABASE_ID)

# 3. Create the table
wrangler d1 execute grocery-list-db --file=schema.sql

# 4. Set the shared secret (long random string; this becomes the URL segment)
wrangler secret put LIST_SECRET

# 5. Deploy
wrangler deploy
```

After deploying, open `https://grocery-list.<your-subdomain>.workers.dev/<your-secret>/`
on both phones.

## API

All endpoints are under `/{LIST_SECRET}/api/items`:

- `GET /api/items` — list all items (unchecked first)
- `POST /api/items` — `{ "name": "...", "store": "heb" | "tjs" | "either" }`
- `PATCH /api/items/:id` — `{ "name"?, "store"?, "checked"? }`
- `DELETE /api/items/:id`
- `POST /api/items/clear-checked`

## Notes

- This repo contains no secrets. `LIST_SECRET` is set at deploy time via
  `wrangler secret put` and never committed.
- The repo is private; the Worker URL is unguessable only as long as the
  secret stays private.
