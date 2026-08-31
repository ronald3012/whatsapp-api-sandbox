import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const S='http://localhost:8095';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const api=(r,o)=>fetch(S+r,o?{...o,headers:{'content-type':'application/json'}}:undefined).then(x=>x.json());
const cuentas=await api('/panel/cuentas');
const cuenta=cuentas.find(c=>/webhook\/channels\//.test(c.webhook_url||''))||cuentas[0];
const NUM=cuenta.numeros[0].id;
// contacto desechable para la prueba
await api(`/panel/numeros/${NUM}/contactos`,{method:'POST',body:JSON.stringify({nombre:'Prueba Gestión',telefono:'18290006622'})});
await api(`/panel/numeros/${NUM}/entrante`,{method:'POST',body:JSON.stringify({waId:'18290006622',texto:'mensaje para vaciar'})});

const nav=await chromium.launch({channel:'chrome',headless:false});
const pag=await (await nav.newContext({viewport:{width:1440,height:900},colorScheme:'light'})).newPage();
const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,140)));
pag.on('dialog',d=>d.accept('Prueba Renombrada'));   // prompt y confirm dicen que sí
await pag.goto(S,{waitUntil:'networkidle'}); await pag.waitForTimeout(1500);
for (let i=0;i<4;i++){ if((await pag.locator('#negNombre').innerText())===cuenta.nombre) break;
  await pag.locator('#selNegocio').click(); await pag.waitForTimeout(700); }
await pag.waitForTimeout(1200);
await pag.locator('.chat[data-wa="18290006622"]').click(); await pag.waitForTimeout(900);

// menú
await pag.locator('#bMasChat').click(); await pag.waitForTimeout(400);
ok(await pag.locator('#menuChat').isVisible(), 'el menú del contacto abre');
const caja=await pag.locator('#menuChat').boundingBox();
ok(caja && caja.y > 30 && caja.x > 600, `y queda junto a la barra, no perdido (${Math.round(caja?.x)},${Math.round(caja?.y)})`);

// renombrar
await pag.locator('#mNombre').click(); await pag.waitForTimeout(1200);
ok((await pag.locator('#chatNombre').innerText())==='Prueba Renombrada', 'renombrar funciona y se refleja');

// foto
await pag.locator('#bMasChat').click(); await pag.waitForTimeout(300);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const [chooser] = await Promise.all([pag.waitForEvent('filechooser'), pag.locator('#mFoto').click()]);
await chooser.setFiles({name:'cara.png',mimeType:'image/png',buffer:png});
await pag.waitForTimeout(1500);
ok(await pag.locator('#chatAv img').count()===1, 'la foto queda en el avatar de la barra');
ok(await pag.locator('.chat[data-wa="18290006622"] .av img').count()===1, 'y en la lista');

// vaciar
await pag.locator('#bMasChat').click(); await pag.waitForTimeout(300);
await pag.locator('#mVaciar').click(); await pag.waitForTimeout(1200);
ok(!(await pag.locator('#hilo').innerText()).includes('mensaje para vaciar'), 'vaciar deja la conversación limpia');
ok(await pag.locator('.chat[data-wa="18290006622"]').count()===1, 'pero el contacto sigue');

// eliminar
await pag.locator('.chat[data-wa="18290006622"]').click(); await pag.waitForTimeout(600);
await pag.locator('#bMasChat').click(); await pag.waitForTimeout(300);
await pag.locator('#mBorrar').click(); await pag.waitForTimeout(1200);
ok(await pag.locator('.chat[data-wa="18290006622"]').count()===0, 'eliminar quita el contacto de la lista');
ok(errs.length===0, `sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);
await pag.screenshot({path:`${C}/contactos.png`});
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
