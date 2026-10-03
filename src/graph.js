/**
 * El clon del Graph API de Meta. Aquí es donde la plataforma cree que habla con
 * WhatsApp.
 *
 * La regla de esta carpeta: si Meta devuelve algo, aquí se devuelve IGUAL —
 * mismos nombres de campo, mismos códigos, mismo orden de errores. Cualquier
 * atajo («total, la plataforma solo lee el id») convierte el sandbox en una
 * variante del mundo real, y entonces lo que se ensaya no vale.
 */
import express, { Router } from "express";
import { createReadStream, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import multer from "multer";
import { db } from "./db.js";
import { porQueNoEsTelefono } from "./telefonos.js";
import {
  nuevoWamid, nuevoId, ahora, sha256, errorMeta, ERRORES,
} from "./meta.js";
import { entregar, programarAcuses } from "./webhooks.js";
import { avisar } from "./eventos.js";

const MEDIOS = process.env.SANDBOX_MEDIOS || resolve(process.cwd(), "datos/medios");
mkdirSync(MEDIOS, { recursive: true });
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

export const graph = Router();

/**
 * Quién está «escribiendo…» ahora mismo.
 *
 * Vive en memoria y no en la base a propósito: es un estado de segundos que no
 * tiene ningún sentido sobrevivir a un reinicio, y guardarlo obligaría a
 * limpiarlo. Meta lo apaga solo a los ~25 s o cuando llega el mensaje.
 */
const escribiendo = new Map();   // numero_id -> { waId, hasta }

export function marcarEscribiendo(numeroId, waId, ind) {
  const segundos = ind?.type === "text" ? 25 : 25;
  escribiendo.set(numeroId, { waId: waId ?? null, hasta: Date.now() + segundos * 1000 });
}

export function estaEscribiendo(numeroId) {
  const e = escribiendo.get(numeroId);
  if (!e || e.hasta < Date.now()) return null;
  return e;
}

/** Cuando el negocio manda el mensaje, deja de estar escribiendo. */
const dejarDeEscribir = (numeroId) => escribiendo.delete(numeroId);

const responderError = (res, e) => res.status(e.status).json(e.cuerpo);

/**
 * El token. Meta responde 401 con su forma de error, no un 401 pelado: la
 * plataforma distingue «token vencido» de «número que no existe» por el código,
 * y si aquí sale otra cosa nunca ensayaríamos ese camino.
 */
function autenticar(req, res, next) {
  const cabecera = req.get("authorization") || "";
  /* La subida reanudable de Meta pide «Authorization: OAuth <token>», no
     «Bearer»: las dos formas valen, como allá. */
  const token = cabecera.replace(/^(Bearer|OAuth)\s+/i, "").trim() ||
    String(req.query.access_token || "");
  if (!token) {
    return responderError(res, errorMeta(190, "An access token is required to request this resource.", { status: 401 }));
  }
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE token = ?`).get(token);
  if (!cuenta) {
    return responderError(res, errorMeta(190, "Invalid OAuth access token - Cannot parse access token.", { status: 401 }));
  }
  req.cuenta = cuenta;
  next();
}

const numeroDe = (id, cuenta) =>
  db.prepare(`SELECT * FROM numeros WHERE id = ? AND cuenta_id = ?`).get(id, cuenta.id);

/* ─────────────── La app, y la subida reanudable de muestras ─────────────── */

/**
 * El id de la app de Meta de esta cuenta. Nace la primera vez que se pide: las
 * cuentas creadas antes de existir esto no lo tenían.
 */
export function appIdDe(cuenta) {
  if (cuenta.app_id) return cuenta.app_id;
  const id = nuevoId(15);
  db.prepare(`UPDATE cuentas SET app_id = ? WHERE id = ? AND app_id IS NULL`).run(id, cuenta.id);
  return db.prepare(`SELECT app_id FROM cuentas WHERE id = ?`).get(cuenta.id).app_id;
}

/**
 * `GET /debug_token?input_token=…` — de qué app es un token.
 *
 * Meta lo documenta con un token de app o de un desarrollador de esa app como
 * `access_token`. Aquí basta con un token válido del mismo dueño: lo que se
 * ensaya es leer `data.app_id`, no el sistema de permisos de Meta.
 */
graph.get("/debug_token", autenticar, (req, res) => {
  const entrada = String(req.query.input_token || "");
  const cuenta = db.prepare(`SELECT * FROM cuentas WHERE token = ? AND dueno = ?`).get(entrada, req.cuenta.dueno);
  if (!cuenta) {
    return res.json({ data: { is_valid: false, error: { code: 190, message: "Invalid OAuth access token." } } });
  }
  res.json({
    data: {
      app_id: appIdDe(cuenta),
      type: "SYSTEM_USER",
      application: "wa-sandbox",
      is_valid: true,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
    },
  });
});

/**
 * Lo que la subida reanudable acepta, según la guía de Meta
 * (developers.facebook.com/docs/graph-api/guides/upload): pdf, jpeg, jpg, png
 * y mp4. Nada más.
 */
const TIPOS_SUBIDA = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png", "video/mp4"]);

/** `POST /{app-id}/uploads?file_name&file_length&file_type` → `{id: "upload:…"}`. */
graph.post("/:appId/uploads", autenticar, (req, res) => {
  if (req.params.appId !== appIdDe(req.cuenta)) {
    return responderError(res, errorMeta(100,
      `Unsupported post request. Object with ID '${req.params.appId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      { subcode: 33, status: 400 }));
  }
  const q = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const largo = Number(q.file_length);
  const tipo = String(q.file_type || "").toLowerCase();
  if (!Number.isInteger(largo) || largo <= 0) {
    return responderError(res, errorMeta(100, "(#100) The parameter file_length is required"));
  }
  if (!TIPOS_SUBIDA.has(tipo)) {
    return responderError(res, errorMeta(100, `(#100) Param file_type must be one of {application/pdf, image/jpeg, image/jpg, image/png, video/mp4}`));
  }
  const id = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO subidas (id, dueno, cuenta_id, app_id, nombre, largo, tipo, recibido, ruta, creada)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, req.cuenta.dueno, req.cuenta.id, req.params.appId, String(q.file_name || "") || null,
        largo, tipo, resolve(MEDIOS, `subida_${id}`), Date.now());
  res.json({ id: `upload:${id}` });
});

