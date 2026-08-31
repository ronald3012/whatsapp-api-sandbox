/**
 * El formulario de un cliente nuevo llega escrito, se puede cambiar, y jamás
 * deja guardar un número que ya es de alguien.
 */
import { chromium } from '/Users/ronalddeleon/Documents/pos_v2/frontend/node_modules/playwright/index.mjs';
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const cdp = await chromium.connectOverCDP('http://localhost:9333');
const ctx = cdp.contexts()[0];
const pagina = ctx.pages().find((p) => p.url().includes('8095')) || ctx.pages()[0];
await pagina.bringToFront();
await pagina.goto('http://localhost:8095/?clave=' + encodeURIComponent(process.env.CLAVE_LOCAL));
await pagina.waitForTimeout(1800);
if (!(await pagina.locator('#negNombre').textContent()).includes('Sandbox Pruebas')) {
  await pagina.click('#selNegocio'); await pagina.waitForTimeout(400);
  await pagina.locator('#menuNegocios .fila-neg', { hasText: 'Sandbox Pruebas' }).locator('[data-usar]').click();
  await pagina.waitForTimeout(1200);
}

// 1. llega escrito
await pagina.click('#bNuevoCliente');
await pagina.waitForTimeout(900);
const nombre1 = await pagina.inputValue('#kNombre');
const tel1 = await pagina.inputValue('#kTel');
ok(nombre1.length > 3 && /^\d{11}$/.test(tel1), `llega escrito: «${nombre1}» · ${tel1}`);
await pagina.screenshot({ path: process.argv[2] + '/cliente-escrito.png' });

// 2. «dame otro» trae otro distinto
await pagina.click('#kOtro');
await pagina.waitForTimeout(700);
const tel2 = await pagina.inputValue('#kTel');
ok(tel2 !== tel1, `«dame otro» propone otro (${tel1} → ${tel2})`);

// 3. se puede escribir el que uno quiera
await pagina.fill('#kNombre', 'Cliente A Mano');
await pagina.fill('#kTel', '18095559090');
await pagina.click('#bCrearCliente');
await pagina.waitForTimeout(1400);
ok(!(await pagina.locator('#dCliente').isVisible()), 'y se puede poner uno concreto');
ok((await pagina.locator('#chats .chat', { hasText: 'Cliente A Mano' }).count()) === 1, 'que aparece en la lista');

// 4. el mismo número otra vez: se avisa y NO se pisa al anterior
await pagina.click('#bNuevoCliente');
await pagina.waitForTimeout(900);
await pagina.fill('#kNombre', 'Intruso');
await pagina.fill('#kTel', '18095559090');
await pagina.click('#bCrearCliente');
await pagina.waitForTimeout(900);
const aviso = await pagina.locator('#kError').textContent();
ok(/ya es de Cliente A Mano/.test(aviso), `avisa de quién es: «${aviso}»`);
ok(await pagina.locator('#dCliente').isVisible(), 'y no cierra el formulario, para corregir un dígito');
ok((await pagina.inputValue('#kNombre')) === 'Intruso', 'sin borrar lo escrito');
await pagina.screenshot({ path: process.argv[2] + '/cliente-repetido.png' });
ok((await pagina.locator('#chats .chat', { hasText: 'Cliente A Mano' }).count()) === 1,
   'y el de antes sigue ahí, con su nombre');

// limpiar
await pagina.keyboard.press('Escape');
await pagina.evaluate(async () => {
  const clave = localStorage.getItem('wa-sandbox-clave');
  const n = document.querySelector('#chats .chat')?.dataset;
  await fetch(`/panel/numeros/${window.__num ?? ''}/x`, {}).catch(() => {});
});
await cdp.close();
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
process.exit(fallos.length ? 1 : 0);
