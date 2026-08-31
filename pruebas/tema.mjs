import { chromium } from 'playwright';
const C='/private/tmp/claude-501/-Users-ronalddeleon-Documents-n8n-mcp/be96e45e-82ed-4db2-919b-9a18435b48c0/scratchpad/vista';
const f=[]; const ok=(c,m)=>{console.log((c?'✅':'❌')+' '+m); if(!c)f.push(m)};
const lum=`(c)=>{const [r,g,b]=c.match(/[\\d.]+/g).map(Number).slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b}`;
const nav=await chromium.launch({channel:'chrome',headless:true});

for (const [modo, esquema] of [['claro','light'], ['oscuro','dark']]) {
  const ctx = await nav.newContext({ viewport:{width:1440,height:900}, colorScheme: esquema });
  const pag = await ctx.newPage();
  const errs=[]; pag.on('pageerror',e=>errs.push(String(e).slice(0,140)));
  await pag.goto('http://localhost:8095',{waitUntil:'networkidle'});
  await pag.waitForTimeout(1200);
  if (await pag.locator('#chats .chat').count()) {
    await pag.locator('#chats .chat').first().click(); await pag.waitForTimeout(1200);
  }
  console.log(`\n─── ${modo.toUpperCase()} (sistema en ${esquema}) ───`);

  const c = await pag.evaluate(({L}) => {
    const l = eval(L);
    const par = (sel, prop='color') => getComputedStyle(document.querySelector(sel))[prop];
    const ratio = (a,b) => { const A=l(a),B=l(b); return Math.round(((Math.max(A,B)+.05)/(Math.min(A,B)+.05))*100)/100; };
    const burbujaMia = document.querySelector('.grupo.mio .b');
    const burbujaOtro = document.querySelector('.grupo:not(.mio) .b');
    return {
      fondoChat: par('#hilo','backgroundColor'),
      cuerpo: ratio(par('body','backgroundColor'), par('body','color')),
      lista: ratio(par('.lista','backgroundColor') === 'rgba(0, 0, 0, 0)' ? par('main','backgroundColor') : par('.lista','backgroundColor'), par('.chat .n','color')),
      mia: burbujaMia ? ratio(par('.grupo.mio .b','backgroundColor'), par('.grupo.mio .b','color')) : null,
      otro: burbujaOtro ? ratio(par('.grupo:not(.mio) .b','backgroundColor'), par('.grupo:not(.mio) .b','color')) : null,
      dia: document.querySelector('.dia') ? ratio(par('.dia','backgroundColor'), par('.dia','color')) : null,
      patron: getComputedStyle(document.querySelector('#hilo')).backgroundImage,
    };
  }, { L: lum });

  const esperado = modo === 'oscuro' ? 'rgb(11, 20, 26)' : 'rgb(239, 234, 226)';
  ok(c.fondoChat === esperado, `el fondo del chat es el de WhatsApp ${modo} (${c.fondoChat})`);
  ok(c.cuerpo >= 7, `texto general legible (${c.cuerpo})`);
  ok(c.lista >= 7, `nombres de la lista legibles (${c.lista})`);
  if (c.mia !== null) ok(c.mia >= 4.5, `burbuja propia legible (${c.mia})`);
  if (c.otro !== null) ok(c.otro >= 4.5, `burbuja ajena legible (${c.otro})`);
  if (c.dia !== null) ok(c.dia >= 4.5, `píldora de la fecha legible (${c.dia})`);
  // El trazo del garabato: negro en claro, blanco en oscuro.
  const trazo = modo === 'oscuro' ? '%23fff' : '%23000';
  ok(c.patron.includes(trazo), `el patrón del fondo usa el trazo correcto (${trazo})`);
  ok(errs.length===0, `sin errores de JavaScript ${errs.length?'— '+errs[0]:''}`);

  await pag.screenshot({path:`${C}/tema-${modo}.png`});

  // el interruptor invierte
  await pag.click('#bTema'); await pag.waitForTimeout(600);
  const tras = await pag.locator('#hilo').evaluate(e=>getComputedStyle(e).backgroundColor);
  ok(tras !== c.fondoChat, `el interruptor cambia el tema (${c.fondoChat} → ${tras})`);
  await ctx.close();
}
console.log(f.length?`\nFALLOS: ${f.length}`:'\nTODO PASÓ'); f.forEach(x=>console.log('  ✗ '+x));
await nav.close();
