"use strict";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";
const LS_KEY = "portfolio_report_v1";
const FX_KEY = "portfolio_fx_v1";
const CCY_KEY = "portfolio_ccy_v1";
const AUTO_MS = 60000;

const $ = (id) => document.getElementById(id);
const ids = Object.prototype.hasOwnProperty;

const state = { data: null, live: {}, liveTs: null, fx: null, refreshing: false };

let ccy = "eur";
try { ccy = localStorage.getItem(CCY_KEY) === "usd" ? "usd" : "eur"; } catch (e) { /* ignore */ }
try { const f = parseFloat(localStorage.getItem(FX_KEY)); if (isFinite(f) && f > 0) state.fx = f; } catch (e) { /* ignore */ }

/* ---------- formatting (mirrors portfolio_tool.py) ---------- */
const NF = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const s2   = NF(2, 2);
const s8   = NF(0, 8);
const s6   = NF(6, 6);
const s4   = NF(4, 4);
const s1s  = new Intl.NumberFormat("en-US", { signDisplay: "always", maximumFractionDigits: 1 });

function s(x)   { return (x === null || x === undefined || !isFinite(x)) ? "n/a" : s2.format(x); }
function qfmt(x) { if (x === null || x === undefined || !isFinite(x)) return "0";
  const st = s8.format(x);
  return (st.indexOf(".") >= 0 ? st.replace(/\.?0+$/, "") : st) || "0"; }
function pfmt(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  if (x === 0) return "0";
  if (x < 0.01) { const st = NF(0, 8).format(x).replace(/\.?0+$/, ""); return st || "0"; }
  if (x < 1) return s6.format(x);
  return s4.format(x);
}
function rfmt(x) { return (x === null || x === undefined || !isFinite(x)) ? "n/a" : s1s.format(x) + "%"; }
function money(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  const usd = ccy === "usd" && state.fx;
  return s(x * (usd ? state.fx : 1)) + (usd ? " $" : " \u20AC");
}
function costUnit(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  const usd = ccy === "usd" && state.fx;
  const v = x * (usd ? state.fx : 1);
  const st = (Math.abs(v) < 0.01 ? NF(0, 8) : NF(0, 4)).format(v);
  const t = st.indexOf(".") >= 0 ? st.replace(/\.?0+$/, "") : st;
  return (t || "0") + (usd ? " $" : " \u20AC");
}
const CCY_SYM = () => (ccy === "usd" && state.fx ? "$" : "\u20AC");

/* ---------- data ---------- */
function priceFor(asset, cur) {
  const c = cur || "eur";
  const lv = (state.liveTs && ids.call(state.live, asset)) ? state.live[asset] : null;
  if (lv) {
    if (lv[c] !== undefined && lv[c] !== null) return lv[c];
    if (c === "usd" && lv.eur !== undefined && lv.eur !== null && state.fx) return lv.eur * state.fx;
    if (c === "eur" && lv.usd !== undefined && lv.usd !== null && state.fx) return lv.usd / state.fx;
  }
  const p = (state.data.prices && ids.call(state.data.prices, asset)) ? state.data.prices[asset] : null;
  if (p === null) return null;
  return c === "usd" ? (state.fx ? p * state.fx : null) : p;
}

function computeRows() {
  const rows = state.data.assets.map((a) => {
    const px = priceFor(a.asset);
    const val3 = px !== null ? a.deployed_units * px : null;
    const val1 = px !== null ? a.quantity * px : null;
    const u3 = val3 !== null ? val3 - a.cost_basis : null;
    const u1 = val1 !== null ? val1 - a.cost_basis : null;
    return Object.assign({}, a, { price: px, val3, val1, u3, u1,
      ret3: (a.cost_basis > 0 && u3 !== null) ? (u3 / a.cost_basis) * 100 : null,
      ret1: (a.cost_basis > 0 && u1 !== null) ? (u1 / a.cost_basis) * 100 : null });
  });
  return rows.sort((A, B) => ((B.val1 ?? -1) - (A.val1 ?? -1)));
}

function totals(rows) {
  const t = { v3: 0, v1: 0, c: 0, u3: 0, u1: 0 };
  for (const x of rows) {
    t.c += x.cost_basis;
    if (x.val3 !== null) { t.v3 += x.val3; t.v1 += x.val1; t.u3 += x.u3; t.u1 += x.u1; }
  }
  return t;
}

