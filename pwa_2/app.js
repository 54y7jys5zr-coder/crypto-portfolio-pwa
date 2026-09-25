/* Crypto Portfolio PWA — UI + live prices + FX + chart. Engine in engine.js. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  data: null,          // {assets, meta, warnings}
  prices: {},          // symbol -> EUR price
  priceTs: null,       // timestamp of current prices
  fx: { EUR:1, PLN:null },
  ccy: "EUR",
  view: 1,             // 1 = All Holdings (total), 3 = Invested Only (deployed)
  tableOpt: 1,
  sortKey: "value",    // table sort
  sortDir: -1,
  auto: true,
  timer: null,
  freshTimer: null,
  chart: null,
  allocChart: null,
  chartLoaded: false,
  chartBusy: false,
  hist: null,          // cached 365d history
  prevPrices: {},      // for price-move flash
  cardSort: "value",   // cards sort key
  cardQuery: "",       // cards search
  tableQuery: "",      // table search
  density: "cozy",     // cozy | compact
  alerts: {},          // symbol -> target price (EUR)
};

/* persisted prefs */
function loadPrefs(){
  try{ state.alerts = JSON.parse(localStorage.getItem("alerts")||"{}") || {}; }catch(e){ state.alerts={}; }
  try{ const d=localStorage.getItem("density"); if(d) state.density=d; }catch(e){}
}
function saveAlerts(){ try{ localStorage.setItem("alerts", JSON.stringify(state.alerts)); }catch(e){} }

/* ---------- formatting ---------- */
const esc = s => s==null ? "" : String(s).replace(/[&<>"'`]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;"}[c]));
const rate = () => state.fx[state.ccy] || 1;
const ccySuffix = (s) => state.ccy==="EUR" ? `€${s}` : `${s} zł`;
const fmtMoney = (eur) => {
  if (eur==null || isNaN(eur)) return "—";
  const v = eur * rate();
  return ccySuffix(v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}));
};
/* compact money for tight card space: €7.2K, €1.3M */
const fmtMoneyCompact = (eur) => {
  if (eur==null || isNaN(eur)) return "—";
  const v = eur * rate(); const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = (v/1e9).toFixed(2)+"B";
  else if (a >= 1e6) s = (v/1e6).toFixed(2)+"M";
  else if (a >= 1e4) s = (v/1e3).toFixed(1)+"K";
  else s = v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  return ccySuffix(s);
};
const fmtQty = (x) => x==null ? "—" : x.toLocaleString(undefined,{maximumFractionDigits:8});
/* price-aware money: per-unit prices/avg-cost span huge ranges (PEPE ~€0.0000041 .. BTC €73k).
   Pick significant decimals by magnitude so tiny values never render as €0.00. */
const fmtPrice = (eur) => {
  if (eur==null || isNaN(eur)) return "—";
  const v = eur * rate(); const a = Math.abs(v);
  let dp;
  if (a === 0)      dp = 2;
  else if (a >= 1000) dp = 2;
  else if (a >= 1)  dp = 4;
  else if (a >= 0.01) dp = 6;
  else {
    // very small: show ~4 significant figures after the leading zeros
    const leadingZeros = Math.floor(-Math.log10(a));
    dp = Math.min(12, leadingZeros + 4);
  }
  return ccySuffix(v.toLocaleString(undefined,{minimumFractionDigits:Math.min(dp,2),maximumFractionDigits:dp}));
};
const fmtQtyCompact = (x) => {
  if(x==null) return "—"; const a=Math.abs(x);
  if(a>=1e6) return (x/1e6).toFixed(2)+"M";
  if(a>=1e4) return x.toLocaleString(undefined,{maximumFractionDigits:0});
  return x.toLocaleString(undefined,{maximumFractionDigits:6});
};
const pct = (x) => x==null||isNaN(x) ? "—" : `${x>=0?"+":""}${x.toFixed(1)}%`;
const arrowOf = u => u==null?"":(u>=0?"▲":"▼");
const plColorOf = u => u==null?"var(--flat)":(u>=0?"var(--green)":"var(--red)");

function ratioColor(ratio){
  if (ratio==null || isNaN(ratio)) return {c:"var(--flat)", dim:"var(--card2)"};
  if (ratio >= 1.5) return {c:"var(--green)", dim:"var(--green-dim)"};
  if (ratio > 1.0)  return {c:"var(--green)", dim:"color-mix(in srgb,var(--green) 22%, var(--card))"};
  if (ratio === 1.0)return {c:"var(--flat)", dim:"var(--card2)"};
  if (ratio > 0.8)  return {c:"var(--red)", dim:"color-mix(in srgb,var(--red) 20%, var(--card))"};
  return {c:"var(--red)", dim:"var(--red-dim)"};
}

/* ---------- data loading ---------- */
async function loadBundled(){
  const r = await fetch("./data.json",{cache:"no-store"});
  state.data = await r.json();
  $("#dataSource").textContent = "bundled snapshot ("+(state.data.generated||"")+")";
  reconMsg();
}
function reconMsg(){
  const w = state.data && state.data.warnings || [];
  $("#reconMsg").textContent = w.length
    ? `Reconciliation: ${w.length} asset(s) with zero-cost residual (e.g. ${esc(w[0].asset)}).`
    : "Reconciliation: all assets tie to Balances.";
}