const subidaDe = (param, cuenta) => {
  const id = String(param).replace(/^upload:/, "");
  return db.prepare(`SELECT * FROM subidas WHERE id = ? AND dueno = ?`).get(id, cuenta.dueno);
};

/** `GET /upload:{sesión}` → cuánto ha llegado, para reanudar. */
graph.get(/^\/(upload:[^/]+)$/, autenticar, (req, res) => {
  const s = subidaDe(req.params[0], req.cuenta);
  if (!s) return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  res.json({ id: `upload:${s.id}`, file_offset: s.recibido });
});

/**
 * `POST /upload:{sesión}` con `file_offset` y el binario → `{h: "…"}`.
 *
 * El cuerpo es el archivo crudo, no JSON ni multipart: así lo manda la guía
 * (`--data-binary @archivo`).
 */
graph.post(/^\/(upload:[^/]+)$/, express.raw({ type: () => true, limit: "110mb" }), autenticar, (req, res) => {
  const s = subidaDe(req.params[0], req.cuenta);
  if (!s) return responderError(res, errorMeta(100, "Unsupported post request. Object with ID does not exist", { subcode: 33, status: 404 }));
  const desde = Number(req.get("file_offset"));
  if (!Number.isInteger(desde)) return responderError(res, errorMeta(100, "(#100) The header file_offset is required"));
  if (desde !== s.recibido) {
    return responderError(res, errorMeta(100, `(#100) file_offset ${desde} does not match the uploaded offset ${s.recibido}`));
  }
  const trozo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (desde + trozo.length > s.largo) {
    return responderError(res, errorMeta(100, "(#100) Uploaded data exceeds the declared file_length"));
  }
  if (trozo.length) appendFileSync(s.ruta, trozo);
  const recibido = desde + trozo.length;
  if (recibido < s.largo) {
    db.prepare(`UPDATE subidas SET recibido = ? WHERE id = ?`).run(recibido, s.id);
    return res.json({ id: `upload:${s.id}`, file_offset: recibido });
  }
  const handle = "4::" + randomBytes(48).toString("base64");
  db.prepare(`UPDATE subidas SET recibido = ?, handle = ?, token_publico = ? WHERE id = ?`)
    .run(recibido, handle, randomBytes(24).toString("base64url"), s.id);
  res.json({ h: handle });
});

/* ─────────────────────── Mensajes ─────────────────────── */

