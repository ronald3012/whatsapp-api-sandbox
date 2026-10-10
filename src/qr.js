/**
 * WhatsApp por QR (WhatsApp Web / Baileys), de mentira.
 *
 * El resto del sandbox imita el Cloud API de Meta. Esto imita lo otro: un
 * teléfono con WhatsApp normal vinculado por QR, con sus propias reglas, que
 * no son las de Meta:
 *
 *  - Se vincula escaneando un QR. El QR rota (60 s el primero, 20 s los
 *    siguientes) y si nadie lo escanea se cierra con 408, como WhatsApp.
 *  - Tras escanear, WhatsApp pide reiniciar (515) y la línea vuelve sola.
 *  - Sin ventana de 24 horas ni plantillas de Meta: se escribe cuando sea.
 *  - Direcciones LID: cada contacto tiene su LID y su número aparte.
 *  - Grupos: los «entregado/leído» llegan por persona (message-receipt), no
 *    como estado del mensaje.
 *  - Editar solo los 15 minutos siguientes; borrar para todos, hasta 2 días.
 *  - Adjuntos de hasta 16 MB (documentos 100 MB). Una imagen que no sea JPG o
 *    PNG llega «entregada» pero el teléfono no la abre.
 *  - Si la línea está caída, lo que escriben los contactos espera y llega al
 *    reconectar.
 *  - El teléfono puede cerrar la sesión (401) o abrirla en otro sitio (440).
 *
 * RunOp le habla por un WebSocket con su socket-sandbox.ts, que arma los
 * mensajes con Baileys: aquí solo se guarda el mundo (contactos, grupos,
 * líneas, conversaciones) y se decide qué pasa.
 */
import express from "express";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const DATOS = resolve(process.cwd(), "datos");
const ARCHIVO = join(DATOS, "qr.json");
const MEDIOS = join(DATOS, "qr-medios");
mkdirSync(MEDIOS, { recursive: true });

const LIMITE_MEDIA = 16 * 1024 * 1024;
const LIMITE_DOCUMENTO = 100 * 1024 * 1024;
const EDITAR_MS = 15 * 60_000;
const BORRAR_MS = 2 * 24 * 3600_000;

// ── La clave ─────────────────────────────────────────────────────────────
function claveQr() {
  if (process.env.WA_SANDBOX_CLAVE) return process.env.WA_SANDBOX_CLAVE;
  const f = join(DATOS, "qr.clave");
  if (!existsSync(f)) writeFileSync(f, randomBytes(18).toString("base64url"));
  return readFileSync(f, "utf8").trim();
}
const claveValida = (c) => typeof c === "string" && c.length > 0 && c === claveQr();

// ── El mundo ─────────────────────────────────────────────────────────────
let mundo = { lineas: {}, contactos: [], grupos: [], mensajes: [] };
try { mundo = { ...mundo, ...JSON.parse(readFileSync(ARCHIVO, "utf8")) }; } catch { /* primera vez */ }
let guardando = null;
function guardar() {
  if (guardando) return;
  guardando = setTimeout(() => {
    guardando = null;
    // Solo los últimos 3000 mensajes: es un sandbox, no un archivo.
    if (mundo.mensajes.length > 3000) mundo.mensajes = mundo.mensajes.slice(-3000);
    writeFileSync(ARCHIVO, JSON.stringify(mundo));
  }, 200);
}

const digitos = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const nuevoNumero = () => `1809555${digitos(4)}`;
const nuevoLid = () => `${1 + Math.floor(Math.random() * 9)}${digitos(14)}`;
const idTelefono = () => "3A" + randomBytes(9).toString("hex").toUpperCase();
const ahora = () => Date.now();

function persona(c) { return { lid: `${c.lid}@lid`, pn: c.pn, nombre: c.nombre }; }
function contactoPorJid(jid) {
  const u = String(jid || "").split("@")[0].split(":")[0];
  return mundo.contactos.find((c) => c.pn === u || c.lid === u) || null;
}
function grupo(jid) { return mundo.grupos.find((g) => g.id === jid) || null; }

// ── Las pantallas (SSE) ──────────────────────────────────────────────────
const pantallas = new Set();
function avisar(evento) {
  const linea = `data: ${JSON.stringify(evento)}\n\n`;
  for (const r of pantallas) { try { r.write(linea); } catch { pantallas.delete(r); } }
}

// ── Las conexiones de RunOp ──────────────────────────────────────────────
/** instancia → { ws, fase: 'qr' | 'abierta', qr, temporizador, intentosQr } */
const conexiones = new Map();

