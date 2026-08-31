import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const nav=await chromium.launch({channel:'chrome',headless:true});
const pag=await (await nav.newContext({viewport:{width:1440,height:900}})).newPage();
const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,140)));
await pag.goto('http://localhost:8095',{waitUntil:'networkidle'});
await pag.waitForTimeout(1400);

// por defecto: SIN jerga técnica a la vista
const txt = await pag.locator('body').innerText();
ok(!/app_secret|phone_number_id|WABA/i.test(txt), 'por defecto no se ve jerga técnica (app_secret, phone_number_id, WABA)');
ok(await pag.locator('.lupa').isVisible() === false, 'el panel de desarrollador está oculto por defecto');
ok(/nada sale a un teléfono real/i.test(txt), 'deja claro que no sale a nadie real');

// hay un camino obvio para empezar
ok(await pag.locator('#bEmpezar').isVisible() || await pag.locator('#chats .chat').count() > 0,
   'hay un punto de partida claro (botón Empezar o clientes ya creados)');

// elegir un cliente y escribir
if (await pag.locator('#chats .chat').count()) {
  await pag.locator('#chats .chat').first().click();
  await pag.waitForTimeout(900);
  ok(await pag.locator('#redactar').isVisible(), 'al elegir cliente aparece la caja de escribir');
  await pag.fill('#texto','Hola, prueba de la interfaz nueva');
  await pag.click('#bEnviar'); await pag.waitForTimeout(2500);
  ok((await pag.locator('#hilo').innerText()).includes('prueba de la interfaz nueva'), 'el mensaje sale y se ve');
  ok(await pag.locator('.grupo.mio .b').count() >= 1, 'lo que tú escribes sale a la derecha, como en WhatsApp');
  ok(await pag.locator('.b .tipo').count() === 0, 'ya no hay etiquetas IMAGE/ORDER gritando sobre las burbujas');
  // La cara de WhatsApp Web: lo que hace que nadie tenga que aprender nada.
  const bg = await pag.locator('#hilo').evaluate(e=>getComputedStyle(e).backgroundImage);
  ok(bg.includes('svg'), 'el chat tiene el fondo con patrón, como WhatsApp Web');
  const burbuja = await pag.locator('.grupo.mio .b').first().evaluate(e=>getComputedStyle(e).backgroundColor);
  ok(burbuja === 'rgb(217, 253, 211)', `la burbuja propia es verde WhatsApp (${burbuja})`);
  ok(await pag.locator('.chat .h').count() >= 1, 'la lista enseña la hora del último mensaje');
  ok((await pag.locator('#chats').innerText()).length > 10, 'la lista enseña el último mensaje, no solo el teléfono');
  ok(await pag.locator('#filtro').isVisible(), 'hay buscador arriba de la lista, como WhatsApp Web');
}

// la salud se dice en palabras
const salud = await pag.locator('#saludTexto').innerText();
ok(!/^\d{3}$/.test(salud.trim()) && salud.length > 3, `la salud se explica en palabras: "${salud}"`);

// modo avanzado: aparece lo técnico
await pag.check('#swAvanzado'); await pag.waitForTimeout(900);
ok(await pag.locator('.lupa').isVisible(), 'el modo avanzado abre el panel de desarrollador');
await pag.locator('.pest button[data-hoja="conectar"]').click(); await pag.waitForTimeout(600);
ok(/META_GRAPH_URL/.test(await pag.locator('#credenciales').innerText()), 'las credenciales viven ahí, no en la portada');

// contraste
const cont = await pag.evaluate(()=>{const l=c=>{const[r,g,b]=c.match(/[\d.]+/g).map(Number).slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b};
  const s=getComputedStyle(document.body);const A=l(s.backgroundColor),B=l(s.color);return Math.round(((Math.max(A,B)+.05)/(Math.min(A,B)+.05))*100)/100});
ok(cont>=7,`texto legible (contraste ${cont})`);
ok(errs.length===0,`sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);

await pag.uncheck('#swAvanzado'); await pag.waitForTimeout(500);
await pag.screenshot({path:`${C}/ui2-simple.png`});
await pag.check('#swAvanzado'); await pag.waitForTimeout(700);
await pag.screenshot({path:`${C}/ui2-avanzado.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
