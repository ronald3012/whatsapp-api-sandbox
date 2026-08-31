import { chromium } from 'playwright';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o).then(x=>x.json());
const cuentas=await api('/panel/cuentas');
const cuenta=cuentas.find(c=>/webhook\/channels\//.test(c.webhook_url||''))||cuentas[0];
const numero=cuenta.numeros[0];
const wa=(await api(`/panel/numeros/${numero.id}/contactos`))[0].wa_id;
// asegurar que haya bastante historial para poder subir
for (let i=0;i<14;i++) await fetch(`${S}/panel/numeros/${numero.id}/entrante`,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({waId:wa,texto:'relleno para el historial '+i})});
await new Promise(r=>setTimeout(r,1500));

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'dark'})).newPage();
await pag.goto(S,{waitUntil:'networkidle'}); await pag.waitForTimeout(1400);
for (let i=0;i<4;i++){ if((await pag.locator('#negNombre').innerText())===cuenta.nombre) break;
  await pag.locator('#selNegocio').click(); await pag.waitForTimeout(700); }
await pag.locator(`#chats .chat[data-wa="${wa}"]`).click(); await pag.waitForTimeout(1500);

const h = pag.locator('#hilo');
ok(await h.evaluate(e=>e.scrollHeight - e.scrollTop - e.clientHeight < 80), 'al abrir el chat arranca abajo');

// subir del todo y esperar DOS refrescos
await h.evaluate(e=>{ e.scrollTop = 0; });
await pag.waitForTimeout(6000);
const arriba = await h.evaluate(e=>e.scrollTop);
ok(arriba < 80, `tras 6s arriba, sigue arriba (scrollTop=${Math.round(arriba)})`);

// llega un mensaje nuevo mientras lees: NO debe arrastrarte
await fetch(`${S}/panel/numeros/${numero.id}/entrante`,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({waId:wa,texto:'llega mientras lees'})});
await pag.waitForTimeout(4000);
const trasMensaje = await h.evaluate(e=>e.scrollTop);
ok(trasMensaje < 120, `un mensaje nuevo no te arrastra abajo (scrollTop=${Math.round(trasMensaje)})`);

// pero si estás abajo, sí debe seguir bajando
await h.evaluate(e=>{ e.scrollTop = e.scrollHeight; });
await pag.waitForTimeout(600);
await fetch(`${S}/panel/numeros/${numero.id}/entrante`,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({waId:wa,texto:'estando abajo'})});
await pag.waitForTimeout(4000);
ok(await h.evaluate(e=>e.scrollHeight - e.scrollTop - e.clientHeight < 100), 'estando abajo, sí sigue el hilo');
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