function enviar(ws, datos) {
  try { ws.send(JSON.stringify(datos, (_k, v) => (v && v.type === "Buffer" && Array.isArray(v.data) ? { type: "Buffer", data: Buffer.from(v.data).toString("base64") } : v))); } catch { /* se fue */ }
}
function aLinea(instancia, datos) {
  const c = conexiones.get(instancia);
  if (c?.fase === "abierta") { enviar(c.ws, datos); return true; }
  return false;
}

function lidsDelMundo() {
  const r = {};
  for (const c of mundo.contactos) r[`${c.lid}@lid`] = `${c.pn}@s.whatsapp.net`;
  for (const l of Object.values(mundo.lineas)) r[`${l.lid}@lid`] = `${l.numero}@s.whatsapp.net`;
  return r;
}

function estadoLinea(instancia) {
  const c = conexiones.get(instancia);
  if (!c) return "desconectada";
  return c.fase === "abierta" ? "conectada" : "esperando_qr";
}

function rotarQr(instancia) {
  const c = conexiones.get(instancia);
  if (!c || c.fase !== "qr") return;
  c.intentosQr = (c.intentosQr || 0) + 1;
  if (c.intentosQr > 5) {
    // Como WhatsApp: se acabaron los QR y nadie escaneó.
    enviar(c.ws, { t: "cerrar", codigo: 408, motivo: "QR refs attempts ended" });
    c.qr = null;
    avisar({ tipo: "lineas" });
    return;
  }
  c.qr = `2@${randomBytes(24).toString("base64")},${randomBytes(32).toString("base64")},${randomBytes(32).toString("base64")},${randomBytes(16).toString("base64")}`;
  enviar(c.ws, { t: "qr", code: c.qr });
  avisar({ tipo: "lineas" });
  c.temporizador = setTimeout(() => rotarQr(instancia), c.intentosQr === 1 ? 60_000 : 20_000);
}

function abrir(instancia) {
  const c = conexiones.get(instancia);
  const l = mundo.lineas[instancia];
  if (!c || !l) return;
  c.fase = "abierta";
  enviar(c.ws, {
    t: "abierta",
    user: { id: `${l.numero}:7@s.whatsapp.net`, lid: `${l.lid}:7@lid`, name: l.nombre },
    lids: lidsDelMundo(),
  });
  avisar({ tipo: "lineas" });
  // Lo que escribieron con la línea caída llega ahora, en orden.
  setTimeout(() => {
    for (const m of mundo.mensajes.filter((x) => x.instancia === instancia && x.pendiente)) {
      if (aLinea(instancia, m.pendiente)) delete m.pendiente;
    }
    guardar();
  }, 300);
}

function alConectar(ws, instancia) {
  const vieja = conexiones.get(instancia);
  if (vieja) { clearTimeout(vieja.temporizador); try { vieja.ws.close(); } catch {} }
  const c = { ws, fase: "nueva", qr: null, temporizador: null, intentosQr: 0 };
  conexiones.set(instancia, c);

  ws.on("message", (crudo) => {
    let d;
    try { d = JSON.parse(String(crudo)); } catch { return; }
    try { alMensajeDeRunOp(instancia, c, d); }
    catch (err) {
      console.error("[qr] fallo atendiendo a RunOp:", err);
      if (d?.id) enviar(ws, { t: "resp", id: d.id, error: String(err?.message || err) });
    }
  });
  ws.on("close", () => {
    clearTimeout(c.temporizador);
    if (conexiones.get(instancia) === c) conexiones.delete(instancia);
    avisar({ tipo: "lineas" });
  });
}

