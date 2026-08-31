/**
 * La entrega de eventos hacia la plataforma: lo que en Meta sale de sus
 * servidores y aquí sale del sandbox.
 *
 * Dos cosas no son negociables si queremos que la plataforma no note la
 * diferencia:
 *   1. La firma se calcula sobre el MISMO texto que se manda, byte a byte. Por
 *      eso se serializa una vez y se reusa: re-serializar para firmar cambia el
 *      hash por un espacio y el webhook se rechaza sin explicar nada.
 *   2. Cada intento queda guardado, salga bien o mal. Un evento que no llegó y
 *      no dejó rastro es exactamente el agujero por el que se nos han ido las
 *      horas depurando en producción.
 */
import { db } from "./db.js";
import { firmar, sobreEstado, ahora } from "./meta.js";
import { avisar } from "./eventos.js";

/**
 * El apretón de manos de Meta: antes de mandar nada, Meta llama al webhook con
 * `hub.mode=subscribe`, `hub.verify_token` y `hub.challenge`, y espera que le
 * devuelvan el challenge tal cual.
 *
 * Tu plataforma implementa ese camino y casi nunca se ejercita: si se rompiera,
 * conectar un cliente nuevo fallaría y no nos enteraríamos hasta tenerlo
 * delante.
 */
export async function verificarWebhook(cuenta) {
  if (!cuenta.webhook_url) return { ok: false, motivo: "sin webhook configurado" };
  const vetada = await porQueNoSePuedeEntregar(cuenta.webhook_url);
  if (vetada) return { ok: false, motivo: vetada };
  const reto = "reto-" + Math.random().toString(36).slice(2, 12);
  const u = new URL(cuenta.webhook_url);
  u.searchParams.set("hub.mode", "subscribe");
  u.searchParams.set("hub.verify_token", cuenta.verify_token);
  u.searchParams.set("hub.challenge", reto);
  try {
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    const cuerpo = (await r.text()).trim();
    const ok = r.ok && cuerpo === reto;
    /* El cuerpo NO se devuelve: si la dirección apuntara a algo interno, esta
       respuesta sería la fuga. Basta con si contestó bien o no. */
    return { ok, estado: r.status,
      motivo: ok ? "" : r.ok ? "contestó, pero no devolvió el challenge tal cual" : `respondió ${r.status}` };
  } catch (err) {
    return { ok: false, motivo: String(err.message).slice(0, 120) };
  }
}

/**
 * Entregar un sobre. `reintentos` imita lo que hace Meta de verdad: si el
 * servidor no contesta bien, lo vuelve a intentar —hasta 7 días—, y esa
 * reentrega llega con el MISMO id de mensaje.
 *
 * Eso importa porque tu plataforma tendrá un dedupe para no duplicar, y
 * ese código nunca se había ejercitado: si falla, cada caída del servidor
 * duplica la conversación entera al volver.
 */
/**
 * ¿Se puede entregar a esa dirección?
 *
 * El webhook lo escribe cada usuario y lo llama el SERVIDOR: sin freno, eso
 * convierte al sandbox en un puente hacia la red donde vive —la dirección de
 * metadatos del proveedor, un panel interno sin contraseña—, y como la
 * respuesta vuelve al inquilino, además sirve de escáner.
 *
 * Cerrado por defecto. En local, donde apuntar a `localhost` es EL caso
 * normal, se abre con `SANDBOX_RED_PRIVADA=1`. Al revés —abierto salvo que
 * pidas cerrarlo— el día que alguien despliega sin leer el README queda con la
 * puerta abierta, y esa no es forma de repartir un riesgo.
 *
 * Se comprueba la IP RESUELTA, no el nombre: `mio.ejemplo.com` puede apuntar a
 * 169.254.169.254, y `2130706433` u `0x7f000001` son 127.0.0.1 escritos de otra
 * forma. Y `fetch` no sigue redirecciones, que es la otra manera de acabar
 * dentro.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PERMITE_PRIVADAS = process.env.SANDBOX_RED_PRIVADA === "1";

/** ¿Esa IP es de una red que no debería alcanzarse desde fuera? */
export function esPrivada(ip) {
  const v = String(ip);
  if (isIP(v) === 6) {
    const b = v.toLowerCase();
    return b === "::1" || b === "::" || /^f[cd]/.test(b) || /^fe[89ab]/.test(b) ||
           /^::ffff:/.test(b) && esPrivada(b.replace(/^::ffff:/, ""));
  }
  const [a, b] = v.split(".").map(Number);
  if (Number.isNaN(a)) return true;                 // no es una IP: no se arriesga
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
         (a === 169 && b === 254) ||                // metadatos del proveedor
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) ||
         (a === 100 && b >= 64 && b <= 127);        // CGNAT
}

export async function porQueNoSePuedeEntregar(url) {
  let u;
  try { u = new URL(url); } catch { return "esa dirección no es una URL"; }
  if (!/^https?:$/.test(u.protocol)) return "la dirección tiene que empezar por http:// o https://";
  if (PERMITE_PRIVADAS) return null;

  const nombre = u.hostname.replace(/^\[|\]$/g, "");
  let ips;
  try {
    ips = isIP(nombre) ? [{ address: nombre }] : await lookup(nombre, { all: true });
  } catch {
    return `no se pudo resolver «${nombre}»`;
  }
  if (ips.some((x) => esPrivada(x.address))) {
    return "esa dirección resuelve a una red privada, y este sandbox solo entrega a direcciones públicas";
  }
  return null;
}

