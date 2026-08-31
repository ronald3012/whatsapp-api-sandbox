/** Los límites que Meta impone y el sandbox no comprobaba. */
const { createRequire } = await import('node:module');
const require = createRequire('/Users/ronalddeleon/Documents/wa-sandbox/x.js');
const db = new (require('better-sqlite3'))('/Users/ronalddeleon/Documents/wa-sandbox/datos/sandbox.db');
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const cuenta = db.prepare("SELECT * FROM cuentas WHERE nombre='Sandbox Pruebas'").get();
const numero = db.prepare('SELECT * FROM numeros WHERE cuenta_id=?').get(cuenta.id);
const clave = db.prepare("SELECT clave FROM duenos WHERE id='local'").get().clave;
const WA = '18095557799';
await fetch(`http://localhost:8095/panel/numeros/${numero.id}/contactos`, { method: 'POST',
  headers: { 'x-clave': clave, 'content-type': 'application/json' },
  body: JSON.stringify({ nombre: 'Límites', telefono: WA }) });
await fetch(`http://localhost:8095/panel/numeros/${numero.id}/entrante`, { method: 'POST',
  headers: { 'x-clave': clave, 'content-type': 'application/json' },
  body: JSON.stringify({ waId: WA, texto: 'abro la ventana' }) });
await new Promise((v) => setTimeout(v, 600));
const enviar = (cuerpo) => fetch(`http://localhost:8095/v21.0/${numero.id}/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${cuenta.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', to: WA, ...cuerpo }) });

const largo = await enviar({ type: 'text', text: { body: 'a'.repeat(4097) } });
const jl = await largo.json();
ok(largo.status === 400 && jl.error?.code === 131009, `un texto de 4097 se rechaza (${jl.error?.code})`);
const justo = await enviar({ type: 'text', text: { body: 'a'.repeat(4096) } });
ok(justo.ok, 'y uno de 4096 pasa');

const inventado = await enviar({ type: 'image', image: { id: '999999999999999' } });
const ji = await inventado.json();
ok(inventado.status === 404 && ji.error?.code === 100, `una foto con id inventado se rechaza (${ji.error?.code})`);

db.prepare('DELETE FROM mensajes WHERE wa_id=?').run(WA);
db.prepare('DELETE FROM contactos WHERE wa_id=?').run(WA);
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
process.exit(fallos.length ? 1 : 0);