graph.post("/:phoneNumberId/messages", autenticar, async (req, res) => {
  const numero = numeroDe(req.params.phoneNumberId, req.cuenta);
  if (!numero) {
    return responderError(res, errorMeta(100, "Unsupported post request. Object with ID does not exist", { subcode: 33, status: 404 }));
  }

  const b = req.body || {};
  if (b.messaging_product !== "whatsapp") {
    return responderError(res, errorMeta(100, "Param messaging_product must be 'whatsapp'"));
  }

  /**
   * El mismo endpoint hace tres cosas distintas, y hay que mirarlo antes que
   * nada porque estas dos NO llevan `to`:
   *
   *   · `{status:"read", message_id}`      → el ✓✓ azul en el teléfono del cliente
   *   · `{..., typing_indicator}`          → «escribiendo…»
   *   · `{to, type, ...}`                  → un mensaje de verdad
   *
   * Tratar un «marcar leído» como si fuera un envío devolvía «falta el param
   * to» y el agente lo daba por fallido: el cliente nunca veía el visto azul.
   */
  if (b.status === "read" && b.message_id) {
    /* Solo mensajes de esta cuenta: un wamid ajeno no es «no encontrado a
       medias», es el token de un negocio tocando la conversación de otro. */
    const m = db.prepare(
      `SELECT m.* FROM mensajes m JOIN numeros n ON n.id = m.numero_id
        WHERE m.id = ? AND n.cuenta_id = ?`,
    ).get(String(b.message_id), req.cuenta.id);
    if (m) {
      db.prepare(`UPDATE mensajes SET estado = 'read' WHERE id = ?`).run(m.id);
      avisar({ tipo: "estado", numeroId: numero.id, waId: m.wa_id }, req.cuenta.dueno);
    }
    // Meta responde así, sin más. El acuse NO se le manda de vuelta al negocio:
    // es él quien acaba de leer, no el cliente.
    if (b.typing_indicator) {
      marcarEscribiendo(numero.id, m?.wa_id, b.typing_indicator);
      avisar({ tipo: "escribiendo", numeroId: numero.id, waId: m?.wa_id ?? null, hasta: Date.now() + 25000 }, req.cuenta.dueno);
    }
    return res.json({ success: true });
  }
  if (b.typing_indicator && !b.to) {
    marcarEscribiendo(numero.id, null, b.typing_indicator);
    avisar({ tipo: "escribiendo", numeroId: numero.id, waId: null, hasta: Date.now() + 25000 }, req.cuenta.dueno);
    return res.json({ success: true });
  }

  /**
   * A quién va: por teléfono o por @usuario.
   *
   * Desde 2026 una persona puede escribirle a un negocio con su @usuario y
   * ocultar el número. Entonces no hay teléfono al que responder y Meta pide
   * que el envío lleve `recipient` con su BSUID —«DO.1098454149505849»— y
   * NINGÚN `to`. Aquí faltaba, así que este clon contestaba «Param to is
   * required» a un envío que Meta acepta: mentía en la dirección peligrosa,
   * haciendo fallar un ensayo que en producción habría funcionado.
   */
  const porUsuario = !b.to && !!b.recipient;
  const to = porUsuario ? String(b.recipient).trim() : String(b.to || "").replace(/\D/g, "");
  if (!to) return responderError(res, errorMeta(100, "Param to is required"));
  /* Sin código de país no hay a quién entregar, y Meta lo rechaza. Aceptarlo
     aquí hacía que un ensayo pasara y el envío de verdad fallara: justo lo que
     este clon existe para evitar. A un BSUID no se le mira eso: no es un
     teléfono y no tiene por qué parecerlo. */
  const mal = porUsuario ? null : porQueNoEsTelefono(to);
  if (mal) {
    const e = ERRORES[131009];
    return responderError(res, errorMeta(131009, e.message, { details: `${e.details} (${mal})`, status: 400 }));
  }

  /* Un texto no puede pasar de 4096 caracteres. Un agente que se emociona
     escribiendo lo cruza sin darse cuenta, y contra Meta el envío falla: eso
     tiene que doler aquí, no con un cliente delante. */
  if (b.type === "text" && String(b.text?.body || "").length > 4096) {
    const e = ERRORES[131009];
    return responderError(res, errorMeta(131009, e.message, {
      details: `Text body is ${String(b.text.body).length} characters; the maximum is 4096.`, status: 400 }));
  }

  /* Un medio se manda por su id, y ese id tiene que existir: si no, Meta
     responde que el objeto no existe. Sin esto, un id inventado «funcionaba»
     aquí y reventaba en producción. */
  if (["image", "video", "audio", "document", "sticker"].includes(b.type)) {
    const idMedio = String(b[b.type]?.id || "");
    if (idMedio && !db.prepare(`SELECT 1 FROM medios WHERE id = ? AND dueno = ?`).get(idMedio, req.cuenta.dueno)) {
      return responderError(res, errorMeta(100, "Unsupported post request. Object with ID does not exist",
        { subcode: 33, status: 404 }));
    }
    if (!idMedio && !b[b.type]?.link) {
      return responderError(res, errorMeta(100, `Param ${b.type} requires id or link`));
    }
  }

  /**
   * La ventana de 24 horas, sola.
   *
   * Fuera de ella Meta SOLO entrega plantillas aprobadas; cualquier otra cosa
   * se rechaza con 131047. Antes esto había que provocarlo a mano, así que en
   * la práctica no se ensayaba nunca — y es el fallo más común en producción:
   * el negocio contesta al día siguiente y el mensaje no llega, sin que nadie
   * entienda por qué.
   *
   * La ventana la abre CADA mensaje del cliente, como en WhatsApp.
   */
  if (b.type !== "template") {
    const ultimo = db.prepare(
      `SELECT cuando FROM mensajes WHERE numero_id = ? AND wa_id = ? AND direccion = 'entrante'
        ORDER BY cuando DESC LIMIT 1`,
    ).get(numero.id, to);
    const fuera = !ultimo || Date.now() - ultimo.cuando > 24 * 3600 * 1000;
    if (fuera) {
      const e = ERRORES[131047];
      return responderError(res, errorMeta(131047, e.message, { details: e.details, status: 400 }));
    }
  }

  /* Una regla puede ordenar que ESTE envío se rechace de una, como hace Meta
     cuando el número no es de WhatsApp o la ventana de 24h ya venció. */
  const regla = tomarRegla(req.cuenta.dueno, numero.id, to, ["error_envio", "ventana_24h"]);
  if (regla) {
    const cod = regla.clase === "ventana_24h" ? 131047 : (regla.codigo || 131026);
    const e = ERRORES[cod] || ERRORES[131026];
    return responderError(res, errorMeta(cod, e.message, { details: e.details, status: 400 }));
  }

  /**
   * Una plantilla tiene que EXISTIR y estar aprobada.
   *
   * Antes se aceptaba cualquiera: mandar una plantilla inventada «funcionaba»
   * aquí y reventaba contra Meta. Los códigos 132001 y 132000 estaban escritos
   * pero no conectados a nada.
   */
  if (b.type === "template") {
    const nombre = String(b.template?.name || "");
    const idioma = String(b.template?.language?.code || "");
    const pl = db.prepare(
      `SELECT * FROM plantillas WHERE cuenta_id = ? AND nombre = ?
        ORDER BY (idioma = ?) DESC LIMIT 1`,
    ).get(req.cuenta.id, nombre, idioma);
    if (!pl || pl.estado !== "APPROVED") {
      const e = ERRORES[132001];
      return responderError(res, errorMeta(132001, e.message, { details: e.details, status: 400 }));
    }
    // Los huecos {{1}}, {{2}}… del cuerpo tienen que cuadrar con los parámetros.
    const cuerpoPl = (JSON.parse(pl.componentes || "[]"))
      .find((c) => String(c.type).toUpperCase() === "BODY");
    const huecos = new Set(String(cuerpoPl?.text || "").match(/\{\{\s*\d+\s*\}\}/g) || []);
    const dados = (b.template?.components || [])
      .filter((c) => String(c.type).toUpperCase() === "BODY")
      .flatMap((c) => c.parameters || []).length;
    if (huecos.size !== dados) {
      const e = ERRORES[132000];
      return responderError(res, errorMeta(132000, e.message, {
        details: `${e.details} (esperaba ${huecos.size}, llegaron ${dados})`, status: 400 }));
    }
    /* Un encabezado de imagen, video o documento NO viaja solo: la muestra
       de la plantilla es para la revisión, y al enviar hay que mandar el
       archivo. Sin él Meta contesta 132012 «header: Format mismatch, expected
       IMAGE, received UNKNOWN» (visto en producción; ver meta-runtime.ts). */
    const cabPl = (JSON.parse(pl.componentes || "[]")).find((c) => String(c.type).toUpperCase() === "HEADER");
    const fmtPl = String(cabPl?.format || "TEXT").toUpperCase();
    if (FORMATO_MEDIO[fmtPl]) {
      const par = (b.template?.components || [])
        .find((c) => String(c.type).toUpperCase() === "HEADER")?.parameters?.[0];
      const recibido = String(par?.type || "UNKNOWN").toUpperCase();
      if (recibido !== fmtPl) {
        const e = ERRORES[132012];
        return responderError(res, errorMeta(132012, e.message, {
          details: `header: Format mismatch, expected ${fmtPl}, received ${recibido}`, status: 400 }));
      }
      const medio = par[par.type] || {};
      if (medio.id && !db.prepare(`SELECT 1 FROM medios WHERE id = ? AND dueno = ?`).get(String(medio.id), req.cuenta.dueno)) {
        return responderError(res, errorMeta(100, "Unsupported post request. Object with ID does not exist",
          { subcode: 33, status: 404 }));
      }
      if (!medio.id && !medio.link) {
        return responderError(res, errorMeta(100, `Param template['components'][0]['parameters'][0]['${par.type}'] requires id or link`));
      }
    }
  }

  dejarDeEscribir(numero.id);

  /**
   * Si el negocio le escribe a un número que aquí no existe, el contacto se
   * crea solo.
   *
   * En WhatsApp no hay que «dar de alta» a nadie: el negocio manda una
   * plantilla a quien quiera y la conversación aparece. Aquí, sin contacto, el
   * mensaje se guardaba pero NO salía en ninguna parte —la lista de chats se
   * arma con los contactos—, así que parecía que no había llegado.
   */
  if (!db.prepare(`SELECT 1 FROM contactos WHERE wa_id = ? AND numero_id = ?`).get(to, numero.id)) {
    db.prepare(
      `INSERT INTO contactos (wa_id, numero_id, dueno, nombre, creado) VALUES (?, ?, ?, ?, ?)`,
    ).run(to, numero.id, req.cuenta.dueno, to, Date.now());
    avisar({ tipo: "contacto", numeroId: numero.id, waId: to }, req.cuenta.dueno);
  }

  const wamid = nuevoWamid();
  const texto = textoPlano(b, req.cuenta.id);
  /* Una plantilla se pinta por partes —encabezado, cuerpo, pie, botones—, así
     que se guardan ya resueltas junto al envío: la pantalla no tiene que
     volver a buscar la plantilla ni rellenar huecos. */
  const guardar = b.type === "template"
    ? { ...b, _plantilla: textoDePlantilla(b, req.cuenta.id) }
    : b;
  db.prepare(
    `INSERT INTO mensajes (id, numero_id, dueno, wa_id, direccion, tipo, cuerpo, texto, estado, responde_a, cuando)
     VALUES (?, ?, ?, ?, 'saliente', ?, ?, ?, 'accepted', ?, ?)`,
  ).run(
    wamid, numero.id, req.cuenta.dueno, to, b.type || "text",
    JSON.stringify(guardar), texto, b.context?.message_id ?? null, Date.now(),
  );

  avisar({ tipo: "mensaje", numeroId: numero.id, waId: to }, req.cuenta.dueno);

  /* Meta responde ANTES de entregar nada: acepta el mensaje y lo que pase
     después llega por webhook. Un sandbox que respondiera con el resultado
     final ocultaría justo los fallos que ocurren tras el 200. */
  res.json({
    messaging_product: "whatsapp",
    contacts: [{ input: to, wa_id: to }],
    messages: [{ id: wamid, message_status: "accepted" }],
  });

  const sinEntrega = tomarRegla(req.cuenta.dueno, numero.id, to, ["sin_entrega"]);
  programarAcuses({
    cuenta: req.cuenta,
    numero,
    wamid,
    waId: to,
    fallo: sinEntrega
      ? { code: sinEntrega.codigo || 131051, ...(ERRORES[sinEntrega.codigo || 131051] || ERRORES[131051]) }
      : null,
  });
});