/* ---------- live prices + FX ---------- */
async function fetchPrices(){
  const ids = [...new Set(state.data.assets.map(a=>a.cg_id).filter(Boolean))].map(encodeURIComponent).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur`;
  const r = await fetch(url,{cache:"no-store"});
  if(!r.ok) throw new Error("price fetch "+r.status);
  const d = await r.json();
  const px = {};
  for(const a of state.data.assets){ const p=d[a.cg_id]; if(p&&p.eur!=null) px[a.asset]=p.eur; }
  state.prices = px; state.priceTs = Date.now();
  try{ localStorage.setItem("px_cache", JSON.stringify({t:state.priceTs,px})); }catch(e){}
}
async function fetchFX(){
  try{
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=PLN",{cache:"no-store"});
    const d = await r.json();
    if(d && d.rates && d.rates.PLN){ state.fx.PLN = d.rates.PLN; return; }
  }catch(e){}
  try{
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,pln",{cache:"no-store"});
    const d = await r.json();
    if(d.bitcoin && d.bitcoin.eur && d.bitcoin.pln) state.fx.PLN = d.bitcoin.pln / d.bitcoin.eur;
  }catch(e){}
}
function loadCachedPrices(){
  try{ const c=JSON.parse(localStorage.getItem("px_cache")||"null"); if(c&&c.px){ state.prices=c.px; state.priceTs=c.t||null; } }catch(e){}
}

/* ---------- compute ---------- */
function computeRows(view){
  view = view || state.view;
  return state.data.assets.map(a=>{
    const px = state.prices[a.asset];
    const units = view===3 ? a.deployed_units : a.quantity;
    const value = px!=null ? units*px : null;
    const cost = a.cost_basis;
    const unreal = value!=null ? value-cost : null;
    const ratio = (value!=null && cost>0) ? value/cost : (cost===0 && value>0 ? 2 : null);
    const ret = (cost>0 && unreal!=null) ? unreal/cost*100 : null;
    const avg = a.quantity ? cost/a.quantity : 0;
    return {...a, px, units, value, cost, unreal, ratio, ret, avg, priced: px!=null};
  }).sort((x,y)=> (y.value??-1)-(x.value??-1));
}
function totals(rows){
  let v=0,c=0,u=0,any=false;
  for(const r of rows){ c+=r.cost; if(r.value!=null){v+=r.value;u+=r.unreal;any=true;} }
  return {v:any?v:null, c, u:any?u:null, ret:c>0&&any?u/c*100:null};
}
function computeForView(view){
  let v=0,c=0,u=0,any=false;
  for(const a of state.data.assets){ const px=state.prices[a.asset]; const units=view===3?a.deployed_units:a.quantity;
    c+=a.cost_basis; if(px!=null){const val=units*px; v+=val; u+=val-a.cost_basis; any=true;} }
  return {v:any?v:null,c,u:any?u:null,ret:c>0&&any?u/c*100:null};
}
/* break-even price for an asset's TOTAL holdings (price at which value==cost) */
function breakEvenPrice(a){ return a.quantity>0 ? a.cost_basis/a.quantity : null; }
/* lifetime P/L = realized (booked) + current unrealized (All Holdings view) */
function lifetimePL(){
  const r1=computeForView(1); const realized=state.data.meta.total_realized||0;
  return { realized, unreal:r1.u, total:(r1.u!=null?r1.u:0)+realized, haveUnreal:r1.u!=null };
}
/* free-coins share of holdings value */
function freeCoinsShare(){
  const r1=computeForView(1), r3=computeForView(3);
  if(r1.v==null||r3.v==null||r1.v<=0) return null;
  return (r1.v-r3.v)/r1.v*100;
}

/* ---------- freshness ("updated 12s ago") ---------- */
function relTime(ts){
  if(!ts) return "—";
  const s=Math.round((Date.now()-ts)/1000);
  if(s<5) return "just now";
  if(s<60) return s+"s ago";
  const m=Math.round(s/60); if(m<60) return m+"m ago";
  const h=Math.round(m/60); return h+"h ago";
}
function updateFreshness(){
  const el=$("#lastUpdated");
  if(!state.priceTs){ el.textContent="—"; return; }
  const stale = (Date.now()-state.priceTs) > 120000; // >2 min
  el.textContent = (state.offline?"Offline · ":"") + "Updated "+relTime(state.priceTs);
  el.style.color = stale ? "var(--red)" : "";
}

/* ---------- summary tab ---------- */
function renderSummaryTab(){
  const rows=computeRows(); const t=totals(rows);
  const m=state.data.meta;
  const nm = state.view===3 ? "Invested Only" : "All Holdings";
  const el=document.querySelector(".hero-view-name-2"); if(el) el.textContent=nm;
  $("#sumHeroValue").textContent=fmtMoney(t.v);
  const pl=$("#sumHeroPL");
  pl.textContent = t.u==null?"—":`${arrowOf(t.u)} ${fmtMoney(Math.abs(t.u))} (${pct(t.ret)})`;
  pl.style.color = plColorOf(t.u);
  $("#sumHeroCost").textContent=fmtMoney(t.c);

  // lifetime P/L (realized + unrealized) + free-coins share (#4/#12)
  const lt=lifetimePL(); const fc=freeCoinsShare(); const ltEl=$("#heroLifetime");
  if(ltEl){ const c=plColorOf(lt.total);
    ltEl.innerHTML = `<span class="lt-k">Lifetime P/L</span> `+
      `<span class="lt-v" style="color:${c}">${arrowOf(lt.total)} ${fmtMoney(lt.total)}</span>`+
      (fc!=null?` <span class="muted">· ${fc.toFixed(0)}% free coins</span>`:"");
  }
  const plColor = plColorOf(t.u);
  $("#sumStats").innerHTML=`
    <div class="stat"><div class="k">Total value</div><div class="v">${fmtMoney(t.v)}</div>
      <div class="sub muted">${nm}</div></div>
    <div class="stat"><div class="k">Profit / Loss</div><div class="v" style="color:${plColor}">${t.u==null?"—":fmtMoney(t.u)}</div>
      <div class="sub" style="color:${plColor}">${arrowOf(t.u)} ${pct(t.ret)}</div></div>
    <div class="stat"><div class="k">Net invested</div><div class="v">${fmtMoney(m.net_deposited)}</div>
      <div class="sub muted">cash in − out</div></div>
    <div class="stat"><div class="k">Realized profit</div><div class="v">${fmtMoney(m.total_realized)}</div>
      <div class="sub muted">already sold</div></div>`;

  const priced=rows.filter(r=>r.ret!=null);
  const byRet=[...priced].sort((a,b)=>b.ret-a.ret);
  const winners=byRet.slice(0,3), losers=byRet.slice(-3).reverse();
  const mini=(r)=>{ const c=plColorOf(r.unreal);
    // subtle tint that stays readable in both themes: ~12% of the P/L color over the card surface
    const tint = r.unreal==null ? "var(--card)" : `color-mix(in srgb, ${c} 12%, var(--card))`;
    const barC = ratioColor(r.ratio).c;
    return `<button class="mini" data-asset="${esc(r.asset)}" style="background:${tint}">
      <div class="bar" style="background:${barC}"></div>
      <div class="sym">${esc(r.asset)}</div>
      <div class="ret" style="color:${c}">${arrowOf(r.unreal)} ${pct(r.ret)}</div>
      <div class="v">${fmtMoneyCompact(r.value)}</div></button>`; };
  $("#sumWinners").innerHTML = winners.length?winners.map(mini).join(""):'<div class="v muted">No priced assets.</div>';
  $("#sumLosers").innerHTML  = losers.length? losers.map(mini).join(""):'<div class="v muted">No priced assets.</div>';

  renderAllocDonut(rows);
}

/* allocation donut (#7) */
function renderAllocDonut(rows){
  const withVal=rows.filter(r=>r.value!=null && r.value>0).sort((a,b)=>b.value-a.value);
  const tv=withVal.reduce((s,r)=>s+r.value,0);
  const legend=$("#allocLegend");
  if(!withVal.length || !window.Chart){ if(legend) legend.innerHTML=""; return; }
  const top=withVal.slice(0,6);
  const rest=withVal.slice(6).reduce((s,r)=>s+r.value,0);
  const labels=top.map(r=>r.asset).concat(rest>0?["Other"]:[]);
  const vals=top.map(r=>r.value).concat(rest>0?[rest]:[]);
  const palette=["#8B5CF6","#6366F1","#22D3EE","#16C784","#F59E0B","#EC4899","#64748B"];
  const ctx=$("#allocChart").getContext("2d");
  if(state.allocChart) state.allocChart.destroy();
  state.allocChart=new Chart(ctx,{type:"doughnut",data:{labels,datasets:[{data:vals,backgroundColor:palette,borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:"62%",animation:REDUCE_MOTION?false:{duration:400},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.label}: ${fmtMoney(c.parsed/rate())} (${(c.parsed/tv*100).toFixed(1)}%)`}}}}});
  legend.innerHTML=labels.map((l,i)=>`<span class="lg"><i style="background:${palette[i]}"></i>${esc(l)} ${(vals[i]/tv*100).toFixed(0)}%</span>`).join("");
}

