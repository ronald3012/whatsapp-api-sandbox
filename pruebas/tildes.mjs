import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o).then(x=>x.json());
// El negocio CONECTADO: uno con el webhook muerto se queda en un tilde —que es
// lo correcto— y entonces el doble no aparecería nunca.
const cuentas=await api('/panel/cuentas');
const cuenta=cuentas.find(c=>/webhook\/channels\//.test(c.webhook_url||'')) || cuentas[0];
const numero=cuenta.numeros[0];
const wa=(await api(`/panel/numeros/${numero.id}/contactos`))[0].wa_id;
await fetch(`${S}/panel/numeros/${numero.id}/entrante`,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({waId:wa,texto:'mirando los tildes'})});
await new Promise(r=>setTimeout(r,1500));

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'dark'})).newPage();
await pag.goto(S,{waitUntil:'networkidle'}); await pag.waitForTimeout(1400);
// cambiar al negocio conectado si la interfaz abrió otro
for (let i=0;i<4;i++){
  if ((await pag.locator('#negNombre').innerText()) === cuenta.nombre) break;
  await pag.locator('#selNegocio').click(); await pag.waitForTimeout(700);
}
await pag.locator(`#chats .chat[data-wa="${wa}"]`).click(); await pag.waitForTimeout(1500);

// Lo que se arregló: el doble tilde son DOS tildes completos, no fragmentos.
const trazos=await pag.locator('.vv svg').evaluateAll(els=>els.map(e=>e.querySelectorAll('path').length));
ok(trazos.length>0, `hay tildes en pantalla (${trazos.length})`);
ok(trazos.every(n=>n===1||n===2), `cada tilde es 1 o 2 trazos completos, nunca 3 sueltos (${JSON.stringify([...new Set(trazos)])})`);
ok(trazos.includes(2), 'el doble tilde existe y son dos');
// que los dos tildes estén separados y no encimados
const geo=await pag.locator('.vv svg').evaluateAll(els=>{
  const dos=els.find(e=>e.querySelectorAll('path').length===2);
  if(!dos) return null;
  const [a,b]=[...dos.querySelectorAll('path')].map(p=>p.getBBox());
  return { sep: Math.round((b.x-a.x)*10)/10, anchoA: Math.round(a.width*10)/10 };
});
ok(geo && geo.sep>3 && geo.sep<geo.anchoA, `los dos tildes van corridos, no encimados (separación ${geo?.sep} sobre ancho ${geo?.anchoA})`);

const caja=await pag.locator('.grupo.mio .b').last().boundingBox();
await pag.screenshot({path:`${C}/tildes.png`, clip:{x:Math.max(0,caja.x-30),y:Math.max(0,caja.y-90),width:430,height:180}});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