function alMensajeDeRunOp(instancia, c, d) {
  const responder = (datos, error) => enviar(c.ws, { t: "resp", id: d.id, ...(error ? { error } : { datos }) });
  const l = mundo.lineas[instancia];
  switch (d.t) {
    case "hola": {
      if (d.me?.id) {
        const numero = String(d.me.id).split(/[:@]/)[0];
        if (l && l.numero === numero) return abrir(instancia);
        // El teléfono ya no tiene esta sesión vinculada: WhatsApp dice 401.
        enviar(c.ws, { t: "cerrar", codigo: 401, motivo: "Connection Failure (logged out)" });
        return;
      }
      c.fase = "qr";
      rotarQr(instancia);
      return;
    }
    case "enviar": return recibirDeLaLinea(instancia, d, responder);
    case "existe": {
      const r = (d.jids || []).map((jid) => {
        const k = contactoPorJid(jid);
        return k && !k.sinWhatsApp ? { exists: true, jid: `${k.pn}@s.whatsapp.net` } : { exists: false, jid };
      });
      return responder(r);
    }
    case "grupos": {
      const r = {};
      for (const g of mundo.grupos.filter((x) => x.lineas.includes(instancia))) {
        r[g.id] = {
          id: g.id, subject: g.nombre, owner: l ? `${l.lid}@lid` : undefined, creation: Math.floor(g.creado / 1000),
          addressingMode: "lid", size: g.miembros.length + g.lineas.length,
          participants: [
            ...g.lineas.map((i) => mundo.lineas[i]).filter(Boolean).map((x) => ({ id: `${x.lid}@lid`, phoneNumber: `${x.numero}@s.whatsapp.net`, admin: "admin" })),
            ...g.miembros.map((id) => mundo.contactos.find((k) => k.id === id)).filter(Boolean).map((k) => ({ id: `${k.lid}@lid`, phoneNumber: `${k.pn}@s.whatsapp.net`, admin: null })),
          ],
        };
      }
      return responder(r);
    }
    case "leidos": {
      const ids = new Set((d.claves || []).map((k) => k.id));
      for (const m of mundo.mensajes) if (m.instancia === instancia && ids.has(m.id)) m.leidoPorLinea = true;
      guardar();
      avisar({ tipo: "mensajes", instancia });
      return;
    }
    case "presencia": {
      if (!d.jid) return;
      const chat = String(d.jid).endsWith("@g.us") ? d.jid : contactoPorJid(d.jid) ? `contacto:${contactoPorJid(d.jid).id}` : null;
      if (chat) avisar({ tipo: "escribiendo", instancia, chat, quien: "linea", estado: d.estado });
      return;
    }
    case "suscribir": return;
    case "salir": {
      // La sesión se cerró desde RunOp: el teléfono ve desaparecer el dispositivo.
      delete mundo.lineas[instancia];
      guardar();
      avisar({ tipo: "lineas" });
      return;
    }
  }
}

/** Un mensaje que la LÍNEA (RunOp) mandó. Llega ya armado por Baileys. */
function recibirDeLaLinea(instancia, d, responder) {
  const msg = d.msg;
  const jid = msg?.key?.remoteJid;
  if (!jid) return responder(null, "mensaje sin destino");
  let chat;
  if (jid.endsWith("@g.us")) {
    const g = grupo(jid);
    if (!g || !g.lineas.includes(instancia)) return responder(null, "not-authorized: la línea no está en ese grupo");
    chat = jid;
  } else {
    const k = contactoPorJid(jid);
    if (!k || k.sinWhatsApp) return responder(null, "ese número no tiene WhatsApp");
    chat = `contacto:${k.id}`;
  }
  const interno = sinEnvoltorio(msg.message);
  const tipo = Object.keys(interno || {}).find((x) => x === "conversation" || x.endsWith("Message"));
  const ctx = interno?.[tipo]?.contextInfo || {};
  const vista = { ...(d.vista || {}) };
  if (vista.base64 && typeof vista.base64 === "string") {
    vista.medio = guardarClaro(Buffer.from(vista.base64, "base64"));
    delete vista.base64;
  } else if (vista.base64?.url) {
    vista.url = vista.base64.url;
    delete vista.base64;
  }
  if (vista.tipo === "imagen" && vista.mimetype && !/^image\/(jpeg|png)$/.test(vista.mimetype)) {
    vista.noAbre = true; // WhatsApp la entrega, pero el teléfono no la pinta
  }
  const m = {
    id: msg.key.id, instancia, chat, de: "linea", ts: ahora(), vista,
    citado: ctx.stanzaId || null,
    menciones: (ctx.mentionedJid || []).map(nombreDeJid),
    estado: "enviado",
  };
  mundo.mensajes.push(m);
  guardar();
  responder({ ok: true });
  avisar({ tipo: "mensajes", instancia, chat });
  // Entregado al rato, como un teléfono con señal.
  setTimeout(() => entregar(instancia, m), 700);
}

function entregar(instancia, m) {
  if (m.estado !== "enviado") return;
  if (m.chat.startsWith("contacto:")) {
    const k = mundo.contactos.find((x) => `contacto:${x.id}` === m.chat);
    if (!k || k.sinSenal) return; // llegará cuando tenga señal
    m.estado = "entregado";
    aLinea(instancia, { t: "acuse", chat: `${k.lid}@lid`, ids: [m.id], estado: "entregado" });
  } else {
    const g = grupo(m.chat);
    m.estado = "entregado";
    for (const id of g?.miembros || []) {
      const k = mundo.contactos.find((x) => x.id === id);
      if (k && !k.sinSenal) aLinea(instancia, { t: "acuse", chat: m.chat, ids: [m.id], estado: "entregado", participante: `${k.lid}@lid` });
    }
  }
  guardar();
  avisar({ tipo: "mensajes", instancia, chat: m.chat });
}

