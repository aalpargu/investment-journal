# Investment Journal / Yatırım Defterim

A personal portfolio and transaction journal for BIST and US holdings. The transaction ledger drives positions and realized results; market quotes, charts and watchlists provide context around those records.

[Türkçe](README.tr.md)

This repository contains a public source copy of the cloud application. Deployment identifiers and the owner's account allowlist have been replaced with examples. A fresh copy needs its own authentication, database and service configuration.

## What is included

- A transaction ledger with editable purchases, sales, fees and IPO entries.
- Open/closed position views, grouped records, filters and CSV export.
- Quote/history adapters, cached results and explicit handling of missing or stale market data.
- A Telegram image workflow that uses Gemini to extract a proposed transaction for review before it is added.
- An offline transaction queue, validated state encoding and backup/restore checks.
- Cloud state, scheduled-backup helpers and health-monitoring scripts for the personal deployment.

The application keeps broker totals and number formatting explicit rather than silently treating a missing value as zero. External market data can be delayed or unavailable; provider responses are not a substitute for the transaction ledger.

## Source map

| Path | Purpose |
| --- | --- |
| `app/api/` | Authenticated routes for state, quotes, AI extraction and Telegram events. |
| `lib/` | Market adapters, transaction normalization, cloud storage and service logic. |
| `public/legacy/` | The portfolio interface and client-side calculation/storage modules. |
| `db/`, `drizzle/` | D1 schema and migrations. |
| `worker/` | Cloudflare request handling and authentication integration. |
| `tests/` | Market, calendar, transaction and data-recovery regressions. |
| `ops/` | Optional Windows backup and monitoring helpers. |

The stack combines React/TypeScript routes, a JavaScript portfolio interface, vinext/Vite, Cloudflare Workers, D1 and Drizzle. Gemini and Telegram are optional integrations.

## Run a development copy

Use Node.js 24; the package requires at least 22.13.

```bash
npm ci
npm run dev
```

For your own instance:

1. Replace the example owner addresses in `lib/access.ts` with the intended account allowlist.
2. Configure your Google OAuth client and application origin in `wrangler.jsonc`.
3. Create your own D1 database, set its binding and apply the migrations in `drizzle/`.
4. Supply the encryption key described in `.env.example` through your local/Worker environment. Keep Gemini and Telegram secrets in the application's protected server configuration.

The example UUID and OAuth client ID are placeholders. They do not connect to the owner's database. Backup and monitoring scripts are optional operations tools; running the application does not require installing scheduled tasks.

## Checks

```bash
npm run test:market-data
npm run test:calendar
npm run test:telegram
npm run test:storage
npm run lint
npm run build
```

Tests use controlled inputs for market parsing, transaction amounts, queue replay and state recovery. Live quotes, a real Telegram webhook and authentication against a newly configured deployment are separate integration checks.