/** Una copia legible del contenido, solo para la interfaz. */
function textoPlano(b, cuentaId) {
  switch (b.type) {
    case "text": return b.text?.body ?? "";
    case "image": case "video": case "document": case "audio":
      return b[b.type]?.caption ?? b[b.type]?.filename ?? "";
    case "interactive": return b.interactive?.body?.text ?? "";
    case "template": return plantillaEnUnaLinea(textoDePlantilla(b, cuentaId));
    case "reaction": return b.reaction?.emoji ?? "";
    default: return "";
  }
}

/**
 * Una plantilla, escrita como la LEE el cliente en su teléfono.
 *
 * Antes se guardaba «[plantilla] test», que es el nombre interno: en el
 * teléfono nadie ve eso. Se arma el texto de verdad —encabezado, cuerpo con
 * sus huecos rellenos, pie— porque el sandbox existe para ver lo que va a ver
 * la persona, no para recordarnos cómo se llama la plantilla.
 */
function textoDePlantilla(b, cuentaId) {
  const nombre = String(b.template?.name || "");
  const idioma = String(b.template?.language?.code || "");
  const pl = db.prepare(
    `SELECT * FROM plantillas WHERE cuenta_id = ? AND nombre = ? ORDER BY (idioma = ?) DESC LIMIT 1`,
  ).get(cuentaId, nombre, idioma);
  if (!pl) return nombre ? `[plantilla ${nombre}]` : "";

  const partes = JSON.parse(pl.componentes || "[]");
  const dados = b.template?.components || [];
  const paramsDe = (tipo) => (dados.find((c) => String(c.type).toUpperCase() === tipo)?.parameters || [])
    .map((p) => p.text ?? p.image?.link ?? p.document?.filename ?? "");
  /* Los huecos {{1}}, {{2}}… se rellenan por orden, como hace Meta. */
  const rellenar = (texto, params) =>
    String(texto || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);

  const de = (tipo) => partes.find((c) => String(c.type).toUpperCase() === tipo);
  const cabecera = de("HEADER");
  const cuerpo = de("BODY");
  const pie = de("FOOTER");
  const botones = de("BUTTONS")?.buttons || [];

  /* El archivo del encabezado, si lo lleva: para que la interfaz lo pinte como
     lo vería el cliente, encima del texto. */
  const parCab = (dados.find((c) => String(c.type).toUpperCase() === "HEADER")?.parameters || [])[0];
  const medio = parCab && ["image", "video", "document"].includes(parCab.type) && parCab[parCab.type]?.id
    ? { tipo: parCab.type, id: String(parCab[parCab.type].id), filename: parCab[parCab.type].filename || null }
    : null;
  return {
    medio,
    cabecera: cabecera?.text ? rellenar(cabecera.text, paramsDe("HEADER")) : "",
    cuerpo: cuerpo?.text ? rellenar(cuerpo.text, paramsDe("BODY")) : "",
    pie: pie?.text || "",
    botones: botones.map((x) => x.text).filter(Boolean),
  };
}

