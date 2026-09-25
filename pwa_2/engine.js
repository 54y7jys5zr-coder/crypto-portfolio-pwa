/* Portfolio FIFO cost engine — JS port of the validated Python engine.
   Same rules: units = amount - fee; wrapper folding; strict chronological FIFO;
   staking/earn/gifts = zero cost; withdrawals retain cost as external; derive residual as zero-cost.
   Regression checkpoints (EUR): total cost basis 4354.14, net deposited 3553.24, realized 978.24. */

const CG_ID_OVERRIDES = {
  BTC:"bitcoin",ETH:"ethereum",LTC:"litecoin",ADA:"cardano",DOT:"polkadot",ATOM:"cosmos",
  ALGO:"algorand",ARB:"arbitrum",AKT:"akash-network",EIGEN:"eigenlayer",FET:"fetch-ai",
  LINK:"chainlink",MINA:"mina-protocol",PEPE:"pepe",POL:"polygon-ecosystem-token",
  RENDER:"render-token",SUPER:"superfarm",XRP:"ripple"
};
const SPECIAL = {ETH2:"ETH","ETH2.S":"ETH","BTC.M":"BTC",MATIC:"POL","MATIC.S":"POL","MATIC04.S":"POL",RNDR:"RENDER"};

function baseAsset(a){
  if(a==null) return null;
  a=String(a);
  if(SPECIAL[a]) return SPECIAL[a];
  if(a.includes(".")){ let h=a.split(".")[0].replace(/\d+$/,""); return SPECIAL[h]||h; }
  return a;
}
function tsec(s){ return String(s).split(".")[0]; }
function ptime(s){
  if(!s) return 0;
  // normalize "YYYY-MM-DD HH:MM:SS[.f]" -> Date
  const t = Date.parse(String(s).replace(" ","T"));
  return isNaN(t) ? 0 : t;
}
function tonum(v){
  if(v==null||v==="") return 0;
  if(typeof v==="number") return v;
  const n=parseFloat(String(v).replace(/,/g,""));
  return isNaN(n)?0:n;
}
function norm(h){ return h==null?"":String(h).toLowerCase().replace(/[^a-z0-9]/g,""); }

/* CSV parser (handles quoted fields, commas, newlines). Returns {header, rows}. */
function parseCSV(text){
  const rows=[]; let field="",row=[],inq=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inq){
      if(c=='"'){ if(text[i+1]=='"'){field+='"';i++;} else inq=false; }
      else field+=c;
    } else {
      if(c=='"') inq=true;
      else if(c==','){ row.push(field); field=""; }
      else if(c=='\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else if(c=='\r'){ /* skip */ }
      else field+=c;
    }
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  const header=rows.shift()||[];
  return {header, rows: rows.filter(r=>r.length>1 || (r.length===1 && r[0]!==""))};
}

const SPEC = {
  balances:{asset:["asset"],wallet:["wallet"],quantity:["quantity","balance","amount","vol"]},
  ledger:{time:["time"],type:["type"],subtype:["subtype"],asset:["asset"],amount:["amount"],fee:["fee"]},
  trades:{pair:["pair"],time:["time"],type:["type"],cost:["cost"],fee:["fee"],vol:["vol","volume"]}
};
const OPTIONAL=new Set(["subtype"]);

function mapper(header, spec, label){
  const nh=header.map(norm), idx={};
  for(const [logical,aliases] of Object.entries(spec)){
    let found=-1;
    for(const al of aliases){ const j=nh.indexOf(norm(al)); if(j>=0){found=j;break;} }
    idx[logical]=found;
  }
  const missing=Object.entries(idx).filter(([k,v])=>v<0 && !OPTIONAL.has(k)).map(([k])=>k);
  if(missing.length) throw new Error(`${label}: missing columns ${missing.join(", ")}. Headers: ${header.join(", ")}`);
  return (row,name)=>{ const i=idx[name]; if(i<0||i>=row.length) return null; const v=row[i]; return v===""?null:v; };
}

/* Main engine: takes {balancesText, ledgerText, tradesText} CSV strings.
   Returns {assets, meta, warnings}. Mirrors Python analyze(). */
