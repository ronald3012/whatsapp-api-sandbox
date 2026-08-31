/**
 * El API de la interfaz: lo que Meta no tiene porque en Meta ese papel lo hacen
 * personas con teléfonos. Aquí creas los números del negocio, los clientes
 * falsos, escribes como ellos y provocas los fallos a voluntad.
 *
 * Va aparte del clon (`/v21.0`) a propósito: nada de esto existe en Meta, y
 * mezclarlo ensuciaría la fidelidad de lo que sí existe.
 */
import { Router } from "express";
import multer from "multer";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { nuevoWamid, nuevoId, nuevoUserId, ahora, sobreEntrante, comoLoEnsenaMeta } from "./meta.js";
import { entregar, verificarWebhook } from "./webhooks.js";
import { estaEscribiendo } from "./graph.js";
import { avisar } from "./eventos.js";
import { conClave } from "./acceso.js";
import { crearNegocio } from "./negocio.js";
import { porQueNoEsTelefono } from "./telefonos.js";
import { clienteInventado } from "./nombres.js";

export const panel = Router();

const MEDIOS = process.env.SANDBOX_MEDIOS || resolve(process.cwd(), "datos/medios");
mkdirSync(MEDIOS, { recursive: true });
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * Todo el panel exige la clave del negocio: el dueño sale de ella y de nada
 * más. Antes había un dueño por defecto — con varios negocios en producción,
 * un defecto así es un negocio leyendo los chats de otro.
 */
panel.use(conClave);
const dueno = (req) => req.dueno;

/**
 * El cliente manda una foto o una nota de voz.
 *
 * El archivo entra en el mismo almacén que usa el Graph API, así que la
 * plataforma lo baja por el camino de siempre (resolver el id, luego pedir la
 * URL con el token). Si se sirviera por un atajo, el sandbox no ensayaría la
 * descarga de medios, que es la mitad de lo que se rompe con audio e imágenes.
 */
panel.post("/numeros/:numeroId/subir", subida.single("file"), (req, res) => {
  /* Primero de quién es, y después qué trae: a quien no tiene nada que hacer
     aquí no se le contesta sobre su contenido. */
  if (!suNumero(req, res)) return;
  if (!req.file) return res.status(400).json({ error: "Falta el archivo." });
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  const ruta = resolve(MEDIOS, id);
  writeFileSync(ruta, req.file.buffer);
  db.prepare(
    `INSERT INTO medios (id, numero_id, dueno, mime_type, sha256, file_size, ruta, nombre, creado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, req.params.numeroId, dueno(req), req.file.mimetype,
        createHash("sha256").update(req.file.buffer).digest("hex"),
        req.file.size, ruta, req.file.originalname ?? null, Date.now());
  res.json({ id, mime_type: req.file.mimetype, nombre: req.file.originalname });
});

/**
 * ¿Ese número (o esa cuenta) es de quien pregunta?
 *
 * Filtrar por `dueno` al LEER no basta: si el id viaja en la ruta y solo se usa
 * para escribir, la consulta cuadra igual y se escribe en casa ajena. Pasó con
 * el catálogo y con los contactos —`INSERT OR REPLACE` sobre una llave que
 * incluye el id ajeno— y se llevaba por delante la fila del otro.
 *
 * Por eso, toda ruta con un id en el camino empieza preguntando esto.
 */
function suNumero(req, res) {
  const n = db.prepare(`SELECT * FROM numeros WHERE id = ? AND dueno = ?`)
    .get(req.params.numeroId, dueno(req));
  if (!n) { res.status(404).json({ error: "Ese número no existe." }); return null; }
  return n;
}

function suCuenta(req, res) {
  const c = db.prepare(`SELECT * FROM cuentas WHERE id = ? AND dueno = ?`)
    .get(req.params.cuentaId, dueno(req));
  if (!c) { res.status(404).json({ error: "Ese negocio no existe." }); return null; }
  return c;
}

/* ── Cuentas y números ── */

panel.get("/cuentas", (req, res) => {
  const cuentas = db.prepare(`SELECT * FROM cuentas WHERE dueno = ? ORDER BY creada`).all(dueno(req));
  res.json(cuentas.map((c) => ({
    ...c,
    numeros: db.prepare(`SELECT * FROM numeros WHERE cuenta_id = ?`).all(c.id),
  })));
});

/** Crear un negocio con su número. Es el equivalente a darse de alta en Meta. */
panel.post("/cuentas", (req, res) => {
  const { nombre, telefono, webhook_url } = req.body || {};
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del negocio." });
  res.json(crearNegocio({ dueno: dueno(req), nombre, telefono, webhook_url }));
});

panel.patch("/cuentas/:id", (req, res) => {
  const { webhook_url, nombre } = req.body || {};
  const c = db.prepare(`SELECT * FROM cuentas WHERE id = ? AND dueno = ?`).get(req.params.id, dueno(req));
  if (!c) return res.status(404).json({ error: "Ese negocio no existe." });

  if (webhook_url !== undefined) {
    db.prepare(`UPDATE cuentas SET webhook_url = ? WHERE id = ?`).run(webhook_url || null, c.id);
  }
  if (nombre !== undefined) {
    const n = String(nombre).trim();
    if (!n) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
    db.prepare(`UPDATE cuentas SET nombre = ? WHERE id = ?`).run(n, c.id);
    /* El nombre verificado del número es lo que la plataforma ENSEÑA del
       negocio: dejarlo con el nombre viejo sería renombrar a medias. */
    db.prepare(`UPDATE numeros SET verified_name = ? WHERE cuenta_id = ?`).run(n, c.id);
  }
  res.json({ ok: true });
});

panel.delete("/cuentas/:id", (req, res) => {
  /* Contestar «ok» sin haber borrado nada le dice a quien prueba con ids
     ajenos que ese id existe, y a quien borra el suyo que salió bien cuando
     quizá no. Si no había nada que borrar, no existe. */
  const r = db.prepare(`DELETE FROM cuentas WHERE id = ? AND dueno = ?`).run(req.params.id, dueno(req));
  if (!r.changes) return res.status(404).json({ error: "Ese negocio no existe." });
  res.json({ ok: true });
});

/* ── Contactos: la gente falsa ── */

panel.get("/numeros/:numeroId/contactos", (req, res) => {
  res.json(db.prepare(
    `SELECT * FROM contactos WHERE numero_id = ? AND dueno = ? ORDER BY creado`,
  ).all(req.params.numeroId, dueno(req)));
});

/**
 * Un cliente falso. Si se pide `oculto`, se le da user_id y username y NO
 * teléfono: así llega quien usa WhatsApp solo con nombre de usuario. Ese sobre
 * viene sin `wa_id` y ya nos rompió el guardado de contactos una vez.
 */
panel.post("/numeros/:numeroId/contactos", (req, res) => {
  if (!suNumero(req, res)) return;
  const { nombre, telefono, oculto, username } = req.body || {};
  if (!nombre) return res.status(400).json({ error: "Falta el nombre." });
  /* Un cliente de mentira con un número imposible es un ensayo que miente:
     contra Meta ese número no existiría. Si no se pone ninguno, se inventa uno
     con su código de país. */
  if (telefono) {
    const mal = porQueNoEsTelefono(telefono);
    if (mal) return res.status(400).json({ error: `Ese número no vale: ${mal}.` });
  }
  const waId = String(telefono || "").replace(/\D/g, "") || ("1809" + nuevoId(7).slice(0, 7));
  /**
   * Un número que ya es de alguien NO se pisa.
   *
   * Con `INSERT OR REPLACE`, crear un cliente con un número repetido borraba al
   * anterior: su nombre desaparecía y su conversación se quedaba huérfana en la
   * lista. Un teléfono identifica a UNA persona, aquí y en WhatsApp.
   */
  const yaEs = db.prepare(`SELECT nombre FROM contactos WHERE wa_id = ? AND numero_id = ?`)
    .get(waId, req.params.numeroId);
  if (yaEs) {
    return res.status(409).json({ error: `Ese número ya es de ${yaEs.nombre}.` });
  }

  const c = {
    wa_id: waId,
    numero_id: req.params.numeroId,
    dueno: dueno(req),
    nombre,
    user_id: oculto ? nuevoUserId() : null,
    username: oculto ? (username || nombre.toLowerCase().replace(/\s+/g, "")) : null,
    creado: Date.now(),
  };
  db.prepare(
    `INSERT INTO contactos (wa_id, numero_id, dueno, nombre, user_id, username, creado)
     VALUES (@wa_id, @numero_id, @dueno, @nombre, @user_id, @username, @creado)`,
  ).run(c);
  res.json(c);
});

/**
 * Un cliente inventado que todavía no existe aquí, para llegar el formulario
 * escrito. Quien quiera uno concreto, lo cambia; quien solo quiera gente con
 * la que probar, le da a crear y ya.
 */
panel.get("/numeros/:numeroId/cliente-inventado", (req, res) => {
  if (!suNumero(req, res)) return;
  const existe = db.prepare(`SELECT 1 FROM contactos WHERE wa_id = ? AND numero_id = ?`);
  const c = clienteInventado((tel) => !!existe.get(tel, req.params.numeroId));
  if (!c) return res.status(409).json({ error: "Ya usaste todos los números de ensayo de este negocio." });
  res.json(c);
});

/**
 * Renombrar o cambiarle la foto a un contacto. La foto va al mismo almacén de
 * medios y se sirve por la misma ruta con token: nada de rutas especiales.
 */
panel.patch("/numeros/:numeroId/contactos/:waId", (req, res) => {
  const { nombre } = req.body || {};
  if (!String(nombre || "").trim()) return res.status(400).json({ error: "Falta el nombre." });
  db.prepare(`UPDATE contactos SET nombre = ? WHERE wa_id = ? AND numero_id = ? AND dueno = ?`)
    .run(String(nombre).trim(), req.params.waId, req.params.numeroId, dueno(req));
  res.json({ ok: true });
});

panel.post("/numeros/:numeroId/contactos/:waId/foto", subida.single("file"), (req, res) => {
  if (!suNumero(req, res)) return;
  if (!req.file || !req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "Manda una imagen." });
  }
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  const ruta = resolve(MEDIOS, id);
  writeFileSync(ruta, req.file.buffer);
  db.prepare(
    `INSERT INTO medios (id, numero_id, dueno, mime_type, sha256, file_size, ruta, nombre, creado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, req.params.numeroId, dueno(req), req.file.mimetype,
        createHash("sha256").update(req.file.buffer).digest("hex"),
        req.file.size, ruta, req.file.originalname ?? null, Date.now());
  db.prepare(`UPDATE contactos SET foto = ? WHERE wa_id = ? AND numero_id = ? AND dueno = ?`)
    .run(id, req.params.waId, req.params.numeroId, dueno(req));
  res.json({ ok: true, foto: id });
});

/**
 * Vaciar la conversación SIN borrar el contacto: es lo que se quiere al
 * repetir un ensayo desde cero — mismo cliente, historia limpia. Ojo: esto
 * borra solo del sandbox; lo que tu plataforma ya guardó es suyo.
 */
panel.delete("/numeros/:numeroId/contactos/:waId/mensajes", (req, res) => {
  const r = db.prepare(`DELETE FROM mensajes WHERE numero_id = ? AND wa_id = ? AND dueno = ?`)
    .run(req.params.numeroId, req.params.waId, dueno(req));
  res.json({ borrados: r.changes });
});

/** Eliminar el contacto entero, con su conversación. */
panel.delete("/numeros/:numeroId/contactos/:waId", (req, res) => {
  db.prepare(`DELETE FROM mensajes WHERE numero_id = ? AND wa_id = ? AND dueno = ?`)
    .run(req.params.numeroId, req.params.waId, dueno(req));
  const r = db.prepare(`DELETE FROM contactos WHERE wa_id = ? AND numero_id = ? AND dueno = ?`)
    .run(req.params.waId, req.params.numeroId, dueno(req));
  res.json({ ok: r.changes > 0 });
});

/* ── Conversación ── */

panel.get("/numeros/:numeroId/mensajes", (req, res) => {
  const { waId } = req.query;
  /* Con tope y del revés: sin `LIMIT`, un ensayo largo devolvía miles de filas
     —y la lista de chats pide una conversación por contacto—, con SQLite
     síncrono bloqueando el hilo de todos. Se devuelven las últimas y se vuelven
     a poner en orden. */
  const tope = Math.min(Math.max(Number(req.query.limite) || 300, 1), 1000);
  const filas = db.prepare(
    `SELECT * FROM mensajes WHERE numero_id = ? AND wa_id = ? AND dueno = ?
      ORDER BY cuando DESC LIMIT ?`,
  ).all(req.params.numeroId, String(waId || ""), dueno(req), tope);
  res.json(filas.reverse());
});

/**
 * Escribirle al negocio HACIÉNDOSE PASAR por el cliente. Esto es lo que en la
 * vida real hace una persona con su teléfono, y es la razón de que exista todo
 * esto: poder hacerlo mil veces sin molestar a nadie.
 */
panel.post("/numeros/:numeroId/entrante", async (req, res) => {
  const { waId, texto, tipo = "text", respondeA, media } = req.body || {};
  const numero = db.prepare(`SELECT * FROM numeros WHERE id = ? AND dueno = ?`)
    .get(req.params.numeroId, dueno(req));
  if (!numero) return res.status(404).json({ error: "Ese número no existe." });
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE id = ?`).get(numero.cuenta_id);
  const contacto = db.prepare(`SELECT * FROM contactos WHERE wa_id = ? AND numero_id = ?`)
    .get(String(waId), numero.id);
  if (!contacto) return res.status(404).json({ error: "Ese contacto no existe." });

  /* El medio tiene que ser uno REAL y del mismo dueño. Sin esto, el `id` era
     texto libre que acababa dentro de un atributo de la pantalla; y contra Meta
     un id inventado tampoco existiría. */
  if (media?.id && !db.prepare(`SELECT 1 FROM medios WHERE id = ? AND dueno = ?`).get(String(media.id), dueno(req))) {
    return res.status(404).json({ error: "Ese archivo no existe." });
  }
  /* Y el texto, con el mismo tope que impone Meta al salir. */
  if (String(texto || "").length > 4096) {
    return res.status(400).json({ error: "El texto pasa de 4096 caracteres." });
  }

  const wamid = nuevoWamid();
  const mensaje = {
    from: contacto.user_id && !contacto.wa_id ? undefined : contacto.wa_id,
    id: wamid,
    timestamp: String(ahora()),
    type: tipo,
    ...(respondeA ? { context: { from: numero.display_phone_number, id: respondeA } } : {}),
  };
  if (tipo === "text") mensaje.text = { body: texto ?? "" };
  else if (media) {
    // El caption va DENTRO del objeto del medio, como en Meta. Ponerlo fuera
    // haría que la plataforma lo perdiera — que es justo el bug que perseguimos.
    mensaje[tipo] = { id: media.id, mime_type: media.mime_type, ...(texto ? { caption: texto } : {}) };
  }
  // Si el contacto va oculto tras su usuario, el sobre trae user_id y no from.
  if (contacto.user_id) mensaje.user_id = contacto.user_id;

  db.prepare(
    `INSERT INTO mensajes (id, numero_id, dueno, wa_id, direccion, tipo, cuerpo, texto, responde_a, cuando)
     VALUES (?, ?, ?, ?, 'entrante', ?, ?, ?, ?, ?)`,
  ).run(wamid, numero.id, dueno(req), contacto.wa_id, tipo,
        JSON.stringify(mensaje), texto ?? "", respondeA ?? null, Date.now());

  const r = await entregar({
    cuenta,
    numero,
    sobre: sobreEntrante({ waba: cuenta.id, numero, contacto, mensaje }),
  });
  avisar({ tipo: "mensaje", numeroId: numero.id, waId: contacto.wa_id }, dueno(req));
  /**
   * El estado de LO QUE MANDA EL CLIENTE, que es lo que él ve en su teléfono:
   *
   *   ✓    salió de aquí
   *   ✓✓   el negocio lo recibió (su webhook contestó 200)
   *   ✓✓   en azul, cuando el agente lo marca leído
   *
   * Antes se quedaba sin estado y el cliente no veía ni un tilde: en WhatsApp
   * eso solo pasa cuando el mensaje no ha salido del teléfono, así que parecía
   * roto justo cuando todo iba bien.
   */
  db.prepare(`UPDATE mensajes SET estado = ? WHERE id = ?`).run(r.ok ? "delivered" : "sent", wamid);
  res.json({ id: wamid, entrega: r });
});

/** Marcar como leído lo que el negocio mandó: el ✓✓ azul, cuando tú quieras. */
panel.post("/numeros/:numeroId/leer", async (req, res) => {
  const { waId } = req.body || {};
  const numero = db.prepare(`SELECT * FROM numeros WHERE id = ? AND dueno = ?`)
    .get(req.params.numeroId, req.dueno);
  if (!numero) return res.status(404).json({ error: "Ese número no existe." });
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE id = ?`).get(numero.cuenta_id);
  const pendientes = db.prepare(
    `SELECT id FROM mensajes WHERE numero_id = ? AND wa_id = ? AND direccion = 'saliente'
       AND (estado IS NULL OR estado IN ('accepted','sent','delivered'))`,
  ).all(numero.id, String(waId));
  const { sobreEstado } = await import("./meta.js");
  for (const m of pendientes) {
    db.prepare(`UPDATE mensajes SET estado = 'read' WHERE id = ?`).run(m.id);
    await entregar({
      cuenta, numero,
      sobre: sobreEstado({
        waba: cuenta.id, numero,
        estado: { id: m.id, status: "read", timestamp: String(ahora()), recipient_id: String(waId) },
      }),
    });
  }
  avisar({ tipo: 'estado', numeroId: numero.id, waId: String(waId) }, dueno(req));
  res.json({ leidos: pendientes.length });
});

/**
 * ¿El negocio está «escribiendo…»?
 *
 * En WhatsApp de verdad esto lo ve el cliente en su teléfono. Aquí lo ve la
 * interfaz, para poder comprobar que el agente lo manda de verdad y no solo que
 * la llamada no dio error.
 */
panel.get("/numeros/:numeroId/escribiendo", (req, res) => {
  if (!db.prepare(`SELECT 1 FROM numeros WHERE id = ? AND dueno = ?`).get(req.params.numeroId, req.dueno)) {
    return res.status(404).json({ error: "Ese número no existe." });
  }
  const e = estaEscribiendo(req.params.numeroId);
  res.json({ escribiendo: !!e, waId: e?.waId ?? null });
});

/* ── Reglas: provocar fallos ── */

panel.get("/reglas", (req, res) => {
  res.json(db.prepare(`SELECT * FROM reglas WHERE dueno = ? ORDER BY id`).all(dueno(req)));
});

panel.post("/reglas", (req, res) => {
  const { numeroId, waId, clase, codigo, veces = 1 } = req.body || {};
  if (!numeroId || !clase) return res.status(400).json({ error: "Hacen falta numeroId y clase." });
  if (!db.prepare(`SELECT 1 FROM numeros WHERE id = ? AND dueno = ?`).get(numeroId, dueno(req))) {
    return res.status(404).json({ error: "Ese número no existe." });
  }
  const r = db.prepare(
    `INSERT INTO reglas (dueno, numero_id, wa_id, clase, codigo, veces, creada)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(dueno(req), numeroId, waId || null, clase, codigo || null, veces, Date.now());
  res.json({ id: r.lastInsertRowid });
});

panel.delete("/reglas/:id", (req, res) => {
  db.prepare(`DELETE FROM reglas WHERE id = ? AND dueno = ?`).run(req.params.id, dueno(req));
  res.json({ ok: true });
});

/* ── Plantillas: aprobar o rechazar como haría Meta ── */

panel.post("/plantillas/:id/estado", (req, res) => {
  const { estado } = req.body || {};
  if (!["APPROVED", "REJECTED", "PENDING"].includes(estado)) {
    return res.status(400).json({ error: "Estado no válido." });
  }
  db.prepare(`UPDATE plantillas SET estado = ? WHERE id = ? AND dueno = ?`)
    .run(estado, req.params.id, dueno(req));
  res.json({ ok: true });
});

panel.get("/plantillas", (req, res) => {
  res.json(db.prepare(`SELECT * FROM plantillas WHERE dueno = ? ORDER BY creada DESC`).all(dueno(req)));
});

/**
 * El cliente REACCIONA a un mensaje del negocio.
 *
 * Una plataforma guarda las reacciones aparte —tipo `reaction`, con el wamid al que
 * apuntan— y ese camino no se ejercitaba con nada. Un emoji vacío quita la
 * reacción, igual que en WhatsApp.
 */
panel.post("/numeros/:numeroId/reaccion", async (req, res) => {
  const { waId, aQue, emoji } = req.body || {};
  const { numero, cuenta, contacto, error } = await elQuien(req.params.numeroId, waId, req.dueno);
  if (error) return res.status(404).json({ error });

  const wamid = nuevoWamid();
  const mensaje = {
    from: contacto.wa_id, id: wamid, timestamp: String(ahora()), type: "reaction",
    reaction: { message_id: String(aQue), emoji: emoji ?? "" },
    ...(contacto.user_id ? { user_id: contacto.user_id } : {}),
  };
  db.prepare(
    `INSERT INTO mensajes (id, numero_id, dueno, wa_id, direccion, tipo, cuerpo, texto, responde_a, estado, cuando)
     VALUES (?, ?, ?, ?, 'entrante', 'reaction', ?, ?, ?, 'delivered', ?)`,
  ).run(wamid, numero.id, dueno(req), contacto.wa_id, JSON.stringify(mensaje),
        emoji ?? "", String(aQue), Date.now());
  const r = await entregar({ cuenta, numero, sobre: sobreEntrante({ waba: cuenta.id, numero, contacto, mensaje }) });
  avisar({ tipo: 'mensaje', numeroId: numero.id, waId: contacto.wa_id }, dueno(req));
  res.json({ id: wamid, entrega: r });
});

/**
 * El cliente PULSA UN BOTÓN o elige de una lista.
 *
 * Llega como `interactive` con `button_reply` o `list_reply`: un id interno y
 * el título que vio la persona. Se parsea en un camino que casi nunca se prueba — y es
 * tráfico real, porque las plantillas y los menús llevan botones.
 */
panel.post("/numeros/:numeroId/interactivo", async (req, res) => {
  const { waId, id, titulo, lista } = req.body || {};
  const { numero, cuenta, contacto, error } = await elQuien(req.params.numeroId, waId, req.dueno);
  if (error) return res.status(404).json({ error });

  const wamid = nuevoWamid();
  const respuesta = lista
    ? { type: "list_reply", list_reply: { id: String(id), title: String(titulo || ""), description: "" } }
    : { type: "button_reply", button_reply: { id: String(id), title: String(titulo || "") } };
  const mensaje = {
    from: contacto.wa_id, id: wamid, timestamp: String(ahora()), type: "interactive",
    interactive: respuesta,
    ...(contacto.user_id ? { user_id: contacto.user_id } : {}),
  };
  db.prepare(
    `INSERT INTO mensajes (id, numero_id, dueno, wa_id, direccion, tipo, cuerpo, texto, estado, cuando)
     VALUES (?, ?, ?, ?, 'entrante', 'interactive', ?, ?, 'delivered', ?)`,
  ).run(wamid, numero.id, dueno(req), contacto.wa_id, JSON.stringify(mensaje), String(titulo || id), Date.now());
  const r = await entregar({ cuenta, numero, sobre: sobreEntrante({ waba: cuenta.id, numero, contacto, mensaje }) });
  avisar({ tipo: 'mensaje', numeroId: numero.id, waId: contacto.wa_id }, dueno(req));
  res.json({ id: wamid, entrega: r });
});

/**
 * Volver a entregar un mensaje que YA se entregó, con su mismo id.
 *
 * Es lo que hace Meta cuando tu servidor no contestó: reintenta hasta 7 días.
 * Una plataforma seria trae un dedupe para no duplicar, y ese código no se
 * había ejercitado nunca; si falla, cada caída duplica la conversación entera
 * al volver.
 */
panel.post("/numeros/:numeroId/reentregar", async (req, res) => {
  const { wamid } = req.body || {};
  const m = db.prepare(`SELECT * FROM mensajes WHERE id = ? AND numero_id = ? AND dueno = ?`).get(String(wamid), req.params.numeroId, req.dueno);
  if (!m) return res.status(404).json({ error: "Ese mensaje no existe." });
  const { numero, cuenta, contacto, error } = await elQuien(req.params.numeroId, m.wa_id, req.dueno);
  if (error) return res.status(404).json({ error });
  const mensaje = JSON.parse(m.cuerpo || "{}");
  const r = await entregar({ cuenta, numero, sobre: sobreEntrante({ waba: cuenta.id, numero, contacto, mensaje }) });
  avisar({ tipo: 'mensaje', numeroId: numero.id, waId: contacto.wa_id }, dueno(req));
  res.json({ reentregado: m.id, entrega: r });
});

/** El apretón de manos de verificación, el que hace Meta antes de suscribirse. */
panel.post("/cuentas/:cuentaId/verificar", async (req, res) => {
  const c = db.prepare(`SELECT * FROM cuentas WHERE id = ? AND dueno = ?`).get(req.params.cuentaId, dueno(req));
  if (!c) return res.status(404).json({ error: "Esa cuenta no existe." });
  res.json(await verificarWebhook(c));
});

/** Lo de siempre al empezar cualquiera de estas: número, cuenta y contacto. */
async function elQuien(numeroId, waId, dueno) {
  const numero = db.prepare(`SELECT * FROM numeros WHERE id = ? AND dueno = ?`).get(numeroId, dueno);
  if (!numero) return { error: "Ese número no existe." };
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE id = ?`).get(numero.cuenta_id);
  const contacto = db.prepare(`SELECT * FROM contactos WHERE wa_id = ? AND numero_id = ?`).get(String(waId), numero.id);
  if (!contacto) return { error: "Ese contacto no existe." };
  return { numero, cuenta, contacto };
}

/* ── Catálogo y carrito ── */

panel.get("/cuentas/:cuentaId/productos", (req, res) => {
  if (!suCuenta(req, res)) return;
  res.json(db.prepare(`SELECT * FROM productos WHERE cuenta_id = ? AND dueno = ? ORDER BY creado`)
    .all(req.params.cuentaId, dueno(req)));
});

panel.post("/cuentas/:cuentaId/productos", (req, res) => {
  if (!suCuenta(req, res)) return;
  const { retailer_id, nombre, precio, descripcion } = req.body || {};
  if (!retailer_id || !nombre) return res.status(400).json({ error: "Hacen falta el SKU y el nombre." });
  db.prepare(
    `INSERT OR REPLACE INTO productos (retailer_id, cuenta_id, dueno, nombre, descripcion, precio, moneda, creado)
     VALUES (?, ?, ?, ?, ?, ?, 'DOP', ?)`,
  ).run(String(retailer_id).trim(), req.params.cuentaId, dueno(req), nombre,
        descripcion || null, precio != null && precio !== "" ? Number(precio) : null, Date.now());
  res.json({ ok: true });
});

panel.delete("/cuentas/:cuentaId/productos/:sku", (req, res) => {
  if (!suCuenta(req, res)) return;
  db.prepare(`DELETE FROM productos WHERE cuenta_id = ? AND retailer_id = ? AND dueno = ?`)
    .run(req.params.cuentaId, req.params.sku, dueno(req));
  res.json({ ok: true });
});

/**
 * El cliente manda un CARRITO.
 *
 * Llega como `type: "order"` y —esto es lo importante— **sin nombres**: solo
 * `product_retailer_id`, cantidad y precio. Si el agente no cruza esos códigos
 * con el catálogo, acaba negándole al cliente lo que el cliente acaba de pedir.
 * Ese fallo es real y con Meta no se puede ensayar, porque no deja leer el
 * catálogo de un negocio pequeño.
 */
panel.post("/numeros/:numeroId/carrito", async (req, res) => {
  const { waId, articulos, texto } = req.body || {};
  const numero = db.prepare(`SELECT * FROM numeros WHERE id = ? AND dueno = ?`).get(req.params.numeroId, dueno(req));
  if (!numero) return res.status(404).json({ error: "Ese número no existe." });
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE id = ?`).get(numero.cuenta_id);
  const contacto = db.prepare(`SELECT * FROM contactos WHERE wa_id = ? AND numero_id = ?`).get(String(waId), numero.id);
  if (!contacto) return res.status(404).json({ error: "Ese contacto no existe." });

  const items = (articulos || []).map((a) => {
    const p = db.prepare(`SELECT * FROM productos WHERE retailer_id = ? AND cuenta_id = ? AND dueno = ?`)
      .get(String(a.retailer_id), cuenta.id, dueno(req));
    return {
      product_retailer_id: String(a.retailer_id),
      quantity: Number(a.cantidad || 1),
      item_price: p?.precio ?? 0,
      currency: p?.moneda ?? "DOP",
    };
  });
  if (!items.length) return res.status(400).json({ error: "El carrito viene vacío." });

  const wamid = nuevoWamid();
  const mensaje = {
    from: contacto.wa_id,
    id: wamid,
    timestamp: String(ahora()),
    type: "order",
    order: { catalog_id: `cat_${cuenta.id}`, text: texto || "", product_items: items },
    ...(contacto.user_id ? { user_id: contacto.user_id } : {}),
  };
  const resumen = `[carrito] ${items.length} artículo(s)`;
  db.prepare(
    `INSERT INTO mensajes (id, numero_id, dueno, wa_id, direccion, tipo, cuerpo, texto, cuando)
     VALUES (?, ?, ?, ?, 'entrante', 'order', ?, ?, ?)`,
  ).run(wamid, numero.id, dueno(req), contacto.wa_id, JSON.stringify(mensaje), resumen, Date.now());

  const r = await entregar({ cuenta, numero, sobre: sobreEntrante({ waba: cuenta.id, numero, contacto, mensaje }) });
  db.prepare(`UPDATE mensajes SET estado = ? WHERE id = ?`).run(r.ok ? "delivered" : "sent", wamid);
  res.json({ id: wamid, entrega: r });
});

/* ── El registro de entregas: por qué un webhook no llegó ── */

panel.get("/entregas", (req, res) => {
  /* Por número si se pide: la franja habla del negocio que tienes delante, y
     un fallo de OTRO negocio tuyo ahí es una pista falsa. */
  const numeroId = String(req.query.numeroId || "");
  const filas = numeroId
    ? db.prepare(
        `SELECT id, numero_id, url, estado, error, substr(respuesta,1,200) AS respuesta, cuando
           FROM entregas WHERE dueno = ? AND numero_id = ? ORDER BY id DESC LIMIT 100`,
      ).all(dueno(req), numeroId)
    : db.prepare(
        `SELECT id, numero_id, url, estado, error, substr(respuesta,1,200) AS respuesta, cuando
           FROM entregas WHERE dueno = ? ORDER BY id DESC LIMIT 100`,
      ).all(dueno(req));
  res.json(filas);
});
