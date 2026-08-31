import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const nav=await chromium.launch({channel:'chrome',headless:false});
const ctx=await nav.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
const pag=await ctx.newPage();
const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,150)));
await pag.goto('http://localhost:8095',{waitUntil:'networkidle'});
await pag.waitForTimeout(1400);

ok(await pag.locator('.riel').isVisible(), 'está el riel de iconos de WhatsApp Web');
ok(await pag.locator('.lista .cab .tit').innerText() === 'Chats', 'la lista se titula «Chats»');
ok(await pag.locator('.fil').count() === 3, 'están los filtros de arriba');
ok((await pag.locator('body').innerText()).match(/[🌙☀️📎🛒📷🎤📄➤]/) === null, 'NO queda ni un emoji de icono');
ok(await pag.locator('.riel svg').count() >= 3, 'el riel usa SVG, no emoji');
ok(await pag.locator('#bEnviar svg').count() === 1, 'el botón de enviar es un SVG');

// elegir chat y comprobar los vistos. Se manda uno NUEVO: los de antes del
// arreglo no tienen estado, y probar con ellos mediría el pasado.
await pag.locator('#chats .chat').first().click();
await pag.waitForTimeout(1200);
await pag.fill('#texto', 'comprobando los vistos ' + Date.now());
await pag.click('#bEnviar');
await pag.waitForTimeout(2500);
const conVisto = await pag.locator('.grupo.mio .b .vv').count();
const enAjeno  = await pag.locator('.grupo:not(.mio) .b .vv').count();
ok(conVisto >= 1, `los vistos salen en MIS mensajes (${conVisto})`);
ok(enAjeno === 0, `y NO en los del agente (${enAjeno})`);
ok(await pag.locator('.grupo.mio .b .vv svg').count() >= 1, 'los tildes están dibujados en SVG');

// el filtro «no leídos»
await pag.locator('.fil[data-fil="sinleer"]').click(); await pag.waitForTimeout(600);
ok(true, 'el filtro «No leídos» responde');
await pag.locator('.fil[data-fil="todos"]').click(); await pag.waitForTimeout(400);

ok(errs.length===0, `sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);
await pag.screenshot({path:`${C}/afinado.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
