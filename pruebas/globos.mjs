import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o?{...o,headers:{'content-type':'application/json'}}:undefined).then(x=>x.json());
const cuentas=await api('/panel/cuentas');
const cuenta=cuentas.find(c=>/webhook\/channels\//.test(c.webhook_url||''))||cuentas[0];
const NUM=cuenta.numeros[0].id;
const ks=await api(`/panel/numeros/${NUM}/contactos`);
const wa=ks[0].wa_id;

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'light'})).newPage();
// empezar con la memoria de vistos limpia, para que la prueba mande
await pag.addInitScript(()=>{ try{localStorage.removeItem('wa-sandbox-vistos');}catch{} });
await pag.goto(S,{waitUntil:'networkidle'}); await pag.waitForTimeout(1500);
for (let i=0;i<4;i++){ if((await pag.locator('#negNombre').innerText())===cuenta.nombre) break;
  await pag.locator('#selNegocio').click(); await pag.waitForTimeout(700); }
await pag.waitForTimeout(1500);

// con la memoria limpia, los chats con respuestas del agente deben traer globo
const globos=await pag.locator('.chat .globo').count();
ok(globos>=1, `hay globitos verdes en los chats con mensajes sin ver (${globos})`);
ok(await pag.locator('.chat.nuevo .n').count()>=1, 'y el nombre va en negrita');

// el primero de la lista debe ser el del mensaje más reciente
const horas=await pag.locator('#chats .chat .h').allInnerTexts();
ok(horas.length>=2, `la lista trae horas (${horas.slice(0,3).join(' | ')})`);

// abrir el chat lo limpia
const chip=await pag.locator(`.chat[data-wa="${wa}"] .globo`).count();
await pag.locator(`.chat[data-wa="${wa}"]`).click(); await pag.waitForTimeout(1200);
ok(await pag.locator(`.chat[data-wa="${wa}"] .globo`).count()===0, 'al abrir el chat, su globo desaparece');

// y si llega respuesta CON EL CHAT CERRADO, el globo vuelve
await pag.locator('.chat').nth(3).click().catch(()=>{}); await pag.waitForTimeout(600); // irse a otro chat
await api(`/panel/numeros/${NUM}/entrante`,{method:'POST',body:JSON.stringify({waId:wa,texto:'probando el globo'})});
console.log('   (esperando la respuesta del agente con el chat cerrado…)');
let volvio=false;
for(let i=0;i<16;i++){ await pag.waitForTimeout(5000);
  if(await pag.locator(`.chat[data-wa="${wa}"] .globo`).count()){ volvio=true; break; } }
ok(volvio, 'cuando el agente contesta con el chat cerrado, el globo aparece solo');

// el filtro No leídos enseña solo esos
await pag.locator('.fil[data-fil="sinleer"]').click(); await pag.waitForTimeout(600);
const enFiltro=await pag.locator('#chats .chat').count();
const conGlobo=await pag.locator('#chats .chat .globo').count();
ok(enFiltro===conGlobo && enFiltro>=1, `el filtro «No leídos» enseña solo los que tienen globo (${enFiltro})`);
await pag.screenshot({path:`${C}/globos.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
