# Crypto Portfolio PWA

An installable, offline-capable Progressive Web App that shows your crypto portfolio's
effective cost, current value and P/L — with live prices, EUR/PLN toggle, cards + tables,
a 365-day value chart, and 15-second auto-refresh. All computation runs **on your device**.

## Features
- **Cards view** — one card per asset, colour-coded by value ÷ cost (green above cost, red below,
  graded heatmap like tickers). Currency toggle € EUR / zł PLN (live FX).
- **Tables view** — Option 3 (Deployed Capital) and Option 1 (Total Net Worth) with cost basis,
  value, unrealised P/L, return %, plus an EUR-flows summary.
- **Chart view** — 365-day portfolio value vs cost basis (approx: current holdings × historical
  daily prices), with 365-day change / high / low.
- **Auto-refresh** every 15s + manual refresh button.
- **Data**: ships with a bundled reconciled snapshot (works instantly). You can also import fresh
  **CSV** exports (Balances / Ledger / Trades) in Settings to recompute locally — the full
  strict-FIFO engine is ported to JavaScript and runs in the browser.

## Deploy on GitHub Pages (recommended)
1. Create a GitHub repo and push the contents of this `pwa/` folder to it
   (either the repo root, or a `/docs` folder).
2. Repo **Settings → Pages** → Source: `main` branch, folder `/ (root)` (or `/docs`).
   Wait for the green "your site is published at https://<user>.github.io/<repo>/".
3. That URL is HTTPS — required for PWAs. Open it.

### Install on iPhone (Safari)
- Open the Pages URL in **Safari** → **Share** → **Add to Home Screen**.
- Launch from the new icon: it runs full-screen, works offline, and keeps your imported data.
- Note (iOS): installed PWAs get limited storage and unused data can be evicted after ~7 days.
  Your data is small and re-importable, so keep your CSV exports as the source of truth.

## Files
- `index.html`, `styles.css`, `app.js` — UI (bottom nav, cards, tables, chart, settings)
- `engine.js` — strict-FIFO cost engine (JS port; verified to match the reference to the cent)
- `data.json` — bundled reconciled snapshot (default data)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA install + offline
- `sample_csv/` — example CSV exports showing the expected columns

## Data / method notes
- Quantity from Balances is ground truth; strict-FIFO builds EUR cost basis; staking rewards,
  gifts and airdrops are zero-cost and dilute the average. BTC external/gift is derived as the
  reconciliation residual (treated zero-cost). Option 3 = capital you deployed; Option 1 = total.
- Prices: CoinGecko (EUR). FX: frankfurter.dev (ECB) with a CoinGecko fallback.
- The 365-day chart is an approximation (uses current holdings across history, not point-in-time).

**Analysis/accounting tool — not tax or investment advice.**

## Security posture
This is a static, client-side app with **no backend, no accounts, no secrets/API keys, and no PII**.
All computation runs on your device; the only outbound calls are read-only price/FX lookups.

Hardening applied before deployment:
- **Content-Security-Policy** (meta tag): `default-src 'self'`; scripts only from self (no inline
  scripts, no eval); network limited to `api.coingecko.com` and `api.frankfurter.dev` only.
- **Output escaping**: all untrusted strings (CSV `asset` symbols, API fields) are HTML-escaped
  before rendering, preventing DOM-XSS from a crafted CSV.
- **No CDN**: Chart.js is self-hosted (no third-party script trust; fully offline).
- **URL encoding**: asset IDs are `encodeURIComponent`-ed into API URLs.
- **Service worker** caches only the app shell and never caches API responses.

What leaves your device: the list of CoinGecko coin IDs you hold (in the price query string) and
a currency-pair request for EUR/PLN. Your quantities, cost basis and P/L never leave the browser.

Notes / residual considerations:
- Data (holdings + last prices) is stored in the browser's `localStorage`/cache — not sensitive,
  but anyone with access to the unlocked device could open the app. Don't add secrets to it.
- GitHub Pages can't set HTTP security headers; the CSP is delivered via the meta tag. If you later
  host somewhere that supports headers, also send CSP, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and HSTS as HTTP headers.
- Third-party APIs (CoinGecko, Frankfurter) are trusted for price data only; responses are treated
  as untrusted input (escaped, numeric-parsed).