/* ---------- cards ---------- */
function renderCards(){
  const rows=computeRows(); const t=totals(rows);
  $(".hero-view-name").textContent = state.view===3 ? "Invested Only" : "All Holdings";
  const note=$("#viewNote"); if(note) note.textContent = state.view===3
    ? "Only the coins you paid for (excludes gifts & staking rewards)."
    : "Everything you hold, including gifts & staking rewards.";
  $("#heroValue").textContent = fmtMoney(t.v);
  const plEl=$("#heroPL");
  plEl.textContent = t.u==null ? "—" : `${arrowOf(t.u)} ${fmtMoney(Math.abs(t.u))} (${pct(t.ret)})`;
  plEl.style.color = plColorOf(t.u);
  $("#heroCost").textContent = fmtMoney(t.c);

  const box=$("#cards"); box.className="cards"+(state.density==="compact"?" compact":"");
  box.innerHTML="";
  // filter + sort (#5, #6)
  let list=rows.slice();
  const q=state.cardQuery.trim().toUpperCase();
  if(q) list=list.filter(r=>r.asset.toUpperCase().includes(q));
  const key=state.cardSort;
  const cmp={value:(a,b)=>(b.value??-1)-(a.value??-1),
             unreal:(a,b)=>(b.unreal??-1e18)-(a.unreal??-1e18),
             ret:(a,b)=>(b.ret??-1e18)-(a.ret??-1e18),
             asset:(a,b)=>a.asset.localeCompare(b.asset)}[key];
  list.sort(cmp);
  if(!list.length){ box.innerHTML='<div class="empty muted">No assets match.</div>'; return; }
  for(const r of list){
    const col=ratioColor(r.ratio);
    const el=document.createElement("button");
    el.className="card"+(r.priced?"":" unpriced"); el.style.background=col.dim;
    el.dataset.asset=r.asset;
    // price-move flash (#9)
    const prev=state.prevPrices[r.asset];
    if(prev!=null && r.px!=null && r.px!==prev) el.dataset.flash = r.px>prev?"up":"down";
    // alert badge (#10)
    const tgt=state.alerts[r.asset];
    const hit = tgt!=null && r.px!=null && r.px>=tgt;
    const bell = tgt!=null ? `<span class="alert-badge${hit?' hit':''}" title="Target ${fmtMoney(tgt)}">🔔</span>` : "";
    el.innerHTML=`
      <div class="bar" style="background:${col.c}"></div>
      <div class="ratio">${r.priced&&r.ratio!=null?(r.ratio).toFixed(2)+"×":(r.priced?"":"⚠")}</div>
      ${bell}
      <div class="sym">${esc(r.asset)}</div>
      <div class="qty">${fmtQtyCompact(r.units)}</div>
      <div class="px">@ ${r.px==null?"—":fmtPrice(r.px)}</div>
      <div class="val">${fmtMoneyCompact(r.value)}</div>
      <div class="chg" style="color:${plColorOf(r.unreal)}">
        <span class="arrow">${arrowOf(r.unreal)}</span> ${r.unreal==null?"no price":fmtMoneyCompact(Math.abs(r.unreal))+" · "+pct(r.ret)}
      </div>`;
    box.appendChild(el);
    if(el.dataset.flash && !REDUCE_MOTION){ requestAnimationFrame(()=>{ el.classList.add("flash-"+el.dataset.flash);
      setTimeout(()=>el.classList.remove("flash-up","flash-down"),900); }); }
  }
  // remember prices for next flash compare
  state.prevPrices = Object.assign({}, state.prices);
}