/* ---------- DOM builders ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function stat(k, v, cls, sub, subCls) {
  const box = el("div", "stat");
  box.appendChild(el("div", "k", k));
  const vd = el("div", "v" + (cls ? " " + cls : ""), v);
  box.appendChild(vd);
  if (sub) box.appendChild(el("div", "sub" + (subCls ? " " + subCls : ""), sub));
  return box;
}

function renderSummary(t) {
  const g = $("summary"); g.textContent = "";
  const meta = state.data.meta;
  const r3 = t.c ? (t.u3 / t.c) * 100 : null;
  const r1 = t.c ? (t.u1 / t.c) * 100 : null;
  const zc = t.v1 !== null ? t.v1 - t.v3 : null;
  const sub = (x) => (x === null || x === undefined || !isFinite(x)) ? "" : (x >= 0 ? "+" : "") + money(x);
  g.appendChild(stat("Portfolio value", money(t.v1)));
  g.appendChild(stat("Portfolio return", rfmt(r1), r1 !== null && r1 >= 0 ? "pos" : (r1 !== null ? "neg" : ""),
    sub(t.u1), t.u1 !== null && t.u1 >= 0 ? "pos" : (t.u1 !== null ? "neg" : "")));
  g.appendChild(stat("Invested value", money(t.v3)));
  g.appendChild(stat("Invested return", rfmt(r3), r3 !== null && r3 >= 0 ? "pos" : (r3 !== null ? "neg" : ""),
    sub(t.u3), t.u3 !== null && t.u3 >= 0 ? "pos" : (t.u3 !== null ? "neg" : "")));
  g.appendChild(stat("Shared cost basis", money(t.c)));
  g.appendChild(stat("Gifted & staked value", money(zc)));
  g.appendChild(stat("Realized P/L", money(meta.total_realized), meta.total_realized >= 0 ? "pos" : "neg"));
  if (meta.realized_by_year && typeof meta.realized_by_year === "object") {
    const ys = Object.keys(meta.realized_by_year).sort()
      .filter((k) => { const v = meta.realized_by_year[k]; return typeof v === "number" && Math.abs(v) >= 0.005; });
    if (ys.length) {
      const panel = el("div", "stat tax-years");
      panel.appendChild(el("span", "k", "Realized P/L by tax year"));
      const rows = el("div", "ty-rows");
      for (const k of ys) {
        const v = meta.realized_by_year[k];
        const row = el("div", "ty-row");
        row.appendChild(el("span", "ty-y", k));
        row.appendChild(el("span", "ty-v " + (v >= 0 ? "pos" : "neg"), (v >= 0 ? "+" : "") + money(v)));
        rows.appendChild(row);
      }
      panel.appendChild(rows);
      panel.appendChild(el("div", "ty-foot",
        "Realized gains/losses from trades closed in each tax year - positive is profit, negative is loss. This is not the tax owed, and years without realized trades are omitted."));
      g.appendChild(panel);
    }
  }
  g.appendChild(stat("Net deposited", money(meta.net_deposited)));
  g.appendChild(stat("Deposited", money(meta.total_deposited), "small"));
  g.appendChild(stat("Withdrawn", money(meta.total_withdrawn), "small"));
  g.appendChild(stat("EUR on hand", money(meta.eur_remaining), "small"));
  g.appendChild(stat("Generated", (state.data.generated_at || "").replace(" ", " "), "small"));
}

function renderWarnings() {
  const w = $("warnBox");
  const ws = state.data.warnings || [];
  const key = "warn_dismiss_" + (state.data.generated_at || "").slice(0, 16);
  let dismissed = false;
  try { dismissed = localStorage.getItem(key) === "1"; } catch (e) { /* ignore */ }
  if (!ws.length || dismissed) { w.hidden = true; return; }
  const head = el("div", "warn-head");
  head.appendChild(el("span", null, "reconciliation: " + ws.length + " asset(s) with an unexplained residual (treated ZERO-COST):"));
  const cb = el("button", "warn-close", "\u00D7");
  cb.type = "button"; cb.setAttribute("aria-label", "Dismiss warning");
  cb.addEventListener("click", () => { try { localStorage.setItem(key, "1"); } catch (e) { /* ignore */ } w.hidden = true; });
  head.appendChild(cb);
  const lines = ws.map(([a, q, recon, res]) =>
    `  ${String(a).padEnd(6)} balances=${q.toFixed(8)}  ledger-explained=${recon.toFixed(8)}  residual(0-cost)=${res.toFixed(8)}`);
  const body = el("div", "warn-body", lines.join("\n"));
  w.textContent = "";
  w.appendChild(head);
  w.appendChild(body);
  w.hidden = false;
}

