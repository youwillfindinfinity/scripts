
 // ==UserScript==
 // @name         PT118 Smart Market Balancer (Shinko-style)
 // @namespace    local.pt118.marketbalancer
 // @version      1.0.0
 // @description  Compare fastest own-village routes, rank existing trade offers, and prefill balanced 1:1 offers. Manual dispatch only.
 // @match        https://pt118.tribalwars.com.pt/game.php*
 // @grant        none
 // @run-at       document-idle
 // ==/UserScript==

 (() => {
   'use strict';
   if (document.querySelector('#stkm-balancer')) return;

   // Familiar Warehouse Balancer concepts; this is a NEW implementation,
   // not a modification of Shinko to Kuma's original source.
   const DEFAULTS = {
     highFarm: 0.93, lowPoints: 3000,
     highPoints: 9000, builtOutPercentage: 25,
     needsMorePercentage: 85,
     merchantReserve: 1, merchantMinutesPerField: 10,
     maxRouteHours: 3, maxDistance: 25,
     minShipment: 1000, minReceiveRatio: 1,
     keepOfferPercentage: 20, offerMaxTime: 3
   };
   const STORAGE_KEY = 'pt118_smart_balancer_v1';
   const TYPES = ['wood','stone','iron'];
   const NAMES = {wood:'Madeira',stone:'Argila',iron:'Ferro'};
   const $ = (s,root=document) => root.querySelector(s);
   const $$ = (s,root=document) => Array.from(root.querySelectorAll(s));
   const number = x => Number(String(x ?? '').replace(/[^0-9]/g,''));
   const fmt = n => Math.round(n).toLocaleString('pt-PT');
   let settings = {...DEFAULTS};
   try { settings = {...settings,...JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}; }
   catch (_) {}
   let villages = [];
   let transports = [];

   // ---------- Reading Shinko-style production overview ----------
   function readVillages(html) {
     const doc = typeof html === 'string'
       ? new DOMParser().parseFromString(html,'text/html') : html;
     const result = [];
     for (const el of $$('.quickedit-vn',doc)) {
       const row = el.closest('tr');
       if (!row) continue;
       const resources = {};
       let valid = true;
       for (const key of TYPES) {
         const cls = key === 'stone' ? 'stone' : key;
         const span = $(`.res.${cls},.warn_90.${cls},.warn.${cls},.m${cls}`,row);
         const n = span ? number(span.textContent) : NaN;
         if (!Number.isFinite(n) || !span) {valid=false;break;}
         resources[key] = n;
       }
       if (!valid) continue;
       const coord = el.textContent.match(/(\d{1,3})\|(\d{1,3})/);
       const id = el.dataset.id || el.closest('[data-id]')?.dataset.id;
       const ironCell = $('.res.iron,.warn_90.iron,.warn.iron,.miron',row)?.closest('td');
       const warehouseCell = ironCell?.nextElementSibling;
       const merchantsCell = warehouseCell?.nextElementSibling;
       const storage = number(warehouseCell?.textContent);
       const merchantsMatch = merchantsCell?.textContent.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
       const freeMerchants = merchantsMatch ? number(merchantsMatch[1]) : NaN;
       const popCell = merchantsCell?.nextElementSibling;
       const popMatch = popCell?.textContent.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
       const farmRatio = popMatch ? number(popMatch[1]) / Math.max(1,number(popMatch[2])) : null;
       const pointEl = $('.points',row);
       const pointsCell = el.closest('td')?.nextElementSibling;
       const points = pointEl ? number(pointEl.textContent) :
         (pointsCell && /^[\d.,\s]+$/.test(pointsCell.textContent.trim()) ? number(pointsCell.textContent) : 0);
       if (!id || !coord || !storage || !Number.isFinite(freeMerchants)) continue;
       result.push({
         id:String(id), coord:`${coord[1]}|${coord[2]}`,
         x:+coord[1], y:+coord[2], name:el.textContent.trim(),
         resources, storage, freeMerchants, farmRatio, points
       });
     }
     return result;
   }

   function finished(v) {
     return (settings.highPoints > 0 && v.points >= settings.highPoints) ||
       (v.farmRatio != null && v.farmRatio >= settings.highFarm);
   }
   function distance(a,b) {return Math.hypot(a.x-b.x,a.y-b.y);}
   function tripHours(a,b) {return distance(a,b)*settings.merchantMinutesPerField/60;}

   // Calculate balance targets from per-resource account totals. A developing
   // village below lowPoints gets a higher share; cap its target by storage.
   function buildTargets(list) {
     const weights = list.map(v => finished(v) ? 0.08 :
       (v.points > 0 && v.points < settings.lowPoints ? 1.5 : 1));
     const sumWeights = weights.reduce((a,b)=>a+b,0) || 1;
     const totals = Object.fromEntries(TYPES.map(k=>[k,list.reduce((s,v)=>s+v.resources[k],0)]));
     return list.map((v,i)=>({
       ...v, stock:{...v.resources}, merchants:Math.max(0,v.freeMerchants-settings.merchantReserve),
       finished:finished(v),
       target:Object.fromEntries(TYPES.map(k=>[
         k, finished(v) ? 0 : Math.min(
           Math.floor(v.storage*settings.needsMorePercentage/100),
           Math.floor(totals[k]*weights[i]/sumWeights)
         )
       ])),
       moved:{wood:0,stone:0,iron:0}
     }));
   }

   function planTransfers(villageList) {
     const list = buildTargets(villageList);
     const edges = [];
     for (const source of list) for (const target of list) {
       if (source.id === target.id || target.finished) continue;
       const d = distance(source,target), t = tripHours(source,target);
       if (d > settings.maxDistance || t > settings.maxRouteHours) continue;
       const priority = (target.points > 0 && target.points < settings.lowPoints) ? 0.85 : 1;
       edges.push({source,target,distance:d,hours:t,rank:t*priority});
     }
     edges.sort((a,b)=>a.rank-b.rank || a.distance-b.distance);
     const moves = [];
     for (const e of edges) {
       const {source:s,target:r} = e;
       const maxCarry = s.merchants * 1000;
       if (maxCarry < settings.minShipment) continue;
       const amounts = {wood:0,stone:0,iron:0};
       const possible = {};
       for (const key of TYPES) {
         // Keep sufficient stock in the donor while respecting both
         // target demand and the receiver's individual resource cap.
         const floor = s.finished ? s.storage*settings.builtOutPercentage/100 :
           Math.max(s.target[key],s.storage*settings.builtOutPercentage/100);
         possible[key] = Math.max(0,Math.floor(Math.min(
           s.stock[key]-floor,
           r.target[key]-r.stock[key],
           r.storage-r.stock[key]
         )));
       }
       const totalPossible = TYPES.reduce((sum,k)=>sum+possible[k],0);
       const allocatable = Math.min(maxCarry,totalPossible);
       if (allocatable <= 0) continue;
       // Proportional shares prevent the closest receiver consuming
       // every merchant on only one resource.
       for (const key of TYPES) {
         amounts[key] = Math.floor(allocatable*possible[key]/totalPossible);
       }
       let remainder = allocatable-TYPES.reduce((sum,k)=>sum+amounts[k],0);
       for (const key of [...TYPES].sort((a,b)=>(possible[b]-amounts[b])-(possible[a]-amounts[a]))) {
         if (remainder<=0) break;
         const extra=Math.min(remainder,possible[key]-amounts[key]);
         amounts[key]+=extra;remainder-=extra;
       }
       const volume = TYPES.reduce((sum,k)=>sum+amounts[k],0);
       if (volume < settings.minShipment) continue;
       const merchantCount = Math.ceil(volume/1000);
       s.merchants -= merchantCount;
       for (const key of TYPES) {
         s.stock[key] -= amounts[key];
         r.stock[key] += amounts[key];
       }
       moves.push({source:s,target:r,amounts,volume,merchantCount,
         distance:e.distance,hours:e.hours});
     }
     return moves;
   }

   // ---------- Current village / offers ----------
   function getCurrentStock() {
     const gd = window.game_data?.village || {};
     const res = {};
     for (const key of TYPES) {
       const id = key === 'stone' ? 'stone' : key;
       const el = document.getElementById(id);
       const raw = el ? number(el.textContent) : Number(gd[key]);
       if (!Number.isFinite(raw) || raw < 0) return null;
       res[key] = raw;
     }
     const storageEl = $('#storage');
     const storage = storageEl ? number(storageEl.textContent) : Number(gd.storage_max);
     return {res,storage:Number.isFinite(storage)&&storage>0 ? storage : null};
   }
   function variation(res) {
     const avg = TYPES.reduce((sum,k)=>sum+res[k],0)/3;
     return TYPES.reduce((sum,k)=>sum+(res[k]-avg)**2,0);
   }
   function durationHours(text) {
     const match = String(text||'').match(/\b(\d{1,3}):(\d{2})(?::(\d{2}))?\b/);
     return match ? Number(match[1]) + Number(match[2])/60 + Number(match[3]||0)/3600 : null;
   }
   function cellResource(cell) {
     const icon = cell.querySelector('.icon.wood,.icon.stone,.icon.iron,img[src*="wood"],img[src*="stone"],img[src*="iron"]');
     const cls = icon?.className?.baseVal || icon?.className || '';
     const source = String(cls)+' '+String(icon?.getAttribute('src')||'');
     return TYPES.find(k=>new RegExp(`(^|[ ./_-])${k}($|[ ./_-])`,'i').test(source)) || null;
   }
   function scanOffers() {
     const st = getCurrentStock();
     if (!st) throw Error('Could not read this village’s stock levels.');
     const offers = [];
     for (const tr of $$('#content_value tr')) {
       const cells = [...tr.cells];
       const resCells = cells.map(cell=>({key:cellResource(cell),cell})).filter(x=>x.key);
       if (resCells.length < 2) continue;
       const [receive,pay] = resCells;
       if (receive.key === pay.key) continue;
       const receiveAmount = number(receive.cell.textContent);
       const payAmount = number(pay.cell.textContent);
       const hours = durationHours(cells.map(c=>c.textContent).join(' '));
       if (!receiveAmount || !payAmount || hours === null) continue;
       const ratio = receiveAmount/payAmount;
       if (ratio < settings.minReceiveRatio || hours > settings.maxRouteHours) continue;
       if (st.res[pay.key] < payAmount) continue;
       if (st.storage && st.res[receive.key]+receiveAmount > st.storage*0.98) continue;
       const after = {...st.res};
       after[receive.key] += receiveAmount;
       after[pay.key] -= payAmount;
       const improvement = variation(st.res)-variation(after);
       if (improvement <= 0) continue;
       offers.push({receive:receive.key,pay:pay.key,receiveAmount,payAmount,
         ratio,hours,improvement,score:improvement/Math.max(hours,0.1),row:tr});
     }
     return offers.sort((a,b)=>b.score-a.score);
   }

   function suggestOwnOffer() {
     const st = getCurrentStock();
     if (!st || !st.storage) throw Error('Cannot read current stock or warehouse.');
     const order = [...TYPES].sort((a,b)=>st.res[b]-st.res[a]);
     const offer = order[0],want = order[2];
     const spare = st.res[offer]-st.storage*settings.keepOfferPercentage/100;
     const deficit = (st.res[offer]-st.res[want])/2;
     const amount = Math.floor(Math.max(0,Math.min(spare,deficit))/1000)*1000;
     if (amount<1000) throw Error('No sensible 1:1 offer of at least 1000 resources.');
     return {offer,want,amount};
   }
   function setInput(node,value) {
     if (!node) return false;
     if (node.type === 'radio') node.checked = true;
     else node.value = String(value);
     node.dispatchEvent(new Event('input',{bubbles:true}));
     node.dispatchEvent(new Event('change',{bubbles:true}));
     return true;
   }
   function prefillOffer(proposal) {
     const params = new URLSearchParams(location.search);
     if (params.get('screen') !== 'market' || params.get('mode') !== 'own_offer') {
       throw Error('Open Market → Create offer (mode=own_offer) first.');
     }
     const sellRadio = document.getElementById('res_sell_'+proposal.offer);
     const buyRadio = document.getElementById('res_buy_'+proposal.want);
     const sellValue = document.querySelector('input[name="sell"]');
     const buyValue = document.querySelector('input[name="buy"]');
     if (![sellRadio,buyRadio,sellValue,buyValue].every(Boolean)) {
       throw Error('The game’s offer form differs; no fields were modified.');
     }
     setInput(sellRadio,true);setInput(buyRadio,true);
     setInput(sellValue,1000);setInput(buyValue,1000);
     setInput(document.querySelector('input[name="multi"]'),proposal.amount/1000);
     setInput(document.querySelector('input[name="max_time"]'),settings.offerMaxTime);
   }

   // ---------- Interface ----------
   const panel = document.createElement('section');
   panel.id = 'stkm-balancer';
   panel.style.cssText = 'background:#f3e6c5;color:#332615;border:2px solid #9f8154;padding:12px;margin:12px 0;max-width:1100px;font:13px Arial,sans-serif;line-height:1.6';
   const title = document.createElement('h3');
   title.textContent = 'Smart Market Balancer · PT118';
   title.style.cssText = 'margin:0 0 7px;color:#513709';
   const intro = document.createElement('p');
   intro.textContent = 'Own-village routes: shortest first. Existing offers: best balance improvement per travel hour. New offers: 1:1, awaiting acceptance.';
   const opts = document.createElement('div');
   opts.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px 16px;margin-bottom:10px';
   const config = [
     ['lowPoints','Small village below points',1],
     ['highPoints','Finished above points',1],
     ['highFarm','Finished above farm ratio',0.01],
     ['builtOutPercentage','Finished villages retain %',1],
     ['needsMorePercentage','Growing villages target %',1],
     ['merchantReserve','Merchants kept home',1],
     ['merchantMinutesPerField','Merchant min/field (estimate)',0.1],
     ['maxRouteHours','Max delivery hours',0.25],
     ['maxDistance','Max distance (fields)',1],
     ['minShipment','Min transport resources',100],
     ['minReceiveRatio','Min offer received/paid',0.05],
     ['keepOfferPercentage','Keep warehouse % for offers',1],
     ['offerMaxTime','New offer max time (hours)',1]
   ];
   const inputs = {};
   for (const [key,label,step] of config) {
     const l=document.createElement('label');l.textContent=label+' ';
     const input=document.createElement('input');input.type='number';input.step=String(step);
     input.style.cssText='width:65px;margin-left:3px';input.value=String(settings[key]);
     l.appendChild(input);opts.appendChild(l);inputs[key]=input;
   }
   const buttons = document.createElement('div');buttons.style.margin='8px 0';
   const output=document.createElement('div');output.style.cssText='max-height:450px;overflow:auto';
   const status=document.createElement('div');status.style.cssText='font-weight:bold;margin:7px 0';
   function button(label,fn) {const b=document.createElement('button');b.type='button';b.textContent=label;b.className='btn';b.style.margin='0 7px 6px 0';b.addEventListener('click',fn);buttons.appendChild(b);return b;}
   function p(text) {const e=document.createElement('p');e.textContent=text;return e;}
   function clearOutput() {output.replaceChildren();}
   function report(text,isError=false) {status.textContent=text;status.style.color=isError?'#b22828':'#24592d';}
   function updateSettings() {
     for (const [key] of config) {
       const n=Number(inputs[key].value);
       if (!Number.isFinite(n)||n<0) throw Error('Invalid setting: '+key);
       settings[key]=n;
     }
     if (settings.needsMorePercentage>100||settings.builtOutPercentage>100||settings.highFarm>1 ||
         settings.maxRouteHours<=0||settings.merchantMinutesPerField<=0||settings.minReceiveRatio<=0)
       throw Error('Percentage/rate/time out of bounds.');
     try {localStorage.setItem(STORAGE_KEY,JSON.stringify(settings));} catch (_) {}
   }
   async function loadVillages() {
     updateSettings();report('Reading village production overview…');
     const url=new URL('/game.php',location.origin);
     url.searchParams.set('screen','overview_villages');
     url.searchParams.set('mode','prod');url.searchParams.set('page','-1');
     const sitter=window.game_data?.player?.sitter;
     if(sitter>0)url.searchParams.set('t',window.game_data.player.id);
     const resp=await fetch(url.toString(),{credentials:'same-origin'});
     if(!resp.ok)throw Error('Overview unavailable: HTTP '+resp.status);
     villages=readVillages(await resp.text());
     if(villages.length<2) throw Error('Read fewer than two complete village rows. Open Premium → Production overview and verify merchants/warehouse columns. No transfers made.');
     report(`Read ${villages.length} villages. Snapshot only; stock and merchants can change.`);
   }
   function makeTable(headers,rows) {
     const table=document.createElement('table');table.className='vis';
     table.style.cssText='width:100%;border-collapse:collapse;margin:8px 0';
     const head=table.createTHead().insertRow();
     for(const h of headers){const th=document.createElement('th');th.textContent=h;head.appendChild(th);}
     for(const cells of rows){
       const tr=table.insertRow();
       for(const cell of cells){const td=tr.insertCell();
         if(cell instanceof Node)td.appendChild(cell);else td.textContent=String(cell);}
     }
     return table;
   }
   button('Scan villages',async()=>{try{clearOutput();await loadVillages();output.append(p('Scanned villages. Click “Fastest routes” to build a transfer plan.'));}catch(e){report(e.message,true);}});
   button('Fastest routes',async()=>{try{
     clearOutput();await loadVillages();transports=planTransfers(villages);
     if(!transports.length){output.append(p('No eligible transfers within limits. Consider a longer route limit or lower minimum shipment.'));return;}
     const rows=transports.map(m=>{
       const actions=document.createElement('span');
       const link=document.createElement('a');
       link.href=`/game.php?village=${encodeURIComponent(m.source.id)}&screen=market&mode=send`;
       link.textContent='Open transport form';link.style.marginRight='8px';
       const copy=document.createElement('button');copy.type='button';copy.className='btn';copy.textContent='Copy amounts';
       copy.addEventListener('click',async()=>{
         const t=`From ${m.source.coord} to ${m.target.coord}: Wood ${m.amounts.wood}, Clay ${m.amounts.stone}, Iron ${m.amounts.iron}`;
         try{await navigator.clipboard.writeText(t);report('Copied route amounts.');}
         catch(_){window.prompt('Copy this route:',t);}
       });
       actions.append(link,copy);
       return [m.source.coord,m.target.coord,...TYPES.map(k=>fmt(m.amounts[k])),
         m.merchantCount,m.distance.toFixed(1),(m.hours*60).toFixed(0)+' min*',actions];
     });
     output.append(p(`${transports.length} suggested transports; ${fmt(transports.reduce((s,r)=>s+r.volume,0))} resources. Review and send each manually.`));
     output.append(makeTable(['From','To','Wood','Clay','Iron','Merch.','Fields','ETA*','Action'],rows));
     output.append(p('* ETA estimates use the merchant minutes/field setting; actual in-game travel time takes precedence. Incoming transports and production are not included.'));
     report('Shortest eligible direct routes ranked first. No resources sent.');
   }catch(e){report(e.message,true);}});
   button('Rank existing offers',()=>{try{
     updateSettings();clearOutput();
     const offers=scanOffers();
     if(!offers.length){output.append(p('No clearly readable, balance-improving offers on this page. Open Market → Other offers and load the results first. A missing or changed layout is not interpreted as zero available offers.'));return;}
     const rows=offers.map((o,i)=>{
       const show=document.createElement('button');show.type='button';show.className='btn';show.textContent='Review in game';
       show.addEventListener('click',()=>{o.row.scrollIntoView({behavior:'smooth',block:'center'});o.row.style.outline='3px solid #22a16e';});
       return [i+1,`${fmt(o.receiveAmount)} ${NAMES[o.receive]}`,`${fmt(o.payAmount)} ${NAMES[o.pay]}`,
         o.ratio.toFixed(2),o.hours.toFixed(2)+' h',fmt(o.improvement),show];
     });
     output.append(p('Important: verify Offer/For direction and amounts against the original market row before accepting. Recommendations are not trades.'));
     output.append(makeTable(['#','Receive (seller offers)','Pay (seller asks)','Ratio','Delivery','Balance gain','Action'],rows));
     report(`Ranked ${offers.length} candidate offers. No offers accepted.`);
   }catch(e){report(e.message,true);}});
   button('Suggest / prefill new offer',()=>{try{
     updateSettings();clearOutput();const s=suggestOwnOffer();
     output.append(p(`Suggested 1:1 offer: give ${fmt(s.amount)} ${NAMES[s.offer]} in exchange for ${fmt(s.amount)} ${NAMES[s.want]} (${s.amount/1000} lots of 1000).`));
     const prefill=document.createElement('button');prefill.type='button';prefill.className='btn';prefill.textContent='Prefill create-offer form (no submit)';
     prefill.addEventListener('click',()=>{try{prefillOffer(s);report('Offer form filled. Inspect and submit manually.');}catch(e){report(e.message,true);}});
     output.append(prefill,p('Open Market → Create offer to use Prefill. A posted offer is public and only trades after another player accepts.'));
     report('Draft offer calculated. No offer created or posted.');
   }catch(e){report(e.message,true);}});
   button('Close',()=>panel.remove());
   panel.append(title,intro,opts,buttons,status,output);
   const mount=$('#content_value')||$('#contentContainer')||document.body;
   mount.insertAdjacentElement('afterbegin',panel);
   report('Ready. Choose Fastest routes, Rank existing offers, or Suggest / prefill new offer.');
 })();
