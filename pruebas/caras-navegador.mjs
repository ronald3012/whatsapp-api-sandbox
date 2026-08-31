import { chromium } from '/Users/ronalddeleon/Documents/pos_v2/frontend/node_modules/playwright/index.mjs';
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const cdp = await chromium.connectOverCDP('http://localhost:9333');
const ctx = cdp.contexts()[0];
const pagina = ctx.pages().find((p) => p.url().includes('8095')) || ctx.pages()[0];
await pagina.bringToFront();
await pagina.goto('http://localhost:8095/?clave=' + encodeURIComponent(process.env.CLAVE_LOCAL));
await pagina.waitForTimeout(1800);
// al negocio con muchos contactos: con tres no se ve si hay variedad
if (!(await pagina.locator('#negNombre').textContent()).includes('Sandbox Pruebas')) {
  await pagina.click('#selNegocio'); await pagina.waitForTimeout(400);
  await pagina.locator('#menuNegocios .fila-neg', { hasText: 'Sandbox Pruebas' }).locator('[data-usar]').click();
  await pagina.waitForTimeout(1400);
}
/* Sin fotos propias en `datos/caras/`, cada contacto lleva su retrato dibujado.
   Nada se baja de internet: ver el porqué en src/caras.js. */
const caras = await pagina.locator('#chats .av svg').count();
ok(caras >= 8, `cada contacto tiene su cara (${caras})`);
const dibujos = await pagina.$$eval('#chats .av svg', (ss) => ss.map((s) => s.innerHTML));
ok(new Set(dibujos).size >= 8, `y no hay dos iguales (${new Set(dibujos).size} distintas)`);
const fotosDeFuera = await pagina.$$eval('#chats .av img', (i) => i.map((x) => x.src).filter((u) => !u.includes('localhost')));
ok(fotosDeFuera.length === 0, 'y no se carga ninguna imagen de fuera');
// la misma cara al recargar
const antes = await pagina.locator('#chats .av svg').first().innerHTML();
await pagina.reload(); await pagina.waitForTimeout(1800);
if (!(await pagina.locator('#negNombre').textContent()).includes('Sandbox Pruebas')) {
  await pagina.click('#selNegocio'); await pagina.waitForTimeout(400);
  await pagina.locator('#menuNegocios .fila-neg', { hasText: 'Sandbox Pruebas' }).locator('[data-usar]').click();
  await pagina.waitForTimeout(1400);
}
const despues = await pagina.locator('#chats .av svg').first().innerHTML();
ok(antes === despues, 'y a cada quien le toca SIEMPRE la suya');
await pagina.locator('#chats').screenshot({ path: process.argv[2] + '/retratos.png' });
await cdp.close();
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
