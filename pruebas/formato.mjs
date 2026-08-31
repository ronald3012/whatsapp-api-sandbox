import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'dark'})).newPage();
const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,150)));
await pag.goto('http://localhost:8095',{waitUntil:'networkidle'});
await pag.waitForTimeout(1300);
await pag.locator('#chats .chat').first().click();
await pag.waitForTimeout(1000);

// Mandar un mensaje con formato y varias líneas, como el del agente
const texto = "Listo. Guardé la ficha con nombre *Ventas express*, teléfono *809220111*.\nMe faltan estos datos:\n- dirección exacta\n- horario de atención\nY esto va en _cursiva_ y esto ~tachado~.";
await pag.locator('#texto').fill(texto);
const alto1 = await pag.locator('#texto').evaluate(e=>e.getBoundingClientRect().height);
ok(alto1 > 45, `la caja crece con varias líneas (${Math.round(alto1)}px)`);
await pag.locator('#bEnviar').click();
await pag.waitForTimeout(2500);

const b = pag.locator('.grupo.mio .b').last();
const html = await b.innerHTML();
ok(html.includes('<b>Ventas express</b>'), 'el *negrita* se convierte en negrita');
ok(html.includes('<i>cursiva</i>'), 'la _cursiva_ funciona');
ok(html.includes('<s>tachado</s>'), 'el ~tachado~ funciona');
ok(!/\*Ventas express\*/.test(await b.innerText()), 'ya NO se ven los asteriscos');
const lineas = (await b.innerText()).split('\n').length;
ok(lineas >= 4, `los saltos de línea se respetan (${lineas} líneas)`);

// Mayús+Enter no envía; Enter sí
await pag.locator('#texto').fill('primera');
await pag.locator('#texto').press('Shift+Enter');
await pag.locator('#texto').type('segunda');
const val = await pag.locator('#texto').inputValue();
ok(val.includes('\n'), 'Mayús+Enter salta de línea en vez de enviar');
await pag.locator('#texto').press('Enter');
await pag.waitForTimeout(2200);
ok((await pag.locator('#texto').inputValue()) === '', 'Enter envía y limpia la caja');
ok((await pag.locator('.grupo.mio .b').last().innerText()).includes('segunda'), 'el mensaje de dos líneas llegó');

// nada de HTML inyectado
await pag.locator('#texto').fill('<script>alert(1)</script> y *esto*');
await pag.locator('#texto').press('Enter');
await pag.waitForTimeout(2200);
ok((await pag.locator('.grupo.mio .b').last().innerHTML()).includes('&lt;script&gt;'), 'el HTML del mensaje se escapa (no se ejecuta)');

ok(errs.length===0, `sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);
await pag.screenshot({path:`${C}/formato.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