/* ---------- table (sortable #3) ---------- */
const SORTS={asset:(a,b)=>a.asset.localeCompare(b.asset),quantity:(a,b)=>a.units-b.units,
  cost:(a,b)=>a.cost_basis-b.cost_basis,value:(a,b)=>(a.value??-1)-(b.value??-1),
  unreal:(a,b)=>(a.unreal??-1e18)-(b.unreal??-1e18),ret:(a,b)=>(a.ret??-1e18)-(b.ret??-1e18)};
function renderTable(){
  const opt=state.tableOpt;
  let rows=state.data.assets.map(a=>{
    const px=state.prices[a.asset];
    const units= opt===3 ? a.deployed_units : a.quantity;
    const value= px!=null ? units*px : null;
    const unreal= value!=null ? value-a.cost_basis : null;
    const ret=(a.cost_basis>0&&unreal!=null)?unreal/a.cost_basis*100:null;
    return {...a,units,value,unreal,ret,priced:px!=null};
  });
  const cmp=SORTS[state.sortKey]||SORTS.value;
  rows.sort((a,b)=> state.sortDir*cmp(a,b));
  // table search filter (#5)
  const tq=state.tableQuery.trim().toUpperCase();
  const filtered = tq ? rows.filter(r=>r.asset.toUpperCase().includes(tq)) : rows;
  const cols=[["asset","Asset"],["quantity","Quantity"],["cost","You paid"],["value","Value now"],["unreal","Profit/Loss"],["ret","Return"]];
  const thead=$("#mainTable thead"), tbody=$("#mainTable tbody");
  thead.innerHTML="<tr>"+cols.map(([k,label])=>{
    const active=state.sortKey===k; const car=active?(state.sortDir<0?" ▾":" ▴"):"";
    return `<th data-sort="${k}" class="${active?'sorted':''}">${label}${car}</th>`;
  }).join("")+"</tr>";
  tbody.innerHTML="";
  let tv=0,tc=0,tu=0,any=false;
  for(const r of filtered){
    tc+=r.cost_basis; if(r.value!=null){tv+=r.value;tu+=r.unreal;any=true;}
    const clr=plColorOf(r.unreal); const arrow=r.unreal==null?"":(r.unreal>=0?"▲ ":"▼ ");
    const tr=document.createElement("tr"); tr.dataset.asset=r.asset;
    tr.innerHTML=`<td>${esc(r.asset)}</td><td>${fmtQty(r.units)}</td><td>${fmtMoney(r.cost_basis)}</td>
      <td>${r.value==null?'<span class="muted">no price</span>':fmtMoney(r.value)}</td>
      <td style="color:${clr}">${r.unreal==null?"—":arrow+fmtMoney(Math.abs(r.unreal))}</td>
      <td style="color:${clr}">${pct(r.ret)}</td>`;
    tbody.appendChild(tr);
  }
  const tr=document.createElement("tr"); tr.className="totrow";
  tr.innerHTML=`<td>TOTAL</td><td></td><td>${fmtMoney(tc)}</td><td>${fmtMoney(any?tv:null)}</td>
    <td>${fmtMoney(any?tu:null)}</td><td>${pct(any&&tc>0?tu/tc*100:null)}</td>`;
  tbody.appendChild(tr);
  renderSummaryPanel();
  updateTableFade();
}
function renderSummaryPanel(){
  const m=state.data.meta;
  const r1=computeForView(1), r3=computeForView(3);
  $("#summary").innerHTML=`
    <h3>Headline</h3>
    <div class="row"><span class="k">Invested Only · value / return</span><span>${fmtMoney(r3.v)} (${pct(r3.ret)})</span></div>
    <div class="row"><span class="k">All Holdings · value / return</span><span>${fmtMoney(r1.v)} (${pct(r1.ret)})</span></div>
    <div class="row"><span class="k">You paid (cost basis)</span><span>${fmtMoney(r1.c)}</span></div>
    <div class="row"><span class="k">Free coins value (gifts + rewards)</span><span>${fmtMoney(r1.v!=null&&r3.v!=null?r1.v-r3.v:null)}</span></div>
    <hr/><h3>EUR flows</h3>
    <div class="row"><span class="k">Deposited</span><span>${fmtMoney(m.total_deposited)}</span></div>
    <div class="row"><span class="k">Withdrawn</span><span>${fmtMoney(m.total_withdrawn)}</span></div>
    <div class="row"><span class="k">Net deposited</span><span>${fmtMoney(m.net_deposited)}</span></div>
    <div class="row"><span class="k">Realized profit (already sold)</span><span>${fmtMoney(m.total_realized)}</span></div>`;
}
function updateTableFade(){
  const ts=$("#tableScroll"), tw=ts&&ts.querySelector(".table-wrap");
  if(tw){ const end=tw.scrollLeft+tw.clientWidth >= tw.scrollWidth-4; ts.classList.toggle("at-end",end); }
}