/** La misma plantilla, en una línea: para la lista de chats. */
function plantillaEnUnaLinea(t) {
  return [t.cabecera, t.cuerpo, t.pie].filter(Boolean).join(" · ");
}

/** Saca una regla y la gasta. `veces = -1` significa siempre. */
function tomarRegla(dueno, numeroId, waId, clases) {
  const marcas = clases.map(() => "?").join(",");
  const r = db.prepare(
    `SELECT * FROM reglas
      WHERE dueno = ? AND numero_id = ? AND clase IN (${marcas})
        AND (wa_id IS NULL OR wa_id = ?)
      ORDER BY id LIMIT 1`,
  ).get(dueno, numeroId, ...clases, waId);
  if (!r) return null;
  if (r.veces > 1) db.prepare(`UPDATE reglas SET veces = veces - 1 WHERE id = ?`).run(r.id);
  else if (r.veces === 1) db.prepare(`DELETE FROM reglas WHERE id = ?`).run(r.id);
  return r;
}

/* ─────────────────────── Medios ─────────────────────── */

graph.post("/:phoneNumberId/media", autenticar, subida.single("file"), (req, res) => {
  const numero = numeroDe(req.params.phoneNumberId, req.cuenta);
  if (!numero) return responderError(res, errorMeta(100, "Object with ID does not exist", { status: 404 }));
  if (!req.file) return responderError(res, errorMeta(100, "Param file is required"));

  const id = nuevoId(16);
  const ruta = resolve(MEDIOS, id);
  writeFileSync(ruta, req.file.buffer);
  db.prepare(
    `INSERT INTO medios (id, numero_id, dueno, mime_type, sha256, file_size, ruta, nombre, creado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, numero.id, req.cuenta.dueno, req.file.mimetype, sha256(req.file.buffer),
        req.file.size, ruta, req.file.originalname ?? null, Date.now());
  res.json({ id });
});

/** Metadatos del medio. Meta da una URL que hay que pedir CON el token. */
graph.get("/:mediaId", autenticar, (req, res, next) => {
  const m = db.prepare(`SELECT * FROM medios WHERE id = ? AND dueno = ?`)
    .get(req.params.mediaId, req.cuenta.dueno);
  if (!m) return next();               // no es un medio: que lo intente otra ruta
  res.json({
    messaging_product: "whatsapp",
    url: `${publica(req)}/v21.0/${m.id}/descargar`,
    mime_type: m.mime_type,
    sha256: m.sha256,
    file_size: m.file_size,
    id: m.id,
  });
});

/** Lo que se puede servir tal cual, sin que el navegador lo ejecute. */
const SE_PUEDE_ENSEÑAR = /^(image\/(png|jpeg|gif|webp|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i;

graph.get("/:mediaId/descargar", autenticar, (req, res) => {
  const m = db.prepare(`SELECT * FROM medios WHERE id = ? AND dueno = ?`)
    .get(req.params.mediaId, req.cuenta.dueno);
  if (!m) return responderError(res, errorMeta(100, "Object with ID does not exist", { status: 404 }));

  /**
   * El tipo lo elige quien sube el archivo, así que un HTML subido se serviría
   * como HTML DESDE ESTE MISMO ORIGEN: una página así puede leer la sesión
   * guardada en el navegador. Lo que no es foto, vídeo, audio o PDF se manda a
   * descargar, y nunca se deja que el navegador adivine el tipo.
   */
  const seguro = SE_PUEDE_ENSEÑAR.test(m.mime_type || "");
  res.setHeader("content-type", seguro ? m.mime_type : "application/octet-stream");
  res.setHeader("x-content-type-options", "nosniff");
  if (!seguro) {
    const nombre = String(m.nombre || m.id).replace(/[^\w.\- ]+/g, "_");
    res.setHeader("content-disposition", `attachment; filename="${nombre}"`);
  }
  createReadStream(m.ruta).pipe(res);
});

const publica = (req) =>
  (process.env.SANDBOX_URL_PUBLICA || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

/* ─────────────────────── El número ─────────────────────── */

/**
 * `GET /{phone_number_id}?fields=verified_name,display_phone_number`. La
 * plataforma lo usa al conectar un canal para enseñar de qué número se trata.
 * Va DESPUÉS de la ruta de medios porque comparten forma.
 */
graph.get("/:phoneNumberId", autenticar, (req, res) => {
  const n = numeroDe(req.params.phoneNumberId, req.cuenta);
  if (!n) return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  const pedidos = String(req.query.fields || "verified_name,display_phone_number")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const todo = {
    id: n.id,
    verified_name: n.verified_name,
    display_phone_number: n.display_phone_number,
    quality_rating: n.quality_rating,
    code_verification_status: "VERIFIED",
    platform_type: "CLOUD_API",
  };
  const salida = { id: n.id };
  for (const f of pedidos) if (f in todo) salida[f] = todo[f];
  res.json(salida);
});

/** Registrar el número (el paso de PIN de Cloud API). */
graph.post("/:phoneNumberId/register", autenticar, (req, res) => {
  const n = numeroDe(req.params.phoneNumberId, req.cuenta);
  if (!n) return responderError(res, errorMeta(100, "Object with ID does not exist", { status: 404 }));
  db.prepare(`UPDATE numeros SET registrado = 1 WHERE id = ?`).run(n.id);
  res.json({ success: true });
});

/* ─────────────────────── Plantillas ─────────────────────── */

/**
 * Los encabezados de imagen, video o documento.
 *
 * Meta exige que la muestra llegue como el `h` de una subida reanudable en
 * `example.header_handle[0]`, y que el archivo case con el formato. Aquí solo
 * vale un `h` que este sandbox haya entregado a ESTE dueño.
 *
 * Una URL —la que devuelve el propio GET de plantillas— se rechaza. La
 * documentación de Meta no dice si la acepta al editar; ante la duda, el clon
 * se queda con la respuesta estricta: si la plataforma ensaya aquí, ensaya el
 * camino que seguro funciona allá (volver a subir el archivo).
 */
const FORMATO_MEDIO = {
  IMAGE: ["image/jpeg", "image/jpg", "image/png"],
  VIDEO: ["video/mp4"],
  DOCUMENT: ["application/pdf"],
};

function errorDeEncabezado(componentes, dueno) {
  const cab = (componentes || []).find((c) => String(c?.type).toUpperCase() === "HEADER");
  if (!cab) return null;
  const fmt = String(cab.format || "TEXT").toUpperCase();
  if (!FORMATO_MEDIO[fmt]) return null;
  const h = cab.example?.header_handle?.[0];
  const mal = (msg) => errorMeta(100, "Invalid parameter", { subcode: 2388047, status: 400, usuario: msg });
  if (!h) return mal(`A ${fmt} header requires example.header_handle with an uploaded media handle.`);
  const sub = db.prepare(`SELECT * FROM subidas WHERE handle = ? AND dueno = ?`).get(String(h), dueno);
  if (!sub) return mal("The media handle in example.header_handle is not valid. Upload the sample with the Resumable Upload API.");
  if (!FORMATO_MEDIO[fmt].includes(sub.tipo)) {
    return mal(`The uploaded sample (${sub.tipo}) does not match the header format ${fmt}.`);
  }
  return null;
}

/** El GET devuelve la muestra como URL, igual que Meta (scontent.whatsapp.net). */
function componentesParaListar(componentes, req) {
  return componentes.map((c) => {
    const h = c?.example?.header_handle?.[0];
    if (String(c?.type).toUpperCase() !== "HEADER" || !h) return c;
    const sub = db.prepare(`SELECT token_publico FROM subidas WHERE handle = ?`).get(String(h));
    if (!sub) return c;
    return { ...c, example: { ...c.example, header_handle: [`${publica(req)}/muestras/${sub.token_publico}`] } };
  });
}

graph.get("/:wabaId/message_templates", autenticar, (req, res) => {
  if (req.params.wabaId !== req.cuenta.id) {
    return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  }
  /* Meta filtra por `name` (y la plataforma lo usa para buscar el id antes de
     editar). Sin el filtro aquí, la búsqueda devolvía todas y acertaba de
     casualidad. */
  const nombre = req.query.name ? String(req.query.name) : null;
  const filas = db.prepare(
    `SELECT * FROM plantillas WHERE cuenta_id = ? ${nombre ? "AND nombre = ?" : ""} ORDER BY creada DESC`,
  ).all(...(nombre ? [req.params.wabaId, nombre] : [req.params.wabaId]));
  res.json({
    data: filas.map((p) => ({
      id: p.id,
      name: p.nombre,
      language: p.idioma,
      category: p.categoria,
      status: p.estado,
      components: componentesParaListar(JSON.parse(p.componentes), req),
    })),
    paging: { cursors: { before: "", after: "" } },
  });
});

graph.post("/:wabaId/message_templates", autenticar, (req, res) => {
  if (req.params.wabaId !== req.cuenta.id) {
    return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  }
  const { name, language, category, components } = req.body || {};
  if (!name || !language) return responderError(res, errorMeta(100, "Params name and language are required"));
  const malEnc = errorDeEncabezado(components, req.cuenta.dueno);
  if (malEnc) return responderError(res, malEnc);
  const id = nuevoId(15);
  db.prepare(
    `INSERT INTO plantillas (id, cuenta_id, dueno, nombre, idioma, categoria, estado, componentes, creada)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
  ).run(id, req.params.wabaId, req.cuenta.dueno, name, language,
        category || "UTILITY", JSON.stringify(components || []), Date.now());
  // Meta responde con la plantilla en revisión; quien aprueba o rechaza aquí
  // eres tú desde la interfaz, que es lo que contra Meta no se puede ensayar.
  res.json({ id, status: "PENDING", category: category || "UTILITY" });
});

/**
 * `POST /{template-id}` — editar una plantilla.
 *
 * Lo que documenta Meta (gestión de plantillas): solo APPROVED, REJECTED o
 * PAUSED; se cambian `components` (TODOS se reemplazan), `category` o el
 * tiempo de vida; a una aprobada no se le cambia la categoría; una aprobada se
 * edita 1 vez cada 24 h y 10 en 30 días. Los textos de error de esos límites
 * Meta no los publica: aquí van con código 100 y un mensaje claro.
 *
 * Tras editar queda PENDING hasta que la apruebes en la interfaz: Meta la
 * vuelve a revisar, y esa revisión aquí la haces tú.
 */
graph.post("/:templateId", autenticar, (req, res, next) => {
  const p = db.prepare(`SELECT * FROM plantillas WHERE id = ? AND cuenta_id = ? AND dueno = ?`)
    .get(req.params.templateId, req.cuenta.id, req.cuenta.dueno);
  if (!p) return next();
  const { components, category } = req.body || {};
  const mal = (msg) => responderError(res, errorMeta(100, "Invalid parameter", { status: 400, usuario: msg }));
  if (!["APPROVED", "REJECTED", "PAUSED"].includes(p.estado)) {
    return mal("Only templates with an APPROVED, REJECTED, or PAUSED status can be edited.");
  }
  if (!components && !category) return mal("Nothing to edit: send components or category.");
  if (category && p.estado === "APPROVED" && category !== p.categoria) {
    return mal("The category of an approved template can't be edited.");
  }
  if (p.estado === "APPROVED") {
    const dia = db.prepare(`SELECT count(*) n FROM ediciones_plantilla WHERE plantilla_id = ? AND cuando > ?`)
      .get(p.id, Date.now() - 24 * 3600 * 1000).n;
    const mes = db.prepare(`SELECT count(*) n FROM ediciones_plantilla WHERE plantilla_id = ? AND cuando > ?`)
      .get(p.id, Date.now() - 30 * 24 * 3600 * 1000).n;
    if (dia >= 1) return mal("Approved templates can be edited only once in a 24-hour window.");
    if (mes >= 10) return mal("Approved templates can be edited up to 10 times in a 30-day window.");
  }
  if (components) {
    if (!Array.isArray(components) || !components.length) return mal("Param components must be a non-empty array.");
    const malEnc = errorDeEncabezado(components, req.cuenta.dueno);
    if (malEnc) return responderError(res, malEnc);
  }
  if (p.estado === "APPROVED") {
    db.prepare(`INSERT INTO ediciones_plantilla (plantilla_id, cuando) VALUES (?, ?)`).run(p.id, Date.now());
  }
  db.prepare(`UPDATE plantillas SET componentes = ?, categoria = ?, estado = 'PENDING' WHERE id = ?`)
    .run(components ? JSON.stringify(components) : p.componentes, category || p.categoria, p.id);
  res.json({ success: true });
});