function analyze(balancesText, ledgerText, tradesText){
  const B=parseCSV(balancesText), L=parseCSV(ledgerText), T=parseCSV(tradesText);
  const bc=mapper(B.header,SPEC.balances,"Balances");
  const lc=mapper(L.header,SPEC.ledger,"Ledger");
  const tc=mapper(T.header,SPEC.trades,"Trades");

  // balances ground truth
  const bal={};
  for(const r of B.rows){ const a=bc(r,"asset"); if(a==null||a==="Total") continue;
    const b=baseAsset(a); bal[b]=(bal[b]||0)+tonum(bc(r,"quantity")); }

  // trades index: (timesec, base) -> queue of {cost,fee,typ,quote}
  const idx=new Map();
  for(const r of T.rows){ const pair=tc(r,"pair"); if(!pair||!String(pair).includes("/")) continue;
    const [bb,q]=String(pair).split("/"); const key=tsec(tc(r,"time"))+"|"+baseAsset(bb);
    if(!idx.has(key)) idx.set(key,[]);
    idx.get(key).push({cost:tonum(tc(r,"cost")),fee:tonum(tc(r,"fee")),typ:tc(r,"type"),quote:q}); }
  function eurCost(t,b){
    let k=tsec(t)+"|"+b; if(idx.get(k)&&idx.get(k).length) return idx.get(k).shift();
    const bt=ptime(t);
    for(const d of [1,-1,2,-2,3,-3]){ const kk=tsec(new Date(bt+d*1000).toISOString().replace("T"," ").slice(0,19))+"|"+b;
      if(idx.get(kk)&&idx.get(kk).length) return idx.get(kk).shift(); }
    return null;
  }

  // events sorted by time (stable via index)
  const evts=L.rows.map((r,i)=>({t:ptime(lc(r,"time")),i,r})).sort((x,y)=> x.t-y.t || x.i-y.i);

  const lots={}, realized={}, rewardU={}, giftU={}, extU={}, extB={};
  const pend=[];
  const push=(o,k,v)=>{o[k]=(o[k]||0)+v;};
  function consume(a,u){
    let rc=0,need=u; const dq=lots[a]||(lots[a]=[]);
    while(need>1e-12 && dq.length){ const lot=dq[0]; const take=Math.min(lot[0],need); rc+=take*lot[1];
      lot[0]-=take; need-=take; if(lot[0]<=1e-12) dq.shift(); }
    return rc;
  }
  for(const {r} of evts){
    const typ=lc(r,"type"), sub=lc(r,"subtype"), asset=lc(r,"asset");
    const amt=tonum(lc(r,"amount")), fee=tonum(lc(r,"fee")); const b=baseAsset(asset);
    if(b==null||b==="EUR") continue;
    const net=amt-fee; (lots[b]||(lots[b]=[]));
    if(typ==="trade"){
      if(amt>0){
        const m=eurCost(lc(r,"time"),b);
        if(m && m.quote==="EUR"){ const eur=m.cost+m.fee; lots[b].push([net, net?eur/net:0]); }
        else if(m && m.quote!=="EUR"){ const lot=[net,0]; lots[b].push(lot); pend.push([b,lot]); }
        else lots[b].push([net,0]);
      } else {
        const m=eurCost(lc(r,"time"),b); const rc=consume(b,Math.abs(net));
        if(m && m.quote==="EUR"){ push(realized,b,(m.cost-m.fee)-rc); }
        else if(pend.length){ const [,lot]=pend.shift(); lot[1]=lot[0]?rc/lot[0]:0; }
      }
    } else if(typ==="staking" && (sub==null||sub==="")){ lots[b].push([net,0]); push(rewardU,b,net); }
    else if(typ==="earn" && sub==="reward"){ lots[b].push([net,0]); push(rewardU,b,net); }
    else if(typ==="deposit"){ lots[b].push([amt,0]); push(giftU,b,amt); }
    else if(typ==="withdrawal"){ const rc=consume(b,Math.abs(amt)); push(extU,b,Math.abs(amt)); push(extB,b,rc); }
    // else: internal transfer/allocation/migration -> ignore
  }
  const onB={}, survC={}, survZ={};
  for(const [a,dq] of Object.entries(lots)){ for(const [u,c] of dq){ push(onB,a,u*c); if(c>0) push(survC,a,u); else push(survZ,a,u);} }

  // EUR flows
  let dep=0,wd=0;
  for(const r of L.rows){ if(baseAsset(lc(r,"asset"))!=="EUR") continue;
    const typ=lc(r,"type"), amt=tonum(lc(r,"amount"));
    if(typ==="deposit") dep+=amt; else if(typ==="withdrawal") wd+=Math.abs(amt); }

  const assets=[], warnings=[];
  for(const a of Object.keys(bal).sort()){
    if(a==="EUR") continue;
    const q=bal[a], basis=(onB[a]||0)+(extB[a]||0);
    let depU=(survC[a]||0)+(extU[a]||0);
    let zeroU=(survZ[a]||0);
    const reconstructed=(survC[a]||0)+(survZ[a]||0)+(extU[a]||0);
    const residual=q-reconstructed;
    if(Math.abs(residual) > Math.max(1e-6, q*1e-6)){ zeroU+=residual; warnings.push({asset:a,quantity:q,reconstructed,residual_zero_cost:residual}); }
    assets.push({asset:a, cg_id:CG_ID_OVERRIDES[a]||a.toLowerCase(), quantity:q, cost_basis:basis,
                 deployed_units:depU, zero_cost_units:zeroU, realized:realized[a]||0});
  }
  assets.sort((x,y)=>y.cost_basis-x.cost_basis);
  const meta={total_deposited:dep,total_withdrawn:wd,net_deposited:dep-wd,
              eur_remaining:bal["EUR"]||0, total_realized:assets.reduce((s,a)=>s+a.realized,0)};
  return {assets, meta, warnings};
}

if(typeof module!=="undefined" && module.exports) module.exports={analyze, parseCSV, baseAsset};
if(typeof window!=="undefined") window.PortfolioEngine={analyze, parseCSV, baseAsset};
