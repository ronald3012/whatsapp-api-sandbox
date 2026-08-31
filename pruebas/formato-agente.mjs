import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o).then(x=>x.json());

// El MISMO negocio que abre la interfaz por defecto: el primero.
const cuentas = await api('/panel/cuentas');
const cuenta = cuentas[0], numero = cuenta.numeros[0];
let contactos = await api(`/panel/numeros/${numero.id}/contactos`);
if (!contactos.length) {
  await fetch(`${S}/panel/numeros/${numero.id}/contactos`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({nombre:'Prueba Formato',telefono:'18290000001'})});
  contactos = await api(`/panel/numeros/${numero.id}/contactos`);
}
const wa = contactos[0].wa_id;

// El cliente escribe (abre la ventana de 24h) y el AGENTE responde con formato.
await fetch(`${S}/panel/numeros/${numero.id}/entrante`,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({waId:wa,texto:'abro la ventana'})});
await new Promise(r=>setTimeout(r,1200));
const texto = "Listo, quedó actualizado el WhatsApp de confirmaciones a *18095550101*.\nTambién _cursiva_, ~tachado~ y ```codigo```.\nY un enlace: https://ejemplo.com";
const env = await fetch(`${S}/v21.0/${numero.id}/messages`,{method:'POST',
  headers:{'content-type':'application/json',authorization:`Bearer ${cuenta.token}`},
  body:JSON.stringify({messaging_product:'whatsapp',to:wa,type:'text',text:{body:texto}})});
ok(env.ok, `el agente pudo enviar (${env.status})`);
await new Promise(r=>setTimeout(r,1500));

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'dark'})).newPage();
await pag.goto('http://localhost:8095',{waitUntil:'networkidle'});
await pag.waitForTimeout(1400);
await pag.locator(`#chats .chat[data-wa="${wa}"]`).click();
await pag.waitForTimeout(1400);

const b = pag.locator('.grupo:not(.mio) .b').last();   // la burbuja DEL AGENTE
const html = await b.innerHTML();
ok(html.includes('<b>18095550101</b>'), 'la negrita del AGENTE se interpreta');
ok(html.includes('<i>cursiva</i>'), 'la cursiva del agente');
ok(html.includes('<s>tachado</s>'), 'el tachado del agente');
ok(html.includes('<code>'), 'el monoespaciado del agente');
ok(html.includes('<a href="https://ejemplo.com"'), 'los enlaces se vuelven clicables');
ok(!(await b.innerText()).includes('*18095550101*'), 'ya no se ven los asteriscos');
ok((await b.innerText()).split('\n').length >= 3, 'los saltos de línea del agente se respetan');
await pag.screenshot({path:`${C}/formato-agente.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
