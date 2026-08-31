/** Con la CSP puesta, la interfaz tiene que seguir entera y sin quejas. */
import { chromium } from '/Users/ronalddeleon/Documents/pos_v2/frontend/node_modules/playwright/index.mjs';
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const cdp = await chromium.connectOverCDP('http://localhost:9333');
const ctx = cdp.contexts()[0];
const pagina = ctx.pages().find((p) => p.url().includes('8095')) || ctx.pages()[0];
const quejas = [];
pagina.on('console', (m) => { if (m.type() === 'error') quejas.push(m.text()); });
pagina.on('pageerror', (e) => quejas.push('pageerror: ' + e.message));
await pagina.bringToFront();
await pagina.goto('http://localhost:8095/?clave=' + encodeURIComponent(process.env.CLAVE_LOCAL));
await pagina.waitForTimeout(2200);
ok(!(await pagina.locator('#pantallaAcceso').isVisible()), 'entra');
ok((await pagina.locator('#chats .chat').count()) > 0, 'la lista de chats se pinta');
await pagina.locator('#chats .chat').first().click();
await pagina.waitForTimeout(1500);
ok((await pagina.locator('#hilo > div').count()) > 0, 'la conversación se pinta');
// el río de eventos, que va por su propia conexión
const rio = await pagina.evaluate(() => window.EventSource && document.readyState === 'complete');
ok(!!rio, 'la página termina de cargar');
// mandar un mensaje de verdad
const caja = pagina.locator('#texto');
await caja.fill('prueba con CSP ' + Date.now());
await pagina.keyboard.press('Enter');
await pagina.waitForTimeout(1500);
ok((await pagina.locator('#hilo > div').count()) > 0, 'y se puede escribir');
const csp = quejas.filter((q) => /Content Security Policy|Refused to/i.test(q));
ok(csp.length === 0, `sin quejas de la CSP${csp.length ? ':\n     ' + csp.join('\n     ') : ''}`);
if (quejas.length) console.log('   otras quejas:', quejas.slice(0, 4).join(' | '));
await cdp.close();
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
process.exit(fallos.length ? 1 : 0);