function renderChart() {
  const card = $("chartCard");
  const h = state.data.history;
  if (!h || !Array.isArray(h.dates) || !Array.isArray(h.value) || h.dates.length !== h.value.length || h.dates.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const svg = $("chart");
  const W = 600, H = 150, P = 8;
  const vals = h.value;
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-9) { hi = lo + 1; }
  const span = hi - lo;
  const x = (i) => P + (i / (vals.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = (arr) => arr.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join("");
  const line = `<path d="${path(vals)}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
  let costPath = "", hasCost = false;
  if (Array.isArray(h.cost) && h.cost.length === vals.length) {
    hasCost = true;
    costPath = `<path d="${path(h.cost)}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }
  svg.innerHTML = `<rect width="${W}" height="${H}" fill="var(--panel)"/>` + costPath + line;
  $("lgCost").hidden = !hasCost;
  const last = h.dates[h.dates.length - 1];
  const tile = (lab, v, extra) =>
    `<span class="cs"><span class="cs-lab">${lab}</span><span class="cs-val">${money(v)}</span>${extra ? `<span class="cs-sub">${extra}</span>` : ""}</span>`;
  $("chartStats").innerHTML =
    tile("Start", vals[0]) +
    tile("Now", vals[vals.length - 1], last) +
    tile("High", hi) +
    tile("Low", lo);
  $("chartEst").textContent = "estimate: ledger replay + residual, " + CCY_SYM() + " historical cost";
}

function makeTable(tbl, cols, rows, totalsRow) {
  const thead = el("thead");
  const hr = el("tr");
  for (const c of cols) { const th = el("th", null, c); hr.appendChild(th); }
  thead.appendChild(hr); tbl.appendChild(thead);
  const tb = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    r.forEach((cell, i) => {
      const td = el("td", i > 0 ? "num" : "", cell);
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  if (totalsRow) {
    const tr = el("tr", "total");
    totalsRow.forEach((cell, i) => tr.appendChild(el("td", i > 0 ? "num" : "", cell)));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
}

function renderTables(rows, t) {
  const cols = ["ASSET", "QUANTITY", "COST BASIS", "VALUE", "UNREAL P/L", "RET%"];

  $("tbl3").textContent = "";
  makeTable($("tbl3"), cols, rows.map((x) => [
    x.asset, qfmt(x.deployed_units), money(x.cost_basis),
    money(x.val3), money(x.u3), rfmt(x.ret3),
  ]), [
    "TOTAL", "", money(t.c), money(t.v3), money(t.u3),
    t.c ? ((t.u3 / t.c) * 100).toLocaleString("en-US", { signDisplay: "always", maximumFractionDigits: 1 }) + "%" : "n/a",
  ]);

  $("tbl1").textContent = "";
  makeTable($("tbl1"), cols, rows.map((x) => [
    x.asset, qfmt(x.quantity), money(x.cost_basis),
    money(x.val1), money(x.u1), rfmt(x.ret1),
  ]), [
    "TOTAL", "", money(t.c), money(t.v1), money(t.u1),
    t.c ? ((t.u1 / t.c) * 100).toLocaleString("en-US", { signDisplay: "always", maximumFractionDigits: 1 }) + "%" : "n/a",
  ]);

  $("tblRef").textContent = "";
  makeTable($("tblRef"), ["ASSET", "AVG COST/UNIT", "LIVE PRICE"], rows.map((x) => {
    const pc = priceFor(x.asset, ccy);
    return [
      x.asset,
      costUnit(x.quantity ? x.cost_basis / x.quantity : 0),
      (pc === null ? "n/a" : pfmt(pc) + " " + CCY_SYM()),
    ];
  }), null);
}

function renderMeta() {
  const d = state.data;
  const gen = (d.generated_at || "").slice(0, 16);
  $("dataSource").textContent = d.source === "device"
    ? "Report stored on this device (" + gen + ")"
    : "Report from Mac run " + gen;
  const lab = $("ccyLabel");
  if (lab) lab.textContent = "per unit, in " + ccy.toUpperCase();
  if (state.liveTs) {
    $("priceState").textContent = "Prices: live " + state.liveTs.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
      " \u00B7 " + (ccy === "usd" ? "USD" : "EUR");
  } else if (d.prices && Object.keys(d.prices).length) {
    $("priceState").textContent = "Prices: snapshot (offline, " + gen + (ccy === "usd" && state.fx ? ", USD" : "") + ")";
  } else {
    $("priceState").textContent = "Prices: unavailable";
  }
}

function render() {
  if (!state.data) return;
  const rows = computeRows();
  const t = totals(rows);
  renderMeta();
  renderSummary(t);
  renderWarnings();
  renderChart();
  renderTables(rows, t);
  $("termText").textContent = state.data.terminal_report || "(no terminal text in report)";
}

/* ---------- data loading ---------- */
function validReport(d) {
  return d && Array.isArray(d.assets) && d.meta && typeof d.terminal_report === "string";
}

async function loadData() {
  let d = null, src = "device";
  try {
    const ls = localStorage.getItem(LS_KEY);
    if (ls) d = JSON.parse(ls);
  } catch (e) { /* ignore */ }
  if (!d || !validReport(d)) {
    d = null;
    try {
      const r = await fetch("report.json", { cache: "no-store" });
      if (r.ok) { d = await r.json(); src = "origin"; }
    } catch (e) { /* offline / none */ }
  }
  if (d && validReport(d)) {
    d.source = src;
    try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
    state.data = d;
    $("viewEmpty").hidden = true;
    $("viewCards").hidden = false;
    render();
    refreshPrices();
    scheduleAuto();
  } else {
    $("viewEmpty").hidden = false;
    $("viewCards").hidden = true;
    $("viewTerminal").hidden = true;
  }
}

async function refreshPrices(opts) {
  if (!state.data || state.refreshing) return;
  state.refreshing = true;
  const silent = opts && opts.silent;
  const btn = $("btnRefresh");
  if (!silent) { btn.disabled = true; btn.textContent = "Refreshing..."; }
  const cg = state.data.cg_ids || {};
  const idsList = Object.keys(cg).map((k) => cg[k]).filter(Boolean);
  state.live = {}; state.liveTs = null;
  if (idsList.length) {
    try {
      const r = await fetch(COINGECKO + "?ids=" + encodeURIComponent(idsList.join(",")) + "&vs_currencies=eur,usd",
        { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      for (const sym of Object.keys(cg)) {
        const cur = j[cg[sym]];
        if (!cur) continue;
        const lv = {};
        if (cur.eur !== undefined && cur.eur !== null) lv.eur = cur.eur;
        if (cur.usd !== undefined && cur.usd !== null) lv.usd = cur.usd;
        if (Object.keys(lv).length) state.live[sym] = lv;
      }
      if (Object.keys(state.live).length) {
        state.liveTs = new Date();
        const a = Object.values(state.live).find((x) => x.eur && x.usd);
        if (a) {
          state.fx = a.usd / a.eur;
          try { localStorage.setItem(FX_KEY, String(state.fx)); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* keep snapshot prices */ }
  }
  if (!silent) { btn.disabled = false; btn.textContent = "Refresh prices"; }
  state.refreshing = false;
  render();
}

function scheduleAuto() {
  if (window.__autoTimer) clearInterval(window.__autoTimer);
  window.__autoTimer = setInterval(() => {
    if (!document.hidden) refreshPrices({ silent: true });
  }, AUTO_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.liveTs && Date.now() - state.liveTs.getTime() >= AUTO_MS) refreshPrices({ silent: true });
});

/* ---------- import ---------- */
async function onImport(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!validReport(d)) throw new Error("not a portfolio report.json");
    d.source = "device";
    localStorage.setItem(LS_KEY, JSON.stringify(d));
    state.data = d;
    $("viewEmpty").hidden = true;
    setView("cards");
    render();
    refreshPrices();
    scheduleAuto();
    $("priceState").textContent = "Prices: refreshing...";
  } catch (err) {
    alert("Import failed: " + (err && err.message ? err.message : "invalid file"));
  }
}

/* ---------- view mode toggle ---------- */
function setView(v) {
  $("tabCards").classList.toggle("active", v === "cards");
  $("tabTerminal").classList.toggle("active", v === "terminal");
  $("tabCards").setAttribute("aria-selected", v === "cards");
  $("tabTerminal").setAttribute("aria-selected", v === "terminal");
  $("viewCards").hidden = v !== "cards";
  $("viewTerminal").hidden = v !== "terminal";
}

/* ---------- currency toggle ---------- */
function setCcy(c) {
  ccy = c;
  try { localStorage.setItem(CCY_KEY, c); } catch (e) { /* ignore */ }
  $("ccyEUR").classList.toggle("active", c === "eur");
  $("ccyUSD").classList.toggle("active", c === "usd");
  render();
}

$("tabCards").addEventListener("click", () => setView("cards"));
$("tabTerminal").addEventListener("click", () => setView("terminal"));
$("btnRefresh").addEventListener("click", () => refreshPrices());
$("btnImport").addEventListener("click", () => $("fileImport").click());
$("fileImport").addEventListener("change", onImport);
$("ccyEUR").addEventListener("click", () => setCcy("eur"));
$("ccyUSD").addEventListener("click", () => setCcy("usd"));
$("ccyEUR").classList.toggle("active", ccy === "eur");
$("ccyUSD").classList.toggle("active", ccy === "usd");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}

loadData();