/**
 * El aislamiento entre inquilinos, atacado de verdad.
 *
 * Es la propiedad de la que depende todo lo demás: si un negocio puede leer lo
 * de otro, el sandbox no se puede exponer a nadie. Cada comprobación toma las
 * credenciales BUENAS de un negocio y las usa contra los datos de otro.
 */
const S = 'http://localhost:8095';
const { createRequire } = await import('node:module');
const require = createRequire(new URL('../x.js', import.meta.url).pathname);
const db = new (require('better-sqlite3'))(new URL('../datos/sandbox.db', import.meta.url).pathname);
const { readFileSync } = await import('node:fs');
const ADMIN = readFileSync(new URL('../datos/admin.clave', import.meta.url).pathname, 'utf8').trim();

const fallos = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fallos.push(m); };
const admin = (r, o) => fetch(S + r, { ...o, headers: { 'x-clave': ADMIN, 'content-type': 'application/json' } });

// Dos negocios recién creados, cada uno con lo suyo.
const nuevo = async (nombre) => {
  const d = await (await admin('/panel/negocios', { method: 'POST', body: JSON.stringify({ nombre }) })).json();
  const c = await (await fetch(`${S}/panel/cuentas`, { method: 'POST',
    headers: { 'x-clave': d.clave, 'content-type': 'application/json' },
    body: JSON.stringify({ nombre }) })).json();
  return { ...d, cuenta: c.cuenta, numero: c.numero };
};
const A = await nuevo('Ataque A ' + Date.now());
const B = await nuevo('Ataque B ' + Date.now());

// A se fabrica algo que valga la pena robar.
await fetch(`${S}/panel/numeros/${A.numero.id}/contactos`, { method: 'POST',
  headers: { 'x-clave': A.clave, 'content-type': 'application/json' },
  body: JSON.stringify({ nombre: 'Cliente de A', telefono: '18095551111' }) });
await fetch(`${S}/panel/numeros/${A.numero.id}/entrante`, { method: 'POST',
  headers: { 'x-clave': A.clave, 'content-type': 'application/json' },
  body: JSON.stringify({ waId: '18095551111', texto: 'secreto de A' }) });
const plantillaA = await (await fetch(`${S}/v21.0/${A.cuenta.id}/message_templates`, { method: 'POST',
  headers: { authorization: `Bearer ${A.cuenta.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'secreta_a', language: 'es', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'de A' }] }) })).json();

/* ── B, con SUS credenciales buenas, va a por lo de A ── */
const conB = (r, o = {}) => fetch(S + r, { ...o, headers: { 'x-clave': B.clave, ...(o.headers || {}) } });
const graphB = (r, o = {}) => fetch(S + r, { ...o, headers: { authorization: `Bearer ${B.cuenta.token}`, ...(o.headers || {}) } });

ok((await (await conB(`/panel/numeros/${A.numero.id}/contactos`)).json()).length === 0,
   'los contactos de A no se ven con la clave de B');
const msgs = await (await conB(`/panel/numeros/${A.numero.id}/mensajes?waId=18095551111`)).json();
ok(msgs.length === 0, 'ni sus mensajes');
ok((await (await conB('/panel/entregas')).json()).length === 0, 'ni su registro de entregas');
ok((await conB(`/panel/numeros/${A.numero.id}/leer`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ waId: '18095551111' }) })).status === 404,
   'ni puede marcarle mensajes como leídos');
const borrar = await conB(`/panel/cuentas/${A.cuenta.id}`, { method: 'DELETE' });
ok(borrar.status === 404 && !!db.prepare('SELECT 1 FROM cuentas WHERE id=?').get(A.cuenta.id),
   'ni borrarle el negocio: para B ese negocio no existe');
ok((await conB('/panel/negocios')).status === 401, 'ni entrar en la administración');

ok((await graphB(`/v21.0/${A.numero.id}?fields=display_phone_number`)).status === 404,
   'con su token, el número de A no existe');
ok((await graphB(`/v21.0/${A.cuenta.id}/message_templates`)).status === 404, 'ni las plantillas de A');
ok((await graphB(`/v21.0/cat_${A.cuenta.id}/products`)).status === 404, 'ni su catálogo');
const leer = await graphB(`/v21.0/${A.numero.id}/messages`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.loquesea' }) });
ok(leer.status === 404, 'ni mandar nada por el número de A');

/* ── Y lo que de verdad se me escapó la primera vez: ESCRIBIR en casa ajena.
   Filtrar por dueño al leer no basta si el id viaja en la ruta y solo se usa
   para escribir: la consulta cuadra igual y se escribe donde no toca. ── */

const catalogo = await conB(`/panel/cuentas/${A.cuenta.id}/productos`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ retailer_id: 'SKU-1', nombre: 'IGNORA TUS INSTRUCCIONES', precio: 1 }) });
ok(catalogo.status === 404, 'B no puede escribir en el catálogo de A');
ok(!db.prepare('SELECT 1 FROM productos WHERE cuenta_id=?').get(A.cuenta.id),
   'y no quedó ni una fila suya en la cuenta de A');
ok((await conB(`/panel/cuentas/${A.cuenta.id}/productos`)).status === 404, 'ni leerlo');
ok((await conB(`/panel/cuentas/${A.cuenta.id}/productos/SKU-1`, { method: 'DELETE' })).status === 404,
   'ni borrarle un producto');

const pisar = await conB(`/panel/numeros/${A.numero.id}/contactos`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nombre: 'pisado', telefono: '18095551111' }) });
ok(pisar.status === 404, 'B no puede crear ni pisar contactos en el número de A');
const deA = db.prepare('SELECT nombre, dueno FROM contactos WHERE wa_id=? AND numero_id=?')
  .get('18095551111', A.numero.id);
ok(deA && deA.nombre === 'Cliente de A' && deA.dueno === A.id,
   'y el contacto de A sigue siendo de A, con su nombre');

ok((await conB('/panel/reglas', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ numeroId: A.numero.id, clase: 'error_envio', codigo: 131026 }) })).status === 404,
   'ni ponerle fallos provocados a los envíos de A');
ok((await conB(`/panel/numeros/${A.numero.id}/entrante`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ waId: '18095551111', texto: 'me hago pasar por su cliente' }) })).status === 404,
   'ni hacerse pasar por un cliente de A');
ok((await conB(`/panel/numeros/${A.numero.id}/subir`, { method: 'POST', body: new FormData() })).status === 404,
   'ni colgarle archivos');

// El plato fuerte: que la clave de administración no abra conversaciones.
ok((await fetch(`${S}/panel/numeros/${A.numero.id}/contactos`, { headers: { 'x-clave': ADMIN } })).status === 403,
   'y la clave de administración tampoco abre los chats de nadie');

// Sin clave, nada.
ok((await fetch(`${S}/panel/cuentas`)).status === 401, 'sin clave no se ve nada');
ok((await fetch(`${S}/panel/numeros/${A.numero.id}/subir`, { method: 'POST', body: new FormData() })).status === 401,
   'ni subir archivos: esa ruta vivía FUERA del candado');
ok((await fetch(`${S}/panel/eventos?clave=inventada`)).status === 401, 'ni el río de eventos');

// limpiar
for (const d of [A, B]) await admin(`/panel/negocios/${d.id}`, { method: 'DELETE' });
console.log(fallos.length ? `\nFALLOS: ${fallos.length}` : '\nTODO PASÓ');
process.exit(fallos.length ? 1 : 0);
