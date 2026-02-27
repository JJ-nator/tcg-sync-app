# 🎴 TCG Colombia Sync Dashboard

Real-time Pokemon TCG price sync from tcgcsv.com to WooCommerce.

## Features

- ⚡ One-click sync button
- 📊 Real-time progress bar
- 📜 Live log streaming
- 📈 Stats: created/updated counts

## Deployment (Render)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create tcg-sync-app --private --source=. --push
```

### 2. Deploy on Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. New → Web Service
3. Connect your `tcg-sync-app` repo
4. Add environment variables:
   - `WC_URL` = `https://tcgcolombia.com`
   - `WC_KEY` = your WooCommerce consumer key
   - `WC_SECRET` = your WooCommerce consumer secret
   - `CATEGORY_SINGLES_ID` = `49` (or your singles category ID)

### 3. Use

Visit your Render URL and click **Start Sync**!

## Local Development

```bash
# Set env vars
export WC_URL=https://tcgcolombia.com
export WC_KEY=ck_xxx
export WC_SECRET=cs_xxx

# Run
npm start
```

Open http://localhost:3000

## How It Works

1. Downloads all Pokemon card CSVs from tcgcsv.com (in-memory, no storage)
2. Fetches current TRM exchange rate
3. Fetches existing WooCommerce products
4. Creates new products / updates prices in batches of 100
5. Streams progress via Server-Sent Events (SSE)

## Tech Stack

- Express.js
- WooCommerce REST API
- SSE for real-time updates
- Vanilla JS frontend (no build step)