/* ---------- per-asset detail sheet (#1) ---------- */
function openDetail(sym){
  const a=state.data.assets.find(x=>x.asset===sym); if(!a) return;
  const px=state.prices[sym];
  const totalVal = px!=null ? a.quantity*px : null;
  const depVal   = px!=null ? a.deployed_units*px : null;
  const freeUnits= a.quantity - a.deployed_units;
  const freeVal  = px!=null ? freeUnits*px : null;
  const unreal   = totalVal!=null ? totalVal-a.cost_basis : null;
  const ret      = a.cost_basis>0&&unreal!=null?unreal/a.cost_basis*100:null;
  const avg      = a.quantity?a.cost_basis/a.quantity:0;
  const bep      = breakEvenPrice(a);          // price at which value == cost
  const toBreakeven = (px!=null && bep!=null) ? (bep-px)/px*100 : null; // % move needed
  const aboveBE  = px!=null && bep!=null ? px>=bep : null;
  const col=ratioColor(px!=null&&a.cost_basis>0?totalVal/a.cost_basis:null);
  const tgt=state.alerts[sym];

  $("#detailTitle").textContent=sym;
  $("#detailBody").innerHTML=`
    <div class="d-hero" style="background:${col.dim}">
      <div class="d-val">${fmtMoney(totalVal)}</div>
      <div class="d-pl" style="color:${plColorOf(unreal)}">${arrowOf(unreal)} ${unreal==null?"—":fmtMoney(unreal)} (${pct(ret)})</div>
    </div>
    <div class="d-grid">
      <div class="d-cell"><div class="k">Live price</div><div class="v">${px==null?"—":fmtPrice(px)}</div></div>
      <div class="d-cell"><div class="k">Avg cost / unit</div><div class="v">${fmtPrice(avg)}</div></div>
      <div class="d-cell"><div class="k">You paid (cost)</div><div class="v">${fmtMoney(a.cost_basis)}</div></div>
      <div class="d-cell"><div class="k">Realized profit</div><div class="v">${fmtMoney(a.realized)}</div></div>
    </div>
    <h4>Holdings breakdown</h4>
    <div class="d-row"><span>Total quantity</span><span>${fmtQty(a.quantity)}</span></div>
    <div class="d-row"><span>Invested (paid for)</span><span>${fmtQty(a.deployed_units)} · ${fmtMoney(depVal)}</span></div>
    <div class="d-row"><span>Free coins (gifts+rewards)</span><span>${fmtQty(freeUnits)} · ${fmtMoney(freeVal)}</span></div>
    <h4>Break-even</h4>
    <div class="d-row"><span>Break-even price</span><span>${bep==null?"—":fmtPrice(bep)}</span></div>
    <div class="d-row"><span>Status</span><span style="color:${aboveBE==null?'var(--flat)':(aboveBE?'var(--green)':'var(--red)')}">${
      aboveBE==null?"—":(aboveBE
        ? "▲ above break-even"
        : "▼ needs "+ (toBreakeven!=null?("+"+toBreakeven.toFixed(1)+"%"):"—") +" to break even")}</span></div>
    <h4>Price alert</h4>
    <div class="d-alert">
      <input type="number" inputmode="decimal" id="alertInput" class="alert-input" placeholder="Target price (${state.ccy})" value="${tgt!=null?(function(x){const v=tgt*rate();const a=Math.abs(v);const dp=a>=1?4:Math.min(12,Math.floor(-Math.log10(a||1))+5);return v.toFixed(dp).replace(/0+$/,'').replace(/\.$/,'');})():''}"/>
      <button id="alertSet" class="chip-btn">${tgt!=null?"Update":"Set"}</button>
      ${tgt!=null?'<button id="alertClear" class="chip-btn ghost">Clear</button>':""}
    </div>
    <div class="muted small" style="margin-top:6px">Alerts show an in-app badge when the live price reaches your target. (iOS PWAs can't send push notifications.)</div>
    <div class="d-spark"><canvas id="sparkCanvas"></canvas></div>
    <div class="d-sparklabel muted small">30-day price (approx.)</div>`;
  $("#detailSheet").classList.add("open");
  $("#detailBackdrop").classList.add("open");
  // alert set/clear (#10) — input is in display currency, stored in EUR
  const setBtn=$("#alertSet");
  if(setBtn) setBtn.addEventListener("click",()=>{
    const raw=parseFloat($("#alertInput").value);
    if(!isNaN(raw)&&raw>0){ state.alerts[sym]=raw/rate(); saveAlerts(); renderCards(); openDetail(sym); }
  });
  const clrBtn=$("#alertClear");
  if(clrBtn) clrBtn.addEventListener("click",()=>{ delete state.alerts[sym]; saveAlerts(); renderCards(); openDetail(sym); });
  drawSparkline(a);
}
function closeDetail(){ $("#detailSheet").classList.remove("open"); $("#detailBackdrop").classList.remove("open"); }
async function drawSparkline(a){
  if(!window.Chart) return;
  let series=null;
  if(state.hist && state.hist[a.asset]) series=state.hist[a.asset].slice(-30).map(x=>x.p);
  const canvas=$("#sparkCanvas"); if(!canvas) return;
  if(!series || series.length<2){ canvas.parentElement.innerHTML='<div class="muted small" style="padding:20px 0;text-align:center">Price history loads on the Chart tab.</div>'; return; }
  const up=series[series.length-1]>=series[0];
  new Chart(canvas.getContext("2d"),{type:"line",data:{labels:series.map((_,i)=>i),
    datasets:[{data:series,borderColor:up?"#16C784":"#EA3943",borderWidth:2,pointRadius:0,tension:.3,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,animation:REDUCE_MOTION?false:{duration:300},
      plugins:{legend:{display:false},tooltip:{enabled:false}},scales:{x:{display:false},y:{display:false}}}});
}

/* ---------- 365-day chart (#13 cache-first) ---------- */
async function loadChart(background){
  if(!window.Chart){ setTimeout(()=>loadChart(background),300); return; }
  const cacheKey="hist_"+new Date().toISOString().slice(0,10);
  let hist=state.hist;
  if(!hist){ try{ hist=JSON.parse(localStorage.getItem(cacheKey)||"null"); }catch(e){} }
  if(hist){ state.hist=hist; drawChart(hist); }           // show cached instantly
  if(hist && background!==true && !navigator.onLine) return;
  if(hist && !background){ /* fresh enough for today */ return; }
  // fetch fresh in background
  const fresh={};
  for(const a of state.data.assets){
    if(!a.cg_id) continue;
    try{
      const u=`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(a.cg_id)}/market_chart?vs_currency=eur&days=365&interval=daily`;
      const r=await fetch(u); if(!r.ok) continue;
      const d=await r.json();
      fresh[a.asset]=(d.prices||[]).map(p=>({t:p[0],p:p[1]}));
      await new Promise(res=>setTimeout(res,300));
    }catch(e){}
  }
  if(Object.keys(fresh).length){ state.hist=fresh; try{localStorage.setItem(cacheKey,JSON.stringify(fresh));}catch(e){} drawChart(fresh); }
  else if(!hist){ $("#chartStats").innerHTML='<div class="stat"><div class="k">Chart</div><div class="v">unavailable</div></div>'; }
}
function drawChart(hist){
  let base=null;
  for(const a of state.data.assets){ const h=hist[a.asset]; if(h&&(!base||h.length>base.length)) base=h; }
  if(!base) return;
  const days=base.map(x=>x.t);
  const valueSeries=days.map((t,i)=>{ let v=0; for(const a of state.data.assets){ const h=hist[a.asset]; if(!h||!h[i]) continue; v+=a.quantity*h[i].p; } return v; });
  const totalCost=state.data.assets.reduce((s,a)=>s+a.cost_basis,0);
  const rt=rate();
  const labels=days.map(t=>new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"}));
  const valConv=valueSeries.map(v=>v*rt), costLine=days.map(()=>totalCost*rt);
  if(state.chart) state.chart.destroy();
  const ctx=$("#valueChart").getContext("2d");
  const grad=ctx.createLinearGradient(0,0,0,300);
  grad.addColorStop(0,"rgba(139,92,246,0.35)"); grad.addColorStop(1,"rgba(139,92,246,0.02)");
  state.chart=new Chart(ctx,{type:"line",data:{labels,datasets:[
    {label:"Value",data:valConv,borderColor:"#8B5CF6",backgroundColor:grad,fill:true,tension:.3,pointRadius:0,borderWidth:2},
    {label:"Cost",data:costLine,borderColor:"#8A90A0",borderDash:[6,5],fill:false,pointRadius:0,borderWidth:1.5}
  ]},options:{responsive:true,maintainAspectRatio:false,animation:REDUCE_MOTION?false:{duration:400},
    interaction:{intersect:false,mode:"index"},
    plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fmtMoney(c.parsed.y/rt)}`}}},
    scales:{x:{ticks:{maxTicksLimit:6,color:"#8A90A0"},grid:{display:false}},
            y:{ticks:{color:"#8A90A0",callback:v=>fmtMoney(v/rt)},grid:{color:"rgba(138,144,160,.12)"}}}}});
  const cur=valueSeries[valueSeries.length-1], start=valueSeries.find(v=>v>0)||0;
  const hi=Math.max(...valueSeries), lo=Math.min(...valueSeries.filter(v=>v>0));
  const chg=start?((cur-start)/start*100):null;
  // daily returns for best/worst day, volatility, max drawdown (#2)
  const rets=[]; for(let i=1;i<valueSeries.length;i++){ const p=valueSeries[i-1], c=valueSeries[i];
    if(p>0&&c>0) rets.push((c-p)/p); }
  const bestDay = rets.length?Math.max(...rets)*100:null;
  const worstDay= rets.length?Math.min(...rets)*100:null;
  const mean = rets.length?rets.reduce((s,x)=>s+x,0)/rets.length:0;
  const variance = rets.length?rets.reduce((s,x)=>s+(x-mean)**2,0)/rets.length:0;
  const vol = Math.sqrt(variance)*Math.sqrt(365)*100; // annualized %
  let peak=-Infinity, maxDD=0; for(const v of valueSeries){ if(v>peak) peak=v; if(peak>0){ const dd=(v-peak)/peak; if(dd<maxDD) maxDD=dd; } }
  const stat=(k,v,color)=>`<div class="stat"><div class="k">${k}</div><div class="v"${color?` style="color:${color}"`:""}>${v}</div></div>`;
  $("#chartStats").innerHTML=
    stat("Current value", fmtMoney(cur))+
    stat("365-day change", `${arrowOf(chg)} ${pct(chg)}`, chg>=0?'var(--green)':'var(--red)')+
    stat("365-day high", fmtMoney(hi))+
    stat("365-day low", fmtMoney(lo))+
    stat("Best day", bestDay==null?"—":pct(bestDay), 'var(--green)')+
    stat("Worst day", worstDay==null?"—":pct(worstDay), 'var(--red)')+
    stat("Max drawdown", maxDD?pct(maxDD*100):"—", 'var(--red)')+
    stat("Volatility (ann.)", vol?vol.toFixed(0)+"%":"—");
  state.chartLoaded=true;
}
/* debounced chart refresh (#12) */
let chartDebounce=null;
function refreshChartsSoon(){ clearTimeout(chartDebounce); chartDebounce=setTimeout(()=>{ if(state.chartLoaded && state.hist) drawChart(state.hist); },180); }

/* ---------- refresh cycle ---------- */
async function refresh(manual){
  const btn=$("#refreshBtn"); btn.classList.add("spin");
  try{
    await Promise.all([fetchPrices(), state.fx.PLN==null?fetchFX():Promise.resolve()]);
    state.offline=false;
    render();
    if(manual){ btn.classList.add("ok"); setTimeout(()=>btn.classList.remove("ok"),700); }
  }catch(e){
    state.offline=true; loadCachedPrices(); render();
  }finally{ setTimeout(()=>btn.classList.remove("spin"),400); updateFreshness(); }
}
function render(){ renderSummaryTab(); renderCards(); renderTable(); }
function startAuto(){ stopAuto(); if(state.auto){ state.timer=setInterval(()=>refresh(false),15000);}
  $("#autoState").textContent=state.auto?"auto 15s":"auto off"; $("#autoState").className=state.auto?"auto-on":"auto-off"; }
function stopAuto(){ if(state.timer){clearInterval(state.timer);state.timer=null;} }

/* ---------- nav ---------- */
function switchView(name){
  const doIt=()=>{ $$(".view").forEach(v=>v.classList.remove("active"));
    $("#view-"+name).classList.add("active");
    $$(".bottom-nav button").forEach(b=>b.classList.toggle("active", b.dataset.nav===name));
    if(name==="chart" && !state.chartLoaded) loadChart(); };
  // View Transitions API (#8) with reduced-motion respect
  if(document.startViewTransition && !REDUCE_MOTION){ document.startViewTransition(doIt); } else { doIt(); }
}

/* ---------- export CSV + share (#8) ---------- */
function currentRowsForExport(){
  const opt=state.tableOpt;
  return state.data.assets.map(a=>{
    const px=state.prices[a.asset];
    const units=opt===3?a.deployed_units:a.quantity;
    const value=px!=null?units*px:null;
    const unreal=value!=null?value-a.cost_basis:null;
    const ret=(a.cost_basis>0&&unreal!=null)?unreal/a.cost_basis*100:null;
    return {asset:a.asset,units,cost:a.cost_basis,price:px,value,unreal,ret};
  }).sort((x,y)=>(y.value??-1)-(x.value??-1));
}
function exportCSV(){
  const rows=currentRowsForExport(); const rt=rate(); const ccy=state.ccy;
  // CSV cell sanitizer: quote always; escape quotes; neutralize formula-injection leaders (= + - @ tab CR)
  const cell=(x)=>{ let s=String(x==null?"":x);
    if(/^[=+\-@\t\r]/.test(s)) s="'"+s;      // leading apostrophe defuses spreadsheet formulas
    return '"'+s.replace(/"/g,'""')+'"'; };
  const head=["Asset","Quantity",`Cost(${ccy})`,`Price(${ccy})`,`Value(${ccy})`,`ProfitLoss(${ccy})`,"Return%"];
  const lines=[head.map(cell).join(",")];
  for(const r of rows){ lines.push([r.asset, r.units,
    (r.cost*rt).toFixed(2), r.price!=null?(r.price*rt).toFixed(8):"",
    r.value!=null?(r.value*rt).toFixed(2):"", r.unreal!=null?(r.unreal*rt).toFixed(2):"",
    r.ret!=null?r.ret.toFixed(1):""].map(cell).join(",")); }
  const blob=new Blob([lines.join("\n")],{type:"text/csv"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download=`portfolio_${state.tableOpt===3?"invested":"all"}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function shareSnapshot(){
  const t=computeForView(state.tableOpt);
  const txt=`My crypto portfolio — value ${fmtMoney(t.v)}, P/L ${fmtMoney(t.u)} (${pct(t.ret)}). `+
            `Cost basis ${fmtMoney(t.c)}.`;
  try{
    if(navigator.share){ await navigator.share({title:"Crypto Portfolio", text:txt}); return; }
  }catch(e){ if(e && e.name==="AbortError") return; }
  // fallback: copy to clipboard
  try{ await navigator.clipboard.writeText(txt); toast("Summary copied to clipboard"); }
  catch(e){ toast("Sharing not supported on this device"); }
}
function toast(msg){
  let el=$("#toast"); if(!el){ el=document.createElement("div"); el.id="toast"; el.className="toast"; document.body.appendChild(el); }
  el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2200);
}

function wire(){
  $("#nav").addEventListener("click",e=>{const b=e.target.closest("button"); if(b) switchView(b.dataset.nav);});
  $("#ccyToggle").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b)return;
    state.ccy=b.dataset.ccy; $$("#ccyToggle button").forEach(x=>x.classList.toggle("active",x===b));
    render(); refreshChartsSoon();});
  const setView = (v) => { state.view=v;
    $$("#viewSwitch button,#viewSwitch2 button").forEach(x=>x.classList.toggle("active", +x.dataset.view===v));
    renderSummaryTab(); renderCards(); };
  $("#viewSwitch").addEventListener("click",e=>{const b=e.target.closest("button"); if(b) setView(+b.dataset.view);});
  $("#viewSwitch2").addEventListener("click",e=>{const b=e.target.closest("button"); if(b) setView(+b.dataset.view);});
  $("#tableTabs").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b)return;
    state.tableOpt=+b.dataset.t; $$("#tableTabs button").forEach(x=>x.classList.toggle("active",x===b)); renderTable();});
  // sortable headers (#3)
  $("#mainTable thead").addEventListener("click",e=>{const th=e.target.closest("th[data-sort]"); if(!th)return;
    const k=th.dataset.sort; if(state.sortKey===k) state.sortDir*=-1; else{ state.sortKey=k; state.sortDir=(k==="asset")?1:-1; } renderTable();});
  $("#refreshBtn").addEventListener("click",()=>refresh(true));
  $("#autoToggle").addEventListener("change",e=>{state.auto=e.target.checked; startAuto();});

  // card search + sort + density (#5, #6, #11)
  const cs=$("#cardSearch"); if(cs) cs.addEventListener("input",e=>{ state.cardQuery=e.target.value; renderCards(); });
  const cso=$("#cardSort"); if(cso) cso.addEventListener("change",e=>{ state.cardSort=e.target.value; renderCards(); });
  const db=$("#densityBtn"); if(db) db.addEventListener("click",()=>{ state.density=state.density==="compact"?"cozy":"compact";
    try{localStorage.setItem("density",state.density);}catch(_){} db.classList.toggle("on",state.density==="compact"); renderCards(); });
  // table search (#5)
  const ts2=$("#tableSearch"); if(ts2) ts2.addEventListener("input",e=>{ state.tableQuery=e.target.value; renderTable(); });
  // export CSV + share (#8)
  const ex=$("#exportCsvBtn"); if(ex) ex.addEventListener("click",exportCSV);
  const sh=$("#shareBtn"); if(sh) sh.addEventListener("click",shareSnapshot);

  // detail sheet open/close (#1)
  const openFromEl=(el)=>{ const s=el&&el.dataset&&el.dataset.asset; if(s) openDetail(s); };
  $("#cards").addEventListener("click",e=>openFromEl(e.target.closest(".card")));
  $("#sumWinners").addEventListener("click",e=>openFromEl(e.target.closest(".mini")));
  $("#sumLosers").addEventListener("click",e=>openFromEl(e.target.closest(".mini")));
  $("#mainTable tbody").addEventListener("click",e=>openFromEl(e.target.closest("tr[data-asset]")));
  $("#detailClose").addEventListener("click",closeDetail);
  $("#detailBackdrop").addEventListener("click",closeDetail);
  // swipe-down to dismiss the detail sheet (#7)
  (function(){ const sheet=$("#detailSheet"); if(!sheet) return; let sy=0, dy=0, drag=false;
    sheet.addEventListener("touchstart",e=>{ if(sheet.scrollTop>0) return; sy=e.touches[0].clientY; drag=true; dy=0; },{passive:true});
    sheet.addEventListener("touchmove",e=>{ if(!drag) return; dy=e.touches[0].clientY-sy;
      if(dy>0){ sheet.style.transform=`translateY(${dy}px)`; sheet.style.transition="none"; } },{passive:true});
    sheet.addEventListener("touchend",()=>{ if(!drag) return; drag=false; sheet.style.transition="";
      if(dy>90){ closeDetail(); } sheet.style.transform=""; dy=0; },{passive:true});
  })();

  // text size
  const applyScale=(s)=>{ document.documentElement.style.setProperty("--type-scale", s);
    $$("#textSize button").forEach(b=>b.classList.toggle("active", b.dataset.scale===String(s))); refreshChartsSoon(); };
  $("#textSize").addEventListener("click",e=>{const b=e.target.closest("button"); if(!b)return;
    applyScale(b.dataset.scale); try{localStorage.setItem("type_scale",b.dataset.scale);}catch(_){}} );

  // onboarding dismiss (#6)
  const ob=$("#onboard"); if(ob){ const dismiss=()=>{ ob.classList.remove("show"); try{localStorage.setItem("onboarded","1");}catch(_){}}; 
    $("#obClose").addEventListener("click",dismiss); const g=$("#obGo"); if(g) g.addEventListener("click",dismiss); }

  // pull-to-refresh
  const ptr=$("#ptr"); let startY=0, pulling=false, dist=0; const THRESH=70;
  window.addEventListener("touchstart",e=>{ if(window.scrollY<=0 && e.touches.length===1){ startY=e.touches[0].clientY; pulling=true; dist=0; } },{passive:true});
  window.addEventListener("touchmove",e=>{ if(!pulling) return; dist=e.touches[0].clientY-startY;
    if(dist>0 && window.scrollY<=0){ const p=Math.min(dist/THRESH,1.3); ptr.classList.add("show");
      ptr.style.transform=`translateX(-50%) scale(${0.6+p*0.4})`+(REDUCE_MOTION?"":` rotate(${dist}deg)`); } },{passive:true});
  window.addEventListener("touchend",async()=>{ if(!pulling) return; pulling=false;
    if(dist>THRESH){ ptr.classList.add("spin"); await refresh(true); ptr.classList.remove("spin"); }
    ptr.classList.remove("show"); ptr.style.transform="translateX(-50%) scale(.6)"; dist=0; },{passive:true});

  // table fade on scroll
  const ts=$("#tableScroll"), tw=ts&&ts.querySelector(".table-wrap");
  if(tw){ tw.addEventListener("scroll",updateTableFade,{passive:true}); }

  // online/offline
  window.addEventListener("online",()=>{ state.offline=false; refresh(false); });
  window.addEventListener("offline",()=>{ state.offline=true; updateFreshness(); });

  // CSV import
  const files={bal:null,led:null,trd:null};
  const check=()=>{$("#recomputeBtn").disabled=!(files.bal&&files.led&&files.trd);};
  const hook=(inp,name,key)=>{$(inp).addEventListener("change",ev=>{const f=ev.target.files[0]; files[key]=f; $(name).textContent=f?f.name:"none"; check();});};
  hook("#fileBal","#nameBal","bal"); hook("#fileLed","#nameLed","led"); hook("#fileTrd","#nameTrd","trd");
  $("#recomputeBtn").addEventListener("click",async()=>{
    const msg=$("#importMsg"); msg.className="msg"; msg.textContent="Computing…";
    try{
      const [b,l,t]=await Promise.all([files.bal.text(),files.led.text(),files.trd.text()]);
      const res=window.PortfolioEngine.analyze(b,l,t);
      for(const a of res.assets){ if(!a.cg_id) a.cg_id=a.asset.toLowerCase(); }
      res.generated=new Date().toISOString().slice(0,10);
      state.data=res; state.hist=null;
      try{ localStorage.setItem("user_data", JSON.stringify(res)); }catch(e){}
      $("#dataSource").textContent="your imported CSV ("+res.generated+")";
      reconMsg(); await refresh(true); msg.className="msg ok"; msg.textContent=`Recomputed ${res.assets.length} assets. Cost basis ${fmtMoney(res.assets.reduce((s,a)=>s+a.cost_basis,0))}.`;
    }catch(e){ msg.className="msg err"; msg.textContent="Error: "+e.message; }
  });
  $("#resetBtn").addEventListener("click",async()=>{
    localStorage.removeItem("user_data"); state.hist=null; await loadBundled(); await refresh(true);
    $("#importMsg").className="msg ok"; $("#importMsg").textContent="Reset to bundled snapshot.";
  });
}

