/**
 * Quién puede entrar al panel, y a qué.
 *
 * El sandbox va a producción y ahí la pregunta cambia: ya no es «¿funciona?»
 * sino «¿quién está mirando?». Cada negocio entra con SU clave y el servidor
 * resuelve el dueño por ella — nunca por un parámetro que el navegador pueda
 * inventar. Un negocio sin clave válida no ve ni una lista vacía: ve un 401.
 *
 * La clave de administración es aparte y solo sirve para gestionar negocios:
 * crearlos, listarlos con sus claves y quitarlos. No abre ningún chat — así un
 * descuido con ella no expone conversaciones, solo la gestión.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "./db.js";
import { crearNegocio } from "./negocio.js";

const RUTA_ADMIN = process.env.SANDBOX_ADMIN_CLAVE_ARCHIVO ||
  resolve(process.cwd(), "datos/admin.clave");

/** La clave admin vive en un archivo del servidor, nunca en la base ni en el env del contenedor de la plataforma. Se genera sola la primera vez. */
export function claveAdmin() {
  try {
    return readFileSync(RUTA_ADMIN, "utf8").trim();
  } catch {
    const clave = "sbadmin_" + randomBytes(24).toString("base64url");
    mkdirSync(dirname(RUTA_ADMIN), { recursive: true });
    writeFileSync(RUTA_ADMIN, clave + "\n");
    try { chmodSync(RUTA_ADMIN, 0o600); } catch { /* FS sin permisos POSIX */ }
    return clave;
  }
}

/**
 * La clave viaja en una cabecera. En la dirección SOLO donde no hay otra:
 * `EventSource` no sabe poner cabeceras, y el enlace de acceso es un enlace.
 *
 * Aceptarla en la query de TODAS las rutas la dejaba escrita en los registros
 * del proxy, en el historial del navegador y en cualquier vuelco de tráfico —
 * y ahí quedan las credenciales de todos los inquilinos.
 */
export function claveDe(req, { porLaUrl = false } = {}) {
  const enCabecera = String(req.get?.("x-clave") || "").trim();
  if (enCabecera) return enCabecera;
  return porLaUrl ? String(req.query?.clave || "").trim() : "";
}

export function quienEs(req, opciones) {
  const clave = claveDe(req, opciones);
  if (!clave) return null;
  /* En tiempo constante: comparar dos secretos con `===` deja medir, por lo que
     tarda en fallar, cuántos caracteres se acertaron. */
  if (igualesEnTiempoConstante(clave, claveAdmin())) {
    return { admin: true, dueno: null, nombre: "Administración" };
  }
  const d = db.prepare(`SELECT * FROM duenos WHERE clave = ?`).get(clave);
  return d ? { admin: false, dueno: d.id, nombre: d.nombre } : null;
}

