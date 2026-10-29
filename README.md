# Investment Journal / Yatırım Defterim

A portfolio and transaction journal I built to keep investment records, expenses and decisions in one place. It covers BIST and US holdings, with the transaction ledger as the source of truth for positions and realized results.

[Try the sample portfolio](https://investment-journal-demo-alpargu.flowydream.chatgpt.site) · [Türkçe](README.tr.md)

The hosted sample uses invented transactions in a separate database. Sign in with ChatGPT to get your own copy; you can add, edit and delete records without changing anyone else's portfolio. No local installation is needed. **AI image reading and Telegram are not connected in the sample deployment yet.** The screens include a short notice.

## What the app does

- Records purchases, sales, fees, cash movements and IPO entries; calculates open and closed positions from those records.
- Fetches prices and history, shows stale or missing quotes explicitly, and supports watchlists and technical views.
- Tracks expenses, an investment budget, calendar events, stock theses and journal notes.
- Imports transaction data and exports backups; keeps a revision history and queues transaction changes when a connection drops.
- Includes Gemini image extraction and Telegram transaction-review code. Extracted transactions require confirmation before entering the ledger; the public sample does not currently configure those services.

Market data can be delayed or unavailable. Example entry prices and balances are invented for demonstration.

## How it is organized

The portfolio UI is a JavaScript application embedded by a React/TypeScript page. API routes run on Cloudflare Workers through vinext/Vite. Drizzle migrations define D1 tables, including revisioned portfolio state and normalized collections.

| Path | Purpose |
| --- | --- |
| `public/release-v14.17/` | Active portfolio interface, calculations, imports and offline queue. |
| `app/api/` | State, quote/history, calendar and integration endpoints. |
| `lib/cloud-store.ts` | Revision handling and normalized portfolio persistence. |
| `lib/request-user.ts` | Sites identity boundary for each account. |
| `lib/demo-state.ts` | Invented initial portfolio; no personal data dependency. |
| `db/`, `drizzle/` | D1 schema and migrations. |
| `tests/` | Calculation, provider parsing, storage and isolation regressions. |

The sample inserts initial records only when an account has no saved state. All later reads and writes use the signed-in Sites user ID. Browser storage has a matching account prefix. The source does not contain the personal portfolio database, backups or service keys.

## Run locally

Use Node.js 24:

```sh
npm ci
npm run build
```

Apply each pending SQL migration in `drizzle/` in order to the local database. For example:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_gray_giant_girl.sql
```

Then run `npm run dev` and open its printed URL. Local sign-in uses the Sites preview identity. `npm start` serves the built Worker; it does not simulate sign-in. A hosted fork needs its own Sites registration and D1 resources. The public source intentionally omits the original Site ID.

## Checks

```sh
node --experimental-strip-types --test tests/demo-isolation.test.mjs
npm run test:market-data
npm run test:calendar
npm run test:telegram
npm run test:storage
npm run build
```

For a disposable built Worker on `127.0.0.1:8787`, `node tests/demo-http.test.mjs` checks separate visitors, saved edits, revision conflicts and rejected cross-origin writes. It refuses non-loopback URLs.

On 29 October 2026, these checks, TypeScript and the production build passed. A local HTTP check also returned BIST and US quotes. Automated checks do not replace a full visual/device pass; that pass is still outstanding for the sample deployment. Live Gemini and Telegram were not tested because their sample connections are deferred.