/* ---------- init ---------- */
async function init(){
  loadPrefs();
  try{ const s=localStorage.getItem("type_scale"); if(s) document.documentElement.style.setProperty("--type-scale",s); }catch(_){}
  wire();
  const db=$("#densityBtn"); if(db) db.classList.toggle("on",state.density==="compact");
  try{ const s=localStorage.getItem("type_scale")||"1"; $$("#textSize button").forEach(b=>b.classList.toggle("active",b.dataset.scale===s)); }catch(_){}
  // onboarding (first run)
  try{ if(!localStorage.getItem("onboarded")){ const ob=$("#onboard"); if(ob) ob.classList.add("show"); } }catch(_){}

  let loaded=false;
  try{ const u=JSON.parse(localStorage.getItem("user_data")||"null"); if(u&&u.assets){ state.data=u; $("#dataSource").textContent="your imported CSV ("+(u.generated||"")+")"; reconMsg(); loaded=true; } }catch(e){}
  if(!loaded) await loadBundled();
  loadCachedPrices();
  render();
  await refresh(true);
  startAuto();
  // tick the "updated Ns ago" label
  state.freshTimer=setInterval(updateFreshness,10000);
  // warm the history cache in the background so sparklines + chart are ready
  loadChart(true);
  if("serviceWorker" in navigator){ try{ await navigator.serviceWorker.register("./sw.js"); }catch(e){} }
}
window.PortfolioEngine = window.PortfolioEngine || {};
document.addEventListener("DOMContentLoaded", init);
})();