/** La muestra servida sin token, como una URL firmada de scontent. */
export function servirMuestra(req, res) {
  const s = db.prepare(`SELECT * FROM subidas WHERE token_publico = ? AND handle IS NOT NULL`).get(String(req.params.token));
  if (!s) return res.status(404).end();
  res.setHeader("content-type", s.tipo === "image/jpg" ? "image/jpeg" : s.tipo);
  res.setHeader("x-content-type-options", "nosniff");
  createReadStream(s.ruta).pipe(res);
}

/* ─────────────────────── Catálogo ─────────────────────── */

/**
 * El catálogo del negocio.
 *
 * Meta se lo niega al token de un negocio pequeño («This operation can not be
 * performed on SMB business type»), y por eso un catálogo real de un negocio
 * chico hay que leerlo con un WhatsApp Web. Aquí sí se deja leer: la gracia es
 * poder ensayar el cruce de un carrito con sus nombres sin depender de que Meta
 * apruebe un permiso.
 */
graph.get("/:wabaId/product_catalogs", autenticar, (req, res) => {
  if (req.params.wabaId !== req.cuenta.id) {
    return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  }
  res.json({
    data: [{ id: `cat_${req.params.wabaId}`, name: `Catálogo de ${req.cuenta.nombre}`, vertical: "commerce" }],
    paging: { cursors: { before: "", after: "" } },
  });
});

graph.get("/:catalogId/products", autenticar, (req, res) => {
  const cuentaId = String(req.params.catalogId).replace(/^cat_/, "");
  if (cuentaId !== req.cuenta.id) {
    return responderError(res, errorMeta(100, "Unsupported get request. Object with ID does not exist", { subcode: 33, status: 404 }));
  }
  /* También por dueño: si una fila ajena se colara en esta cuenta, el catálogo
     que lee el agente es justo donde más daño hace un texto de otro. */
  const filas = db.prepare(`SELECT * FROM productos WHERE cuenta_id = ? AND dueno = ? ORDER BY creado`)
    .all(cuentaId, req.cuenta.dueno);
  res.json({
    data: filas.map((p) => ({
      id: p.retailer_id,
      retailer_id: p.retailer_id,
      name: p.nombre,
      description: p.descripcion || "",
      price: p.precio != null ? String(Math.round(p.precio * 1000)) : undefined, // Meta manda milésimas
      currency: p.moneda,
      availability: "in stock",
    })),
    paging: { cursors: { before: "", after: "" } },
  });
});

export { entregar };
