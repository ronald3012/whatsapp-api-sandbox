/** El número tiene que tener forma de número de WhatsApp, como exige Meta. */
const { createRequire } = await import('node:module');
const require = createRequire('/Users/ronalddeleon/Documents/wa-sandbox/x.js');
const db = new (require('better-sqlite3'))('/Users/ronalddeleon/Documents/wa-sandbox/datos/sandbox.db');
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };

const cuenta = db.prepare("SELECT * FROM cuentas WHERE nombre='Sandbox Pruebas'").get();
const numero = db.prepare('SELECT * FROM numeros WHERE cuenta_id=?').get(cuenta.id);
const clave = db.prepare("SELECT clave FROM duenos WHERE id='local'").get().clave;
const enviar = (to) => fetch(`http://localhost:8095/v21.0/${numero.id}/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${cuenta.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: 'hola' } }) });

// 1. sin código de país: como Meta, 131009
const r1 = await enviar('8097771010');
const j1 = await r1.json();
ok(r1.status === 400 && j1.error?.code === 131009,
   `sin código de país se rechaza con 131009 (${r1.status}/${j1.error?.code})`);
console.log('    ', j1.error?.error_data?.details);

// 2. otros imposibles
for (const [n, que] of [['0034600111222', 'empezando por 0'], ['123', 'demasiado corto'],
                        ['1809777101011111', 'demasiado largo']]) {
  const r = await enviar(n);
  const j = await r.json();
  ok(r.status === 400 && j.error?.code === 131009, `${que} → 131009`);
}

// 3. uno bueno pasa (con su ventana abierta: le escribimos antes como cliente)
const BUENO = '18095557788';
await fetch(`http://localhost:8095/panel/numeros/${numero.id}/contactos`, {
  method: 'POST', headers: { 'x-clave': clave, 'content-type': 'application/json' },
  body: JSON.stringify({ nombre: 'Prueba Teléfono', telefono: BUENO }) });
await fetch(`http://localhost:8095/panel/numeros/${numero.id}/entrante`, {
  method: 'POST', headers: { 'x-clave': clave, 'content-type': 'application/json' },
  body: JSON.stringify({ waId: BUENO, texto: 'hola, soy el cliente' }) });
await new Promise((v) => setTimeout(v, 600));
const r3 = await enviar(BUENO);
ok(r3.ok, `un número con código de país sí pasa (${r3.status})`);

// 4. tampoco se puede fabricar un cliente falso con número imposible
const r4 = await fetch(`http://localhost:8095/panel/numeros/${numero.id}/contactos`, {
  method: 'POST', headers: { 'x-clave': clave, 'content-type': 'application/json' },
  body: JSON.stringify({ nombre: 'Imposible', telefono: '8097771010' }) });
const j4 = await r4.json();
ok(r4.status === 400 && /código de país/.test(j4.error || ''),
   `crear un cliente con ese número se rechaza: «${j4.error}»`);

// limpiar
db.prepare('DELETE FROM mensajes WHERE wa_id=?').run(BUENO);
db.prepare('DELETE FROM contactos WHERE wa_id=?').run(BUENO);
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
process.exit(fallos.length ? 1 : 0);