function sinEnvoltorio(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const w = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage || m.editedMessage;
    if (!w?.message) break;
    m = w.message;
  }
  return m;
}

function nombreDeJid(jid) {
  const u = String(jid).split("@")[0].split(":")[0];
  const k = mundo.contactos.find((c) => c.lid === u || c.pn === u);
  if (k) return k.nombre;
  const l = Object.values(mundo.lineas).find((x) => x.lid === u || x.numero === u);
  return l ? l.nombre : u;
}

function guardarClaro(bytes) {
  const token = randomBytes(12).toString("hex");
  writeFileSync(join(MEDIOS, `claro-${token}`), bytes);
  return token;
}

// ── Lo que hace un contacto de mentira ───────────────────────────────────

/** De un texto con «@Nombre» saca las menciones como las manda WhatsApp: «@<lid>» y la lista de jids. */
function menciones(texto, instancia, chat) {
  const candidatos = [];
  const g = chat.endsWith("@g.us") ? grupo(chat) : null;
  const l = mundo.lineas[instancia];
  if (l) candidatos.push({ nombre: l.nombre, lid: l.lid });
  for (const id of g?.miembros || []) {
    const k = mundo.contactos.find((x) => x.id === id);
    if (k) candidatos.push({ nombre: k.nombre, lid: k.lid });
  }
  candidatos.sort((a, b) => b.nombre.length - a.nombre.length);
  const jids = [];
  let salida = texto;
  for (const c of candidatos) {
    const patron = new RegExp(`@${c.nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    if (patron.test(salida)) {
      salida = salida.replace(patron, `@${c.lid}`);
      jids.push(`${c.lid}@lid`);
    }
  }
  return { texto: salida, jids };
}

function entranteDe(instancia, chat, autor, contenido, extra = {}) {
  const k = mundo.contactos.find((x) => x.id === autor);
  const chatJid = chat.startsWith("contacto:")
    ? `${mundo.contactos.find((x) => `contacto:${x.id}` === chat)?.lid}@lid`
    : chat;
  return { t: "entrante", id: extra.id, chat: chatJid, de: persona(k), ts: Math.floor(ahora() / 1000), desdeElTelefono: !!extra.desdeElTelefono, contenido };
}

function despachar(instancia, m, entrante) {
  if (!aLinea(instancia, entrante)) m.pendiente = entrante; // llega al reconectar
}

// ── La API de la pantalla ────────────────────────────────────────────────
export function rutasQr() {
  const r = express.Router();

  // Los adjuntos que sube RunOp (ya cifrados por Baileys) y los que se bajan.
  r.post("/media", express.raw({ type: "*/*", limit: "120mb" }), (req, res) => {
    if (!claveValida(req.query.clave)) return res.status(401).end();
    const tipo = String(req.query.tipo || "");
    const limite = tipo === "document" ? LIMITE_DOCUMENTO : LIMITE_MEDIA;
    if (req.body.length > limite) return res.status(413).send(`el adjunto pasa de ${limite / 1024 / 1024} MB`);
    const token = randomBytes(16).toString("hex");
    writeFileSync(join(MEDIOS, `cifrado-${token}`), req.body);
    const base = process.env.WA_SANDBOX_URL_PUBLICA || `${req.protocol}://${req.get("host")}`;
    res.json({ url: `${base}/qr/media/${token}` });
  });
  r.get("/media/:token", (req, res) => {
    const f = join(MEDIOS, `cifrado-${req.params.token.replace(/[^a-f0-9]/g, "")}`);
    if (!existsSync(f)) return res.status(404).end();
    res.sendFile(f);
  });

  // Desde aquí, todo pide la clave.
  r.use("/api", (req, res, next) => {
    if (!claveValida(req.query.clave || req.get("x-clave"))) return res.status(401).json({ error: "Clave no válida." });
    next();
  });

  r.get("/api/eventos", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(":hola\n\n");
    pantallas.add(res);
    const latido = setInterval(() => { try { res.write(":latido\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(latido); pantallas.delete(res); });
  });

  r.get("/api/estado", (_req, res) => {
    // La pantalla abierta compara esto con el suyo y se recarga si el sandbox cambió.
    let version = "";
    try { version = String(Math.floor(statSync(resolve(process.cwd(), "public/qr.html")).mtimeMs)); } catch {}
    res.setHeader("x-version-pantalla", version);
    const instancias = new Set([...Object.keys(mundo.lineas), ...conexiones.keys()]);
    res.json({
      lineas: [...instancias].map((i) => ({
        instancia: i, estado: estadoLinea(i), ...(mundo.lineas[i] || {}),
        qr: conexiones.get(i)?.fase === "qr" ? conexiones.get(i).qr : null,
      })),
      contactos: mundo.contactos,
      grupos: mundo.grupos,
      mensajes: mundo.mensajes.slice(-1500).map(({ pendiente, ...m }) => ({ ...m, enEspera: !!pendiente })),
    });
  });

  r.get("/api/medio/:token", (req, res) => {
    const f = join(MEDIOS, `claro-${req.params.token.replace(/[^a-f0-9]/g, "")}`);
    if (!existsSync(f)) return res.status(404).end();
    if (req.query.tipo) res.type(String(req.query.tipo));
    // Que se abra en el navegador (un PDF, una foto) con su nombre de verdad; «descargar» lo baja.
    const nombre = String(req.query.nombre || "archivo").replace(/["\\\r\n]/g, "");
    res.setHeader("content-disposition", `${req.query.descargar ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(nombre)}`);
    res.sendFile(f);
  });

  r.post("/api/vincular", (req, res) => {
    const { instancia, nombre } = req.body || {};
    const c = conexiones.get(instancia);
    if (!c || c.fase !== "qr" || !c.qr) return res.status(409).json({ error: "Esa línea no está mostrando un QR ahora. Dale a «Conectar» en el panel de RunOp." });
    clearTimeout(c.temporizador);
    const l = { numero: nuevoNumero(), lid: nuevoLid(), nombre: (nombre || "").trim() || "Negocio de prueba", vinculada: ahora() };
    mundo.lineas[instancia] = l;
    guardar();
    c.fase = "vinculando";
    enviar(c.ws, { t: "vinculada", me: { id: `${l.numero}:7@s.whatsapp.net`, lid: `${l.lid}:7@lid`, name: l.nombre } });
    avisar({ tipo: "lineas" });
    res.json({ ok: true, linea: l });
  });

  r.post("/api/conexion", (req, res) => {
    const { instancia, accion } = req.body || {};
    const c = conexiones.get(instancia);
    if (accion === "cerrar_sesion") {
      // Desde el teléfono: «Dispositivos vinculados → Cerrar sesión».
      delete mundo.lineas[instancia];
      guardar();
      if (c) enviar(c.ws, { t: "cerrar", codigo: 401, motivo: "Connection Failure (logged out)" });
    } else if (accion === "caida") {
      if (c) enviar(c.ws, { t: "cerrar", codigo: 428, motivo: "Connection Closed" });
    } else if (accion === "reemplazada") {
      if (c) enviar(c.ws, { t: "cerrar", codigo: 440, motivo: "Stream Errored (conflict)" });
    } else return res.status(400).json({ error: "acción desconocida" });
    avisar({ tipo: "lineas" });
    res.json({ ok: true });
  });

  r.post("/api/contactos", (req, res) => {
    const nombre = String(req.body?.nombre || "").trim();
    if (!nombre) return res.status(400).json({ error: "Falta el nombre." });
    /* El número es opcional: sin él se inventa uno (1809555…), que nunca
       coincide con nadie. Con él se puede escribir como alguien concreto —el
       dueño, para ver cómo lo trata RunOp—. No hay riesgo: lo que entra por esta
       línea no sale nunca del sandbox. */
    const numero = String(req.body?.numero || "").replace(/\D/g, "");
    if (numero && (numero.length < 8 || numero.length > 15)) return res.status(400).json({ error: "El número va con código de país, solo cifras: 18095551234." });
    if (numero && mundo.contactos.some((c) => c.pn === numero)) return res.status(400).json({ error: "Ya hay un contacto con ese número." });
    if (numero && Object.values(mundo.lineas).some((l) => l.numero === numero)) return res.status(400).json({ error: "Ese número es el de la línea." });
    const k = { id: randomBytes(4).toString("hex"), nombre, pn: numero || nuevoNumero(), lid: nuevoLid() };
    mundo.contactos.push(k);
    guardar();
    for (const [i] of conexiones) aLinea(i, { t: "lids", lids: lidsDelMundo() });
    avisar({ tipo: "mundo" });
    res.json(k);
  });

  r.patch("/api/contactos/:id", (req, res) => {
    const k = mundo.contactos.find((x) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: "No existe." });
    if (typeof req.body?.sinSenal === "boolean") k.sinSenal = req.body.sinSenal;
    if (typeof req.body?.sinWhatsApp === "boolean") k.sinWhatsApp = req.body.sinWhatsApp;
    guardar();
    // Recuperó la señal: le llega lo que estaba esperando.
    if (k.sinSenal === false) for (const m of mundo.mensajes.filter((x) => x.chat === `contacto:${k.id}` && x.estado === "enviado")) entregar(m.instancia, m);
    avisar({ tipo: "mundo" });
    res.json(k);
  });

  r.delete("/api/contactos/:id", (req, res) => {
    mundo.contactos = mundo.contactos.filter((x) => x.id !== req.params.id);
    for (const g of mundo.grupos) g.miembros = g.miembros.filter((x) => x !== req.params.id);
    guardar();
    avisar({ tipo: "mundo" });
    res.json({ ok: true });
  });

  r.post("/api/grupos", (req, res) => {
    const { nombre, miembros = [], instancia } = req.body || {};
    if (!String(nombre || "").trim()) return res.status(400).json({ error: "Falta el nombre del grupo." });
    if (!mundo.lineas[instancia]) return res.status(400).json({ error: "Primero vincula la línea." });
    const g = { id: `120363${digitos(12)}@g.us`, nombre: String(nombre).trim(), miembros, lineas: [instancia], creado: ahora() };
    mundo.grupos.push(g);
    guardar();
    avisar({ tipo: "mundo" });
    res.json(g);
  });

  r.patch("/api/grupos/:id", (req, res) => {
    const g = grupo(req.params.id);
    if (!g) return res.status(404).json({ error: "No existe." });
    if (Array.isArray(req.body?.miembros)) g.miembros = req.body.miembros;
    if (req.body?.nombre) g.nombre = String(req.body.nombre);
    guardar();
    avisar({ tipo: "mundo" });
    res.json(g);
  });

  r.delete("/api/grupos/:id", (req, res) => {
    mundo.grupos = mundo.grupos.filter((g) => g.id !== req.params.id);
    guardar();
    avisar({ tipo: "mundo" });
    res.json({ ok: true });
  });

  /** Escribir como un contacto (o como el dueño desde el teléfono de la línea). */
  r.post("/api/escribir", (req, res) => {
    const { instancia, chat, de, texto = "", citado, media, desdeElTelefono } = req.body || {};
    if (!mundo.lineas[instancia]) return res.status(400).json({ error: "La línea no está vinculada." });
    let autor = de;
    if (chat.startsWith("contacto:")) autor = chat.slice(9);
    else {
      const g = grupo(chat);
      if (!g) return res.status(404).json({ error: "No existe ese grupo." });
      if (!desdeElTelefono && !g.miembros.includes(autor)) return res.status(400).json({ error: "Esa persona no está en el grupo." });
      if (desdeElTelefono) autor = g.miembros[0];
    }
    if (!mundo.contactos.find((x) => x.id === autor)) return res.status(400).json({ error: "Elige quién escribe." });

    const id = idTelefono();
    const m = { id, instancia, chat, de: desdeElTelefono ? "telefono" : autor, ts: ahora(), citado: citado || null, menciones: [], vista: {} };
    let contenido;
    /* Una nota de voz grabada en el navegador llega en webm: WhatsApp las manda
       en OGG/Opus, así que se convierte para que RunOp reciba lo mismo que de
       un teléfono. */
    if (media?.base64 && media.tipo === "audio" && media.nota && !/ogg/.test(media.mimetype || "")) {
      try {
        const ogg = execFileSync("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", "48000", "-f", "ogg", "pipe:1"],
          { input: Buffer.from(media.base64, "base64"), maxBuffer: 30 * 1024 * 1024, timeout: 30_000 });
        media.base64 = ogg.toString("base64");
        media.mimetype = "audio/ogg; codecs=opus";
        media.fileName = "nota-de-voz.ogg";
      } catch (err) {
        return res.status(500).json({ error: "No pude convertir la nota de voz (¿está ffmpeg instalado?)." });
      }
    }
    if (media?.base64) {
      const tamano = Buffer.byteLength(media.base64, "base64");
      const limite = media.tipo === "documento" ? LIMITE_DOCUMENTO : LIMITE_MEDIA;
      if (tamano > limite) return res.status(413).json({ error: `WhatsApp no deja mandar adjuntos de más de ${limite / 1024 / 1024} MB.` });
      contenido = { tipo: media.tipo, base64: media.base64, mimetype: media.mimetype, fileName: media.fileName, caption: texto || undefined, citado: citado || undefined };
      m.vista = { tipo: media.tipo, caption: texto || undefined, fileName: media.fileName, mimetype: media.mimetype, medio: guardarClaro(Buffer.from(media.base64, "base64")) };
    } else {
      if (!String(texto).trim()) return res.status(400).json({ error: "Escribe algo." });
      const men = menciones(texto, instancia, chat);
      contenido = { tipo: "texto", texto: men.texto, menciones: men.jids, citado: citado || undefined };
      m.vista = { tipo: "texto", texto };
      m.menciones = men.jids.map(nombreDeJid);
    }
    mundo.mensajes.push(m);
    despachar(instancia, m, entranteDe(instancia, chat, autor, contenido, { id, desdeElTelefono }));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat });
    res.json(m);
  });

  r.post("/api/reaccionar", (req, res) => {
    const { instancia, mensaje, de, emoji } = req.body || {};
    const objetivo = mundo.mensajes.find((x) => x.id === mensaje && x.instancia === instancia);
    if (!objetivo) return res.status(404).json({ error: "No encuentro ese mensaje." });
    const autor = objetivo.chat.startsWith("contacto:") ? objetivo.chat.slice(9) : de;
    if (!mundo.contactos.find((x) => x.id === autor)) return res.status(400).json({ error: "Elige quién reacciona." });
    objetivo.reacciones = { ...(objetivo.reacciones || {}), [autor]: emoji || "" };
    const m = { id: idTelefono(), instancia, chat: objetivo.chat, de: autor, ts: ahora(), oculto: true, vista: { tipo: "reaccion" } };
    mundo.mensajes.push(m);
    despachar(instancia, m, entranteDe(instancia, objetivo.chat, autor, { tipo: "reaccion", objetivo: mensaje, emoji: emoji || "" }, { id: m.id }));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat: objetivo.chat });
    res.json({ ok: true });
  });

  /**
   * Votar en una encuesta, como cualquier contacto. WhatsApp manda la
   * selección ENTERA cada vez (cambiar el voto = la nueva lista; quitarlo =
   * lista vacía). Aquí solo se decide quién votó qué; el voto cifrado con el
   * secreto de la encuesta lo arma socket-sandbox.ts con Baileys, igual que
   * llegaría de un teléfono.
   */
  r.post("/api/votar", (req, res) => {
    const { instancia, mensaje, de, opciones } = req.body || {};
    const o = mundo.mensajes.find((x) => x.id === mensaje && x.instancia === instancia);
    if (!o || o.vista?.tipo !== "encuesta") return res.status(404).json({ error: "No encuentro esa encuesta." });
    const autor = o.chat.startsWith("contacto:") ? o.chat.slice(9) : de;
    const g = o.chat.endsWith("@g.us") ? grupo(o.chat) : null;
    if (!mundo.contactos.find((x) => x.id === autor)) return res.status(400).json({ error: "Elige quién vota." });
    if (g && !g.miembros.includes(autor)) return res.status(400).json({ error: "Esa persona no está en el grupo." });
    const validas = (Array.isArray(opciones) ? opciones : []).map(String).filter((x) => (o.vista.opciones || []).includes(x));
    const unicas = [...new Set(validas)];
    if (!o.vista.varias && unicas.length > 1) return res.status(400).json({ error: "En esta encuesta solo se puede elegir una opción." });
    o.votos = { ...(o.votos || {}), [autor]: unicas };
    if (!unicas.length) delete o.votos[autor];
    const m = { id: idTelefono(), instancia, chat: o.chat, de: autor, ts: ahora(), oculto: true, vista: { tipo: "voto" } };
    mundo.mensajes.push(m);
    despachar(instancia, m, entranteDe(instancia, o.chat, autor, { tipo: "voto", objetivo: mensaje, opciones: unicas }, { id: m.id }));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat: o.chat });
    res.json({ ok: true, votos: o.votos });
  });

  r.post("/api/editar", (req, res) => {
    const { instancia, mensaje, texto } = req.body || {};
    const o = mundo.mensajes.find((x) => x.id === mensaje && x.instancia === instancia);
    if (!o || o.de === "linea") return res.status(404).json({ error: "Solo se editan mensajes de un contacto." });
    if (o.vista.tipo !== "texto") return res.status(400).json({ error: "WhatsApp solo deja editar textos (y pies de foto)." });
    if (ahora() - o.ts > EDITAR_MS) return res.status(400).json({ error: "Pasaron más de 15 minutos: WhatsApp ya no deja editarlo." });
    if (!String(texto || "").trim()) return res.status(400).json({ error: "Escribe el texto nuevo." });
    o.vista.texto = texto;
    o.editado = true;
    const autor = o.chat.startsWith("contacto:") ? o.chat.slice(9) : o.de;
    const m = { id: idTelefono(), instancia, chat: o.chat, de: autor, ts: ahora(), oculto: true, vista: { tipo: "edicion" } };
    mundo.mensajes.push(m);
    despachar(instancia, m, entranteDe(instancia, o.chat, autor === "telefono" ? mundo.contactos[0]?.id : autor, { tipo: "editar", objetivo: mensaje, texto }, { id: m.id, desdeElTelefono: o.de === "telefono" }));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat: o.chat });
    res.json({ ok: true });
  });

  r.post("/api/borrar", (req, res) => {
    const { instancia, mensaje } = req.body || {};
    const o = mundo.mensajes.find((x) => x.id === mensaje && x.instancia === instancia);
    if (!o || o.de === "linea") return res.status(404).json({ error: "Solo se borran mensajes de un contacto." });
    if (ahora() - o.ts > BORRAR_MS) return res.status(400).json({ error: "Pasaron más de 2 días: WhatsApp ya no deja borrarlo para todos." });
    o.borrado = true;
    const autor = o.chat.startsWith("contacto:") ? o.chat.slice(9) : o.de;
    const m = { id: idTelefono(), instancia, chat: o.chat, de: autor, ts: ahora(), oculto: true, vista: { tipo: "borrado" } };
    mundo.mensajes.push(m);
    despachar(instancia, m, entranteDe(instancia, o.chat, autor === "telefono" ? mundo.contactos[0]?.id : autor, { tipo: "borrar", objetivo: mensaje }, { id: m.id, desdeElTelefono: o.de === "telefono" }));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat: o.chat });
    res.json({ ok: true });
  });

  r.post("/api/escribiendo", (req, res) => {
    const { instancia, chat, de, estado } = req.body || {};
    const autor = chat.startsWith("contacto:") ? chat.slice(9) : de;
    const k = mundo.contactos.find((x) => x.id === autor);
    if (!k) return res.json({ ok: false });
    const chatJid = chat.startsWith("contacto:") ? `${k.lid}@lid` : chat;
    aLinea(instancia, { t: "presencia", chat: chatJid, participante: `${k.lid}@lid`, estado: estado || "composing" });
    res.json({ ok: true });
  });

  /** Alguien abrió el chat: lo de la línea queda leído. */
  r.post("/api/leer", (req, res) => {
    const { instancia, chat, de } = req.body || {};
    const ids = mundo.mensajes.filter((x) => x.instancia === instancia && x.chat === chat && x.de === "linea" && x.estado !== "leido").map((x) => x.id);
    if (!ids.length) return res.json({ ok: true });
    if (chat.startsWith("contacto:")) {
      const k = mundo.contactos.find((x) => `contacto:${x.id}` === chat);
      if (!k || k.sinSenal) return res.json({ ok: true });
      for (const m of mundo.mensajes) if (ids.includes(m.id)) m.estado = "leido";
      aLinea(instancia, { t: "acuse", chat: `${k.lid}@lid`, ids, estado: "leido" });
    } else {
      const k = mundo.contactos.find((x) => x.id === de);
      if (!k) return res.json({ ok: true });
      for (const m of mundo.mensajes) if (ids.includes(m.id)) m.leidoPor = [...new Set([...(m.leidoPor || []), k.id])];
      aLinea(instancia, { t: "acuse", chat, ids, estado: "leido", participante: `${k.lid}@lid` });
    }
    guardar();
    avisar({ tipo: "mensajes", instancia, chat });
    res.json({ ok: true });
  });

  r.post("/api/limpiar", (req, res) => {
    const { instancia, chat } = req.body || {};
    mundo.mensajes = mundo.mensajes.filter((x) => !(x.instancia === instancia && x.chat === chat));
    guardar();
    avisar({ tipo: "mensajes", instancia, chat });
    res.json({ ok: true });
  });

  return r;
}

export function socketQr(servidor) {
  const wss = new WebSocketServer({ server: servidor, path: "/qr/ws" });
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url, "http://x");
    if (!claveValida(u.searchParams.get("clave"))) { ws.close(4001, "clave"); return; }
    const instancia = u.searchParams.get("instancia");
    if (!instancia) { ws.close(4000, "instancia"); return; }
    alConectar(ws, instancia);
  });
  console.log(`  · WhatsApp por QR: http://localhost:${process.env.PORT || 8095}/qr.html?clave=${claveQr()}`);
}
