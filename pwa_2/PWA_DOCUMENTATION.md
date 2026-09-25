# Crypto Portfolio PWA — Technical Documentation & Agentic Handoff

**Audience:** a future AI agent or developer who must understand, run, modify, or extend this app
without prior context. Read this top-to-bottom before editing. It documents architecture, the
cost engine, external APIs, data flow, every feature, the file map, how to deploy, how to extend
safely, and the invariants/gotchas that are expensive to rediscover.

**One-line summary:** a static, offline-capable Progressive Web App that shows a crypto
portfolio's effective cost, current value, and P/L. It ships with a reconciled data snapshot,
can recompute from CSV exports in-browser (strict-FIFO engine ported to JS), fetches live prices,
and installs to iPhone/macOS home screen. **No backend, no accounts, no secrets.**

---

## 1. Architecture at a glance

- **Pure static site**: HTML + CSS + vanilla JS. No build step, no framework, no bundler.
  You can open it from any static host; there is nothing to compile.
- **Single external runtime dependency**: Chart.js (self-hosted as `chart.umd.min.js`, not a CDN).
- **Data model**: computed portfolio state lives in memory + `localStorage`. Two data sources:
  1. `data.json` — a bundled, reconciled snapshot (default; app works instantly offline).
  2. User-imported CSVs (Balances/Ledger/Trades) → recomputed in-browser by `engine.js`.
- **Live data**: prices from CoinGecko, FX (EUR→PLN) from frankfurter.dev. Read-only, no keys.
- **Offline**: a service worker (`sw.js`) caches the app shell; API calls always hit network
  (never cached) and fall back to cached prices when offline.

### Runtime flow
```
index.html loads → engine.js (defines window.PortfolioEngine) → app.js (IIFE)
app.js init():
  loadPrefs() → restore text-scale/density/alerts
  wire() → attach all event listeners
  load data: localStorage "user_data" if present, else fetch ./data.json
  loadCachedPrices() from localStorage
  render() → paints Summary + Cards + Tables from data + (cached) prices
  refresh(true) → fetch live prices+FX, re-render, start 15s auto-refresh
  loadChart(true) → warm 365-day history cache in background
  register service worker
```

---

## 2. File map

| File | Purpose | ~LOC |
|---|---|---|
| `index.html` | App shell: header, 5 views (Summary/Cards/Tables/Chart/Settings), bottom nav, detail sheet, onboarding. Contains the **CSP meta tag**. | 213 |
| `app.js` | All UI logic: rendering, state, live data, chart, detail sheet, all features. IIFE, no exports. | 705 |
| `engine.js` | **Strict-FIFO cost engine** ported from Python. `window.PortfolioEngine.analyze(balCSV, ledCSV, trdCSV)`. | 165 |
| `styles.css` | All styling. Dark/light via `prefers-color-scheme`. rem-based type scale. | 310 |
| `sw.js` | Service worker. `CACHE` version string must be bumped on every shell change. | 29 |
| `data.json` | Bundled reconciled snapshot: `{assets:[...], meta:{...}, warnings:[...], generated}`. | — |
| `manifest.webmanifest` | PWA manifest (name, icons, standalone display, theme color). | — |
| `chart.umd.min.js` | Chart.js v4.4.1, self-hosted (no CDN, for CSP + offline). | — |
| `icon.svg` + `icons/*.png` | App icon (indigo→violet gradient, rising line chart) at 96–1024px. | — |
| `sample_csv/*.csv` | Example Balances/Ledger/Trades CSVs showing expected columns. | — |
| `README.md` | User-facing setup, deploy, security notes. | — |

---

## 3. The cost engine (`engine.js`)

This is a faithful JavaScript port of the validated Python engine. **It must stay behavior-identical.**

### 3.1 Method (strict chronological FIFO, EUR cost basis)
- **Quantity = ground truth** from the Balances file `quantity` column (already includes external/gift coins).
- **Units credited/debited per ledger row = `amount − fee`** (proven: ledger running balance == cumulative(amount−fee)). Applies to trades AND rewards.
- **Cost basis** built by a single time-ordered FIFO lot queue per base asset:
  - trade buy (amount>0, non-EUR): lot(units=amount−fee, unit_cost = matching Trades `cost+fee` / units)
  - trade sell (amount<0, non-EUR): consume oldest lots; realized += proceeds − cost_removed
  - crypto/crypto (X/BTC): BTC quote-leg transfers its removed FIFO basis into the bought asset (no realized P/L)
  - staking/earn reward, deposit (gift): **zero-cost** lots
  - withdrawal (non-EUR): units leave exchange but are STILL HELD externally → consume lots, retain cost as external
  - internal transfers/allocations/migrations: ignored