export async function entregar({ cuenta, numero, sobre, reintentos = 0 }) {
  const url = cuenta.webhook_url;
  const crudo = JSON.stringify(sobre);

  const vetada = url ? await porQueNoSePuedeEntregar(url) : null;
  if (url && vetada) {
    db.prepare(
      `INSERT INTO entregas (dueno, numero_id, url, cuerpo, estado, error, cuando)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(cuenta.dueno, numero?.id ?? null, url, crudo, vetada, Date.now());
    avisar({ tipo: "entrega", estado: null, error: vetada }, cuenta.dueno);
    return { ok: false, motivo: vetada };
  }

  if (!url) {
    db.prepare(
      `INSERT INTO entregas (dueno, numero_id, url, cuerpo, estado, error, cuando)
       VALUES (?, ?, '', ?, NULL, ?, ?)`,
    ).run(cuenta.dueno, numero?.id ?? null, crudo, "la cuenta no tiene webhook configurado", Date.now());
    return { ok: false, motivo: "sin webhook" };
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Igual que Meta. La plataforma verifica esta cabecera contra el cuerpo
        // crudo usando el app secret.
        "x-hub-signature-256": firmar(crudo, cuenta.app_secret),
        "user-agent": "facebookplatform/1.0",
      },
      body: crudo,
      redirect: "manual",          // un 302 hacia dentro es la otra puerta
      signal: AbortSignal.timeout(15000),
    });
    const respuesta = (await r.text().catch(() => "")).slice(0, 500);
    db.prepare(
      `INSERT INTO entregas (dueno, numero_id, url, cuerpo, estado, respuesta, cuando)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(cuenta.dueno, numero?.id ?? null, url, crudo, r.status, respuesta, Date.now());
    avisar({ tipo: "entrega", estado: r.status }, cuenta.dueno);
    if (!r.ok && reintentos > 0) {
      await new Promise((v) => setTimeout(v, 1500));
      return entregar({ cuenta, numero, sobre, reintentos: reintentos - 1 });
    }
    return { ok: r.ok, estado: r.status, respuesta };
  } catch (err) {
    db.prepare(
      `INSERT INTO entregas (dueno, numero_id, url, cuerpo, estado, error, cuando)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(cuenta.dueno, numero?.id ?? null, url, crudo, String(err.message).slice(0, 300), Date.now());
    avisar({ tipo: "entrega", estado: null, error: String(err.message).slice(0, 120) }, cuenta.dueno);
    if (reintentos > 0) {
      await new Promise((v) => setTimeout(v, 1500));
      return entregar({ cuenta, numero, sobre, reintentos: reintentos - 1 });
    }
    return { ok: false, motivo: String(err.message) };
  }
}

/**
 * Los acuses de un mensaje saliente: ✓ enviado, ✓✓ entregado, y azul al leer.
 *
 * En WhatsApp real llegan separados en el tiempo, y ese retraso IMPORTA: la
 * plataforma cruza cada acuse con el mensaje ya guardado, y un acuse que llega
 * antes de que el envío se haya terminado de guardar se queda huérfano. Ese
 * fallo es real y solo aparece con carrera de por medio, así que aquí se
 * escalonan de verdad en vez de mandarlos los tres de golpe.
 *
 * El leído NO se manda solo: lo decide una persona desde la interfaz, igual que
 * en la vida real lo decide quien abre el chat.
 */
export function programarAcuses({ cuenta, numero, wamid, waId, fallo }) {
  const marcar = (estado, extra = {}) => {
    db.prepare(`UPDATE mensajes SET estado = ? WHERE id = ?`).run(estado, wamid);
    avisar({ tipo: "estado", numeroId: numero.id, waId }, cuenta.dueno);
    return entregar({
      cuenta,
      numero,
      sobre: sobreEstado({
        waba: cuenta.id,
        numero,
        estado: {
          id: wamid,
          status: estado,
          timestamp: String(ahora()),
          recipient_id: waId,
          ...extra,
        },
      }),
    });
  };

  if (fallo) {
    // Un envío que Meta acepta pero no entrega: responde 200 al enviar y el
    // problema llega DESPUÉS, por webhook. Que sea así aquí también es el
    // punto entero de poder ensayarlo.
    setTimeout(() => {
      marcar("failed", {
        errors: [
          {
            code: fallo.code,
            title: fallo.message,
            message: fallo.message,
            error_data: { details: fallo.details },
          },
        ],
      }).catch(() => {});
    }, 1200);
    return;
  }

  setTimeout(() => { marcar("sent", conversacion()).catch(() => {}); }, 400);
  setTimeout(() => { marcar("delivered").catch(() => {}); }, 1600);
}

/** Meta adjunta la conversación y su precio en el primer acuse. */
const conversacion = () => ({
  conversation: {
    id: "sandbox-" + Math.random().toString(36).slice(2, 12),
    origin: { type: "service" },
  },
  pricing: { billable: true, pricing_model: "CBP", category: "service" },
});