function igualesEnTiempoConstante(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** El candado de las rutas de negocio: exige una clave de negocio, no la admin. */
export function conClave(req, res, next) {
  const q = quienEs(req);
  if (!q) return res.status(401).json({ error: "Hace falta la clave del negocio." });
  if (q.admin) return res.status(403).json({ error: "La clave de administración no abre los chats: entra con la clave del negocio." });
  req.dueno = q.dueno;
  next();
}

/** El candado de la gestión: solo la clave de administración. */
export function soloAdmin(req, res, next) {
  const q = quienEs(req);
  if (!q?.admin) return res.status(401).json({ error: "Hace falta la clave de administración." });
  next();
}

export function nuevaClaveDeNegocio() {
  return "sb_" + randomBytes(24).toString("base64url");
}

/* ── Autoservicio: cuentas PROPIAS del sandbox ──────────────────────────────
 *
 * El sandbox es un producto independiente — un clon de WhatsApp que puede
 * servirle a cualquier proyecto — así que las cuentas son suyas: quien quiera
 * probar se registra aquí con email y contraseña y su negocio nace solo. Nada
 * de validar contra otra plataforma.
 *
 * La contraseña se guarda con scrypt (sal propia por cuenta, comparación en
 * tiempo constante). La clave `sb_…` sigue siendo lo que aísla por debajo,
 * pero quien se registra no la ve nunca.
 */
import { scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

/* Asíncrono a propósito: `scryptSync` tarda ~30 ms y corre en el hilo único.
   Unas decenas de intentos de entrada por segundo —sin credenciales, sin
   registrarse— dejaban mudo el sandbox entero para todos los inquilinos. */
const scrypt = promisify(scryptCb);

const hashDeContrasena = async (contrasena) => {
  const s = randomBytes(16).toString("hex");
  return s + ":" + (await scrypt(contrasena, s, 32)).toString("hex");
};
const contrasenaCuadra = async (contrasena, guardado) => {
  const [s, hash] = String(guardado || "").split(":");
  if (!s || !hash) return false;
  const a = await scrypt(contrasena, s, 32);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function registrarse(req, res) {
  const nombre = String(req.body?.nombre || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const contrasena = String(req.body?.password || "");
  if (!nombre || !email || !contrasena) {
    return res.status(400).json({ error: "Hacen falta el nombre del negocio, el email y una contraseña." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Ese email no tiene pinta de email." });
  }
  if (contrasena.length < 6) {
    return res.status(400).json({ error: "La contraseña necesita al menos 6 caracteres." });
  }
  if (db.prepare(`SELECT 1 FROM duenos WHERE email = ?`).get(email)) {
    return res.status(409).json({ error: "Ya hay una cuenta con ese email. Entra con tu contraseña." });
  }
  const d = {
    id: "sb" + randomBytes(6).toString("hex"),
    nombre, email,
    clave: nuevaClaveDeNegocio(),
    pass_hash: await hashDeContrasena(contrasena),
    creado: Date.now(),
  };
  db.prepare(
    `INSERT INTO duenos (id, nombre, clave, email, pass_hash, creado)
     VALUES (@id, @nombre, @clave, @email, @pass_hash, @creado)`,
  ).run(d);
  /* Su primer negocio nace aquí, con el nombre que acaba de escribir. Volver a
     preguntárselo nada más entrar era pedir dos veces lo mismo. */
  crearNegocio({ dueno: d.id, nombre });
  res.json({ clave: d.clave, nombre: d.nombre });
}

/**
 * El freno de la puerta: cada fallo seguido de la misma cuenta espera un poco
 * más antes de contestar.
 *
 * No es un tope por IP —eso corta a gente de verdad, y ya nos costó registros—
 * sino un retraso al FALLAR: para quien se equivoca de contraseña es medio
 * segundo, y para quien prueba diez mil la puerta se vuelve inútil. Se olvida
 * solo al acertar y a los diez minutos.
 */
const fallosPorCuenta = new Map();          // email → { veces, cuando }
const CASTIGO_MAXIMO_MS = 5000;

function esperaPorFallos(email) {
  const f = fallosPorCuenta.get(email);
  if (!f || Date.now() - f.cuando > 10 * 60000) return 0;
  return Math.min(2 ** Math.min(f.veces, 8) * 40, CASTIGO_MAXIMO_MS);
}

function anotarFallo(email) {
  const f = fallosPorCuenta.get(email);
  fallosPorCuenta.set(email, { veces: (f?.veces ?? 0) + 1, cuando: Date.now() });
  /* El mapa no puede crecer sin fin: es memoria que alimenta quien ataca. */
  if (fallosPorCuenta.size > 5000) {
    for (const [k, v] of fallosPorCuenta) {
      if (Date.now() - v.cuando > 10 * 60000) fallosPorCuenta.delete(k);
    }
  }
}

export async function entrarConCuenta(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const contrasena = String(req.body?.password || "");
  if (!email || !contrasena) return res.status(400).json({ error: "Faltan el email o la contraseña." });
  const espera = esperaPorFallos(email);
  if (espera) await new Promise((v) => setTimeout(v, espera));

  const d = db.prepare(`SELECT * FROM duenos WHERE email = ?`).get(email);
  if (!d || !(await contrasenaCuadra(contrasena, d.pass_hash))) {
    anotarFallo(email);
    return res.status(401).json({ error: "Email o contraseña incorrectos." });
  }
  fallosPorCuenta.delete(email);
  res.json({ clave: d.clave, nombre: d.nombre });
}

/**
 * Un negocio de ensayo en una sola llamada, sin cuenta.
 *
 * Es la puerta del «crear número de prueba con un botón»: una plataforma que
 * quiere probar contra el sandbox la llama desde su servidor y recibe, de
 * vuelta, lo mismo que hoy hay que ir copiando a mano de la pestaña Conectar
 * —número, token, secreto de la app, token de verificación— más la clave para
 * entrar a la pantalla ya dentro. Igual que la conexión de Meta con un clic:
 * genérica, no sabe ni le importa qué plataforma la llama.
 *
 * Sin cuenta a propósito: quien llega por aquí no quiere otro correo y otra
 * contraseña que recordar. El dueño nace con su clave y nada más; entra con el
 * enlace `/?clave=…` que guarda la plataforma que lo creó.
 *
 * Trae un cliente inventado ya creado: un número de prueba sin nadie que le
 * escriba obliga a dar un paso más antes de poder probar nada.
 *
 * El webhook NO se recibe aquí: la plataforma suele necesitar las credenciales
 * para crear su canal y solo entonces sabe a qué dirección avisar. Lo pone
 * después con PATCH /panel/cuentas/:id y la clave, como cualquier dueño. Las
 * entregas siguen limitadas a direcciones públicas (webhooks.js).
 *
 * El freno: sin cuenta, lo único que frena el abuso es un tope por dirección.
 */
const ensayosPorIp = new Map();               // ip → [instantes]
const ENSAYOS_POR_HORA = 10;

function ipDe(req) {
  const reenviada = String(req.get?.("x-forwarded-for") || "").split(",")[0].trim();
  return reenviada || req.socket?.remoteAddress || "?";
}

export function crearEnsayo(req, res) {
  const nombre = String(req.body?.nombre || "").trim().slice(0, 80) || "Negocio de prueba";
  const ip = ipDe(req);
  const ahora = Date.now();
  const recientes = (ensayosPorIp.get(ip) || []).filter((t) => ahora - t < 3600_000);
  if (recientes.length >= ENSAYOS_POR_HORA) {
    return res.status(429).json({ error: "Demasiados números de prueba en la última hora. Prueba más tarde." });
  }
  recientes.push(ahora);
  ensayosPorIp.set(ip, recientes);

  const d = { id: "sb" + randomBytes(6).toString("hex"), nombre, clave: nuevaClaveDeNegocio(), creado: ahora };
  db.prepare(`INSERT INTO duenos (id, nombre, clave, creado) VALUES (@id, @nombre, @clave, @creado)`).run(d);
  const { cuenta, numero } = crearNegocio({ dueno: d.id, nombre });

  const cliente = {
    wa_id: "1809" + String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, "0"),
    numero_id: numero.id, dueno: d.id, nombre: "Cliente de prueba", creado: ahora,
  };
  db.prepare(
    `INSERT INTO contactos (wa_id, numero_id, dueno, nombre, user_id, username, creado)
     VALUES (@wa_id, @numero_id, @dueno, @nombre, NULL, NULL, @creado)`,
  ).run(cliente);

  res.json({
    clave: d.clave,
    waba_id: cuenta.id,
    phone_number_id: numero.id,
    display_phone_number: numero.display_phone_number,
    access_token: cuenta.token,
    app_secret: cuenta.app_secret,
    verify_token: cuenta.verify_token,
    cliente: { wa_id: cliente.wa_id, nombre: cliente.nombre },
  });
}