- **Derived external/gift residual**: `residual = Balances_qty − reconstructed`; if non-trivial it is treated as **zero-cost** and emitted as a `warning`. (This is how BTC's ~0.0216 gift is handled — NOT hardcoded.)
- **Deployed vs total**: `deployed_units` = surviving cost-bearing lots + withdrawn-but-held; `zero_cost_units` = surviving zero-cost lots + residual. `deployed + zero == quantity`.

### 3.2 Asset normalization (wrappers/rebrands)
`baseAsset()` folds: ETH2/ETH2.S→ETH, BTC.M→BTC, MATIC*/→POL, RNDR→RENDER, and any `.S`/`.Snn`
staking suffix → base. Keep this in sync if new wrappers appear.

### 3.3 CSV parsing & column mapping
- `parseCSV()` handles quoted fields, embedded commas/newlines.
- Columns matched **by header name** (normalized, case/punctuation-insensitive), not position — so
  reordered/extra columns are fine. Required headers:
  - Balances: `asset, wallet, quantity`
  - Ledger: `time, type, asset, amount, fee` (subtype optional)
  - Trades: `pair, time, type, cost, fee, vol`
- Throws a clear error naming the missing column if a required header is absent.

### 3.4 Output contract (`analyze` returns / `data.json` shape)
```
{ assets: [ { asset, cg_id, quantity, cost_basis, deployed_units, zero_cost_units, realized } ],
  meta:   { total_deposited, total_withdrawn, net_deposited, eur_remaining, total_realized },
  warnings: [ { asset, quantity, reconstructed, residual_zero_cost } ],
  generated: "YYYY-MM-DD" }
```
All money in `meta`/`cost_basis`/`realized` is **EUR**.

### 3.5 Regression checkpoints (assert after ANY engine change)
| Metric | Expected (bundled snapshot) |
|---|---|
| Total cost basis | €4,354.14 |
| Net deposited | €3,553.24 |
| Total realized | €978.24 |
| ETH cost basis | €675.29 |
| BTC zero-cost residual | 0.02161835 |
Node check: `node -e 'const {analyze}=require("./engine.js");const fs=require("fs");const r=analyze(fs.readFileSync("sample_csv/Balances.csv","utf8"),fs.readFileSync("sample_csv/Ledger.csv","utf8"),fs.readFileSync("sample_csv/Trades.csv","utf8"));console.log(r.assets.reduce((s,a)=>s+a.cost_basis,0).toFixed(2))'`

---

## 4. External APIs

| Use | Endpoint | Notes |
|---|---|---|
| Live prices (EUR) | `https://api.coingecko.com/api/v3/simple/price?ids=<cg_ids>&vs_currencies=eur` | one call, all assets; `cg_id` per asset |
| FX EUR→PLN | `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=PLN` | ECB data, no key; **note: `.dev` not `.app`** (`.app` 301-redirects) |
| FX fallback | CoinGecko bitcoin priced in eur+pln → ratio | used if frankfurter fails |
| 365-day history | `https://api.coingecko.com/api/v3/coins/<cg_id>/market_chart?vs_currency=eur&days=365&interval=daily` | one call per asset, throttled 300ms; cached per-day in localStorage |

CoinGecko free tier is rate-limited; the 15s price refresh is a single batched call (fine). History
is fetched once/day and cached. **If you add assets, ensure each has a valid `cg_id`** (see §6).

---

## 5. State & rendering (`app.js`)

- Single `state` object holds: data, prices, priceTs, fx, ccy (EUR/PLN), view (1=All Holdings /
  3=Invested Only), tableOpt, sort, density, alerts, hist (365d cache), prevPrices (for flash).
- Key render functions: `renderSummaryTab()`, `renderCards()`, `renderTable()`, `drawChart()`,
  `renderAllocDonut()`, `openDetail(sym)`. `render()` calls the first three.
- `computeRows(view)` / `computeForView(view)` are the core value/P&L calculators. **Cost basis is
  identical across views**; only quantity (deployed vs total) changes → value/P&L differ.
- Formatting helpers: `fmtMoney` (totals, 2dp), `fmtMoneyCompact` (€7.2K/1.3M for cards),
  **`fmtPrice`** (magnitude-aware per-unit prices — sub-cent coins like PEPE show
  €0.00000411 instead of €0.00; used for avg cost, live price, break-even, card price line),
  `fmtQty`, `pct`, `esc` (HTML-escape — **always use for any untrusted string in innerHTML**),
  `rate()` (current FX).
- Colors: `ratioColor(value/cost)` heatmap; `plColorOf(unreal)` green/red; arrows via `arrowOf`.

### Feature → code location
| Feature | Where |
|---|---|
| Currency toggle EUR/PLN | `#ccyToggle` handler; `rate()`/`fmtMoney`/`fmtPrice` |
| All Holdings / Invested Only | `state.view`; `setView()`; `computeRows` |
| Cards + heatmap colors | `renderCards()` |
| Per-unit price on card face | `.px` line in `renderCards()` (hidden in compact density) |
| Detail sheet (tap asset) | `openDetail()`; swipe-dismiss handlers in `wire()` |
| Break-even price + %-to-BE | `breakEvenPrice()`, in `openDetail()` |
| Price alerts (per asset) | `state.alerts`, `saveAlerts()`, badge in `renderCards()`, setter in `openDetail()` |
| Sortable table | `SORTS`, `#mainTable thead` click handler |
| Search (cards + tables) | `state.cardQuery`/`tableQuery` |
| Card sort dropdown | `#cardSort` → `state.cardSort` |
| Density toggle | `state.density`, `#densityBtn`, `.cards.compact` |
| Summary donut | `renderAllocDonut()` |
| Lifetime P/L + free-coins% | `lifetimePL()`, `freeCoinsShare()`, `#heroLifetime` |
| 365-day chart + cost line | `drawChart()` (cache-first in `loadChart()`) |
| Chart stats (best/worst/DD/vol) | end of `drawChart()` |
| Price-move flash | `state.prevPrices`, `.flash-up/.flash-down` |
| CSV export (formula-injection-safe) | `exportCSV()` |
| Share summary | `shareSnapshot()` (Web Share + clipboard fallback + `toast()`) |
| Pull-to-refresh | touch handlers in `wire()`; `#ptr` |
| 15s auto-refresh | `startAuto()`/`refresh()` |
| Freshness "updated Ns ago" | `relTime()`, `updateFreshness()` |
| Dynamic Type (text size) | `--type-scale`, `#textSize`; rem-based CSS |
| Onboarding | `#onboard`, first-run localStorage flag |
| Reduced motion | `REDUCE_MOTION`, `prefers-reduced-motion` CSS |

---

## 6. Security posture (must preserve)

- **CSP** (meta tag in `index.html`): `default-src 'self'`; `script-src 'self'` (no inline scripts,
  no eval); `connect-src` limited to `'self'`, `api.coingecko.com`, `api.frankfurter.dev`.
  **If you add an API, add its host to `connect-src` or the fetch will be blocked.**
- **No inline event handlers** (`onclick=` etc.) — they violate the CSP. Wire everything in JS.
- **XSS**: all untrusted strings (asset symbols from CSV/API, donut legend labels) pass through
  `esc()` before `innerHTML`. Chart.js tooltip `label` callbacks render to `<canvas>` (not DOM, safe).
  Detail title uses `.textContent`; toast uses `.textContent`; alert `<input>` is read via
  `parseFloat` (coerced to number, never re-inserted as HTML).
- **CSV export hardening**: `exportCSV()` quotes every cell, escapes embedded quotes, and prefixes a
  leading apostrophe to any value starting with `= + - @ TAB CR` to defuse spreadsheet
  **formula injection**. Preserve this if you change the exporter.
- **No secrets, no auth, no PII.** Only coin IDs leave the device (in price query strings).
- **localStorage** holds non-sensitive data (holdings quantities, cached prices, prefs, alerts).
- Chart.js is **self-hosted** (no third-party script origin).
- After any change touching innerHTML/fetch/CSP/export, re-run the security checks in §8.

### Security scorecard (last audit — all PASS)
| Check | Result |
|---|---|
| JS compiles (app + engine) | PASS |
| Inline event handlers | 0 |
| `eval` / `new Function` / string timers | 0 |
| Unescaped untrusted data → DOM innerHTML | 0 (chart-canvas tooltip labels excluded — safe) |
| CSV formula-injection guard | present |
| CSP `connect-src` = exactly the 2 APIs used | yes |

---

## 7. Deploy & install

### Deploy (GitHub Pages — recommended)
1. Push the contents of `pwa/` to a repo (root or `/docs`).
2. Settings → Pages → source = branch, folder = `/ (root)` or `/docs`.
3. Open the HTTPS URL (PWAs require HTTPS; `file://` won't register the SW).

### Install
- **iPhone (Safari):** open URL → Share → **Add to Home Screen**.
- **macOS (Safari 17+):** open URL → File → **Add to Dock**. (Replaces the old Python `.app`.)
- **Chrome/Edge:** address-bar **Install** button.

### Local dev
`cd pwa && python3 -m http.server 8000` → open `http://localhost:8000`.
(SW + install need HTTPS or localhost; localhost is treated as secure.)

**After any shell file change, bump `CACHE` in `sw.js`** (e.g. `portfolio-v9` → `v10`) so clients update.

---

## 8. Verification checklist (run before shipping changes)
```
cd pwa
node -c app.js && node -c engine.js                 # JS syntax
# engine regression (see §3.5) → expect 4354.14
grep -o "connect-src[^;]*" index.html               # CSP hosts unchanged?
grep -cE "on(click|error|load|input|change)=" index.html app.js   # must be 0 (CSP)
grep -cE "\beval\(|new Function" app.js engine.js    # must be 0
grep -c "formula-injection" app.js                   # CSV guard present (expect 1)
python3 -m http.server 8080                          # then curl each asset → 200
```
Also exercise, in a browser: import CSV → each tab renders (Summary/Cards/Tables/Chart) with no
console error; currency toggle; tap-to-detail; sort; search; set an alert; export CSV opens cleanly
in a spreadsheet with no formula execution. **Bump `sw.js` CACHE** after any shell change.

---

## 9. How to extend safely (common tasks)

- **Add/replace holdings**: regenerate `data.json` from the Python engine, OR import fresh CSVs in
  the app (Settings → Recompute). Keep the output contract in §3.4.
- **Add a new asset/coin**: ensure it has a `cg_id` matching CoinGecko's coin id. If unknown, the
  app falls back to `asset.toLowerCase()` which often won't price → the coin shows "no price".
  Add correct ids to `CG_ID_OVERRIDES` in `engine.js` (and the Python `cg_id_overrides`).
- **Add a currency**: extend `state.fx`, `fmtMoney`, the `#ccyToggle`, and an FX source (+ CSP host).
- **Add an API/host**: add to CSP `connect-src` AND the SW bypass list in `sw.js`.
- **Change the engine**: mirror the Python change, keep §3.5 checkpoints, re-run the Node test.
- **New UI that renders untrusted data**: wrap strings in `esc()`; never inline event handlers.

---

## 10. Known limitations / gotchas (do not rediscover the hard way)

- **`.numbers` files can't be parsed in-browser** — CSV only. (The Python tool handles `.numbers`.)
- **365-day chart is an approximation**: current holdings valued at historical daily prices, NOT
  point-in-time holdings. Labeled as such in the UI. Don't present it as exact history.
- **True iOS Dynamic Type slider is unreadable by web** — the app approximates via rem + browser
  text-size + an in-app A/A+/A++ control. This is intentional.
- **iOS PWAs cannot send push notifications** — price alerts are in-app visual badges only.
- **iOS PWA storage** is limited (~50MB) and can be evicted after ~7 days unused. Data is small
  and re-importable; don't treat the PWA as the only copy of source data.
- **frankfurter endpoint is `.dev` not `.app`** (`.app` 301-redirects; the redirect target isn't
  in CSP so it would fail). Keep `.dev`.
- **Chart.js global**: loaded with `defer`; `loadChart`/`drawSparkline` guard on `window.Chart`
  and retry — don't remove those guards.
- **Cost basis is the same in both views by design** — if you ever see it differ, that's a bug.
- **Per-unit prices need `fmtPrice`, not `fmtMoney`** — sub-cent coins (e.g. PEPE ~€0.0000041)
  render as €0.00 with the 2-decimal `fmtMoney`. Use `fmtPrice` (magnitude-aware) for any per-unit
  price/avg-cost/break-even value. Totals & P/L keep `fmtMoney`.
- **CSV export must stay formula-injection-safe** — keep the `cell()` sanitizer (quotes + leading-
  apostrophe on `= + - @`). Don't revert to raw `join(",")`.

---

## 11. Relationship to the desktop Python tool

The Python engine (in the broader project) is the source of truth for the rigorous accounting and
generated `data.json`. The PWA re-implements the same FIFO logic in JS for in-browser recompute.
If the two ever diverge, the Python engine + its regression numbers win; re-sync `engine.js` to it.

**This is an analysis/accounting tool — not tax or investment advice.**
