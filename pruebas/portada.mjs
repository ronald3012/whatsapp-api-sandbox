/**
 * La portada y la puerta, desde el 6 nov 2026: el sandbox es exclusivo de
 * RunOp AI. Sin registro público, con la marca de RunOp y con el atajo de
 * RunOp (POST /panel/ensayo + enlace /?clave=…) funcionando igual.
 */
const S = process.env.SANDBOX || 'http://localhost:8095';
const { readFileSync } = await import('node:fs');
const ADMIN = process.env.ADMIN_CLAVE || readFileSync(new URL('../datos/admin.clave', import.meta.url).pathname, 'utf8').trim();
const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const json = { 'content-type': 'application/json' };

const reg = await fetch(`${S}/panel/registrar`, { method: 'POST', headers: json,
  body: JSON.stringify({ nombre: 'X', email: `x-${Date.now()}@sandbox.test`, password: 'secreto1' }) });
ok(reg.status === 410, `POST /panel/registrar ya no crea cuentas: 410 (${reg.status})`);

const html = await (await fetch(`${S}/`)).text();
ok(/RunOp AI/.test(html) && /https:\/\/runop\.ai\/login/.test(html), 'la portada lleva la marca RunOp AI y el botón a runop.ai/login');
ok(!/Crea(r)? (una|mi|tu) cuenta|Créala aquí|panel\/registrar|regEmail/.test(html), 'sin «Crear una cuenta» ni llamada al registro');
ok(/WhatsApp de prueba/.test(html), 'explica que se abre con el botón «WhatsApp de prueba»');

const mal = await (await fetch(`${S}/panel/entrar`, { method: 'POST', headers: json,
  body: JSON.stringify({ email: 'nadie@sandbox.test', password: 'no' }) })).json();
ok(mal.error === 'Correo o contraseña incorrectos.', 'la entrada del equipo sigue viva y contesta en español');

/* El atajo de RunOp: una llamada, y la clave abre la pantalla con su cliente. */
const e = await fetch(`${S}/panel/ensayo`, { method: 'POST', headers: json, body: JSON.stringify({ nombre: 'Portada prueba' }) });
const ensayo = await e.json();
ok(e.ok && ensayo.clave && ensayo.phone_number_id && ensayo.cliente?.nombre === 'Cliente de prueba', 'POST /panel/ensayo sigue creando el negocio con su «Cliente de prueba»');
if (ensayo.clave) {
  const q = await fetch(`${S}/panel/quien?clave=${encodeURIComponent(ensayo.clave)}`);
  ok(q.ok && (await q.json()).admin === false, 'el enlace /?clave=… de ese ensayo abre la pantalla del negocio');
  // Limpieza: el negocio de la prueba no se queda.
  const lista = await (await fetch(`${S}/panel/negocios`, { headers: { 'x-clave': ADMIN } })).json();
  const d = lista.find((n) => n.clave === ensayo.clave);
  if (d) await fetch(`${S}/panel/negocios/${d.id}`, { method: 'DELETE', headers: { 'x-clave': ADMIN } });
}

if (fallos.length) { console.log(`\n${fallos.length} fallo(s)`); process.exit(1); }
console.log('\nTodo en verde.');
