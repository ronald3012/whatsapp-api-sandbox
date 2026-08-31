import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o?{...o,headers:{'content-type':'application/json'}}:undefined).then(x=>x.json());
const cuentas=await api('/panel/cuentas');
const cuenta=cuentas.find(c=>/webhook\/channels\//.test(c.webhook_url||''))||cuentas[0];
const NUM=cuenta.numeros[0].id;
const wa=(await api(`/panel/numeros/${NUM}/contactos`))[0].wa_id;

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'light'})).newPage();
await pag.addInitScript(()=>{ try{localStorage.removeItem('wa-sandbox-vistos');}catch{} });
const reqs=[]; pag.on('request',(r)=>{ if(r.url().includes('/panel/')&&!r.url().includes('/eventos')) reqs.push(r.url()); });
const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,140)));
await pag.goto(S,{waitUntil:'networkidle'}); await pag.waitForTimeout(1500);
for (let i=0;i<4;i++){ if((await pag.locator('#negNombre').innerText())===cuenta.nombre) break;
  await pag.locator('#selNegocio').click(); await pag.waitForTimeout(700); }
await pag.waitForTimeout(1000);

// ── LA MEDIDA: 20 segundos con la pantalla quieta ──
reqs.length = 0;
await pag.waitForTimeout(20000);
const enReposo = reqs.length;
ok(enReposo <= 2, `pantalla quieta 20s → ${enReposo} requests (antes: ~20 en ese lapso)`);

// ── y aun así, lo que pasa llega SOLO ──
await pag.locator(`.chat[data-wa="${wa}"]`).click(); await pag.waitForTimeout(800);
const antes = await pag.locator('#hilo .b').count();
await api(`/panel/numeros/${NUM}/entrante`,{method:'POST',body:JSON.stringify({waId:wa,texto:'llegando por el rio '+Date.now()})});
await pag.waitForTimeout(2500);
ok(await pag.locator('#hilo .b').count() > antes, 'el mensaje aparece solo, empujado por SSE');

// el «escribiendo…» del agente llega como evento (cuando el agente conteste)
let escribio=false, contesto=false;
for(let i=0;i<16;i++){ await pag.waitForTimeout(4000);
  if(!escribio && (await pag.locator('#escribiendo').innerText()).includes('escribiendo')) escribio=true;
  const ms=await api(`/panel/numeros/${NUM}/mensajes?waId=${wa}`);
  if(ms[ms.length-1]?.direccion==='saliente' && ms[ms.length-1].cuando>Date.now()-70000){ contesto=true;
    await pag.waitForTimeout(1500);
    ok((await pag.locator('#hilo').innerText()).includes(ms[ms.length-1].texto.slice(0,25)), 'la respuesta del agente entra sola al hilo');
    break; }
}
ok(contesto, 'el agente contestó durante la prueba');
console.log(escribio ? '   («escribiendo…» se vio en vivo)' : '   (el escribiendo no alcanzó a verse — depende del timing del agente)');

// globo en chat cerrado, ahora por evento
await pag.locator('#chats .chat').nth(2).click(); await pag.waitForTimeout(600);
await api(`/panel/numeros/${NUM}/entrante`,{method:'POST',body:JSON.stringify({waId:wa,texto:'globo por evento'})});
let globo=false;
for(let i=0;i<16;i++){ await pag.waitForTimeout(4000);
  if(await pag.locator(`.chat[data-wa="${wa}"] .globo`).count()){ globo=true; break; } }
ok(globo, 'el globo verde aparece solo cuando contesta con el chat cerrado');
ok(errs.length===0, `sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);
await pag.screenshot({path:`${C}/sse.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
