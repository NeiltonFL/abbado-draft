# Abbado Draft API

Document automation platform API. Express + TypeScript + Prisma + Supabase.

## Setup

```bash
npm install
cp .env.example .env
# Fill in Supabase credentials in .env
npx prisma db push
npx tsx prisma/seed.ts
npm run dev
```

## Endpoints

- `GET /health` — Health check
- `POST /api/auth/register` — Create organization + first admin
- `GET/POST /api/templates` — Template management
- `GET/POST /api/workflows` — Workflow management  
- `GET/POST /api/matters` — Matter lifecycle
- `PATCH /api/matters/:id/variables` — Update variables (triggers regeneration)
- `POST /api/matters/:id/generate` — Generate documents
- `POST /api/matters/:id/regenerate` — Regenerate with edit journal replay
- `GET/POST /api/matters/:id/documents/:docId/journal` — Edit journal
- `GET/POST /api/admin/*` — User, adapter, API key, webhook, audit management

## Deployment

Deployed to Railway via Nixpacks. Auto-deploys on push to main.

- Port: 8080 (set in Railway Networking settings, NOT as env var)
- Build: `npm install && npx prisma generate`
- Start: `npx tsx src/index.ts`
