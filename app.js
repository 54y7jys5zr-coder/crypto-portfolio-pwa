"use strict";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";
const LS_KEY = "portfolio_report_v1";

const $ = (id) => document.getElementById(id);
const ids = Object.prototype.hasOwnProperty;

const state = { data: null, live: {}, liveTs: null };

/* ---------- formatting (mirrors portfolio_tool.py) ---------- */
const NF = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const s2   = NF(2, 2);
const s8   = NF(0, 8);
const s6   = NF(6, 6);
const s4   = NF(4, 4);
const s1s  = new Intl.NumberFormat("en-US", { signDisplay: "always", maximumFractionDigits: 1 });

function s(x)   { return (x === null || x === undefined || !isFinite(x)) ? "n/a" : s2.format(x); }
function qfmt(x) { if (x === null || x === undefined || !isFinite(x)) return "0";
  const st = s8.format(x).replace(/\.?0+$/, ""); return st || "0"; }
function pfmt(x) {
  if (x === null || x === undefined || !isFinite(x)) return "n/a";
  if (x === 0) return "0";
  if (x < 0.01) { const st = NF(0, 8).format(x).replace(/\.?0+$/, ""); return st || "0"; }
  if (x < 1) return s6.format(x);
  return s4.format(x);
}
function rfmt(x) { return (x === null || x === undefined || !isFinite(x)) ? "n/a" : s1s.format(x) + "%"; }

/* ---------- data ---------- */
function priceFor(asset) {
  if (state.liveTs && ids.call(state.live, asset)) return state.live[asset];
  if (state.data.prices && ids.call(state.data.prices, asset)) return state.data.prices[asset];
  return null;
}

function computeRows() {
  const vs = state.data.vs_currency || "eur";
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

function stat(k, v, cls) {
  const box = el("div", "stat");
  box.appendChild(el("div", "k", k));
  const vd = el("div", "v" + (cls ? " " + cls : ""), v);
  box.appendChild(vd);
  return box;
}

function renderSummary(t) {
  const g = $("summary"); g.textContent = "";
  const meta = state.data.meta;
  const r3 = t.c ? (t.u3 / t.c) * 100 : null;
  const r1 = t.c ? (t.u1 / t.c) * 100 : null;
  const zc = t.v1 !== null ? t.v1 - t.v3 : null;
  g.appendChild(stat("Portfolio value", s(t.v1)));
  g.appendChild(stat("Portfolio return", rfmt(r1), r1 !== null && r1 >= 0 ? "pos" : (r1 !== null ? "neg" : "")));
  g.appendChild(stat("Invested value", s(t.v3)));
  g.appendChild(stat("Invested return", rfmt(r3), r3 !== null && r3 >= 0 ? "pos" : (r3 !== null ? "neg" : "")));
  g.appendChild(stat("Shared cost basis", s(t.c)));
  g.appendChild(stat("Gifted & staked value", s(zc)));
  g.appendChild(stat("Realized P/L", s(meta.total_realized), meta.total_realized >= 0 ? "pos" : "neg"));
  g.appendChild(stat("Net deposited", s(meta.net_deposited)));
  g.appendChild(stat("Deposited", s(meta.total_deposited), "small"));
  g.appendChild(stat("Withdrawn", s(meta.total_withdrawn), "small"));
  g.appendChild(stat("EUR on hand", s(meta.eur_remaining), "small"));
  g.appendChild(stat("Generated", (state.data.generated_at || "").replace(" ", " "), "small"));
}

function renderWarnings() {
  const w = $("warnBox");
  const ws = state.data.warnings || [];
  if (!ws.length) { w.hidden = true; return; }
  const lines = ws.map(([a, q, recon, res]) =>
    `  ${String(a).padEnd(6)} balances=${q.toFixed(8)}  ledger-explained=${recon.toFixed(8)}  residual(0-cost)=${res.toFixed(8)}`);
  w.textContent = `reconciliation: ${ws.length} asset(s) with an unexplained residual (treated ZERO-COST):\n` + lines.join("\n");
  w.hidden = false;
}

function makeTable(tbl, cols, rows, totalsRow, totLabel) {
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
    x.asset, qfmt(x.deployed_units), s(x.cost_basis),
    s(x.val3), s(x.u3), rfmt(x.ret3),
  ]), [
    "TOTAL", "", s(t.c), s(t.v3), s(t.u3),
    t.c ? ((t.u3 / t.c) * 100).toLocaleString("en-US", { signDisplay: "always", maximumFractionDigits: 1 }) + "%" : "n/a",
  ], null);

  $("tbl1").textContent = "";
  makeTable($("tbl1"), cols, rows.map((x) => [
    x.asset, qfmt(x.quantity), s(x.cost_basis),
    s(x.val1), s(x.u1), rfmt(x.ret1),
  ]), [
    "TOTAL", "", s(t.c), s(t.v1), s(t.u1),
    t.c ? ((t.u1 / t.c) * 100).toLocaleString("en-US", { signDisplay: "always", maximumFractionDigits: 1 }) + "%" : "n/a",
  ], null);

  $("tblRef").textContent = "";
  makeTable($("tblRef"), ["ASSET", "AVG COST/UNIT", "LIVE PRICE"], rows.map((x) => [
    x.asset,
    pfmt(x.quantity ? x.cost_basis / x.quantity : 0),
    pfmt(x.price),
  ]), null, null);
}

function renderMeta() {
  const d = state.data;
  const gen = (d.generated_at || "").slice(0, 16);
  $("dataSource").textContent = d.source === "device"
    ? "Report stored on this device (" + gen + ")"
    : "Report from Mac run " + gen;
  if (state.liveTs) {
    $("priceState").textContent = "Prices: live " + state.liveTs.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (d.prices && Object.keys(d.prices).length) {
    $("priceState").textContent = "Prices: snapshot (offline, " + gen + ")";
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
  } else {
    $("viewEmpty").hidden = false;
    $("viewCards").hidden = true;
    $("viewTerminal").hidden = true;
  }
}

async function refreshPrices() {
  if (!state.data) return;
  const btn = $("btnRefresh");
  btn.disabled = true; btn.textContent = "Refreshing...";
  const vs = state.data.vs_currency || "eur";
  const cg = state.data.cg_ids || {};
  const idsList = Object.keys(cg).map((k) => cg[k]).filter(Boolean);
  state.live = {}; state.liveTs = null;
  if (idsList.length) {
    try {
      const r = await fetch(COINGECKO + "?ids=" + encodeURIComponent(idsList.join(",")) + "&vs_currencies=" + encodeURIComponent(vs),
        { headers: { "Accept": "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      for (const sym of Object.keys(cg)) {
        const cid = cg[sym];
        if (cid && j[cid] && j[cid][vs] !== undefined && j[cid][vs] !== null) state.live[sym] = j[cid][vs];
      }
      if (Object.keys(state.live).length) state.liveTs = new Date();
    } catch (e) { /* keep snapshot prices */ }
  }
  btn.disabled = false; btn.textContent = "Refresh prices";
  render();
}

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

$("tabCards").addEventListener("click", () => setView("cards"));
$("tabTerminal").addEventListener("click", () => setView("terminal"));
$("btnRefresh").addEventListener("click", refreshPrices);
$("btnImport").addEventListener("click", () => $("fileImport").click());
$("fileImport").addEventListener("change", onImport);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* optional */ });
}

loadData();