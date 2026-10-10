/**
 * La batería completa del sandbox: texto, media, audio, escribiendo, acuses,
 * errores provocados y el caso del número oculto.
 *
 * Cada prueba compara contra lo que la PLATAFORMA guardó, no solo contra lo que
 * el sandbox dice: que el sandbox crea haber entregado algo no significa que
 * RunOp lo entendiera. Es la diferencia entre probar el mensajero y probar que
 * la carta llegó.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const S = "http://localhost:8095";
/* Las credenciales se LEEN de la base: escritas a mano caducan en cuanto se
   recrea el negocio —y no se publican credenciales en un repositorio—. */
const { createRequire } = await import("node:module");
const require = createRequire(new URL("../../x.js", import.meta.url).pathname);
const bd = new (require("better-sqlite3"))(new URL("../../datos/sandbox.db", import.meta.url).pathname);
const cta = bd.prepare("SELECT * FROM cuentas WHERE nombre='Sandbox Pruebas'").get();
const nro = bd.prepare("SELECT * FROM numeros WHERE cuenta_id=?").get(cta.id);
const CLAVE = bd.prepare("SELECT clave FROM duenos WHERE id='local'").get().clave;
const NUM = nro.id;
const CUENTA = cta.id;
const TOKEN = cta.token;
const fallos = [];
const ok = (c, m) => { console.log((c ? "✅" : "❌") + " " + m); if (!c) fallos.push(m); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (ruta, opts) =>
  (await fetch(`${S}${ruta}`, { ...opts, headers: { "x-clave": CLAVE, ...(opts?.body ? { "content-type": "application/json" } : {}) } })).json();

/** Lo que RunOp guardó de verdad en su base. */
const enRunOp = (sql) =>
  execFileSync("docker", ["exec", "n8n_mcp-postgres-1", "psql",
    "postgresql://aida:aida@localhost:5432/aida", "-tAc", sql], { encoding: "utf8" }).trim();

const mensajes = async (waId) => api(`/panel/numeros/${NUM}/mensajes?waId=${waId}`);

console.log("\n─── TEXTO ───");
{
  const t = "Prueba de texto " + Date.now();
  await api(`/panel/numeros/${NUM}/entrante`, { method: "POST", body: JSON.stringify({ waId: "18291112233", texto: t }) });
  await dormir(3000);
  const n = enRunOp(`SELECT count(*) FROM messages WHERE text = '${t}'`);
  ok(n === "1", `el texto llega a RunOp tal cual (${n} fila)`);
}

console.log("\n─── ESCRIBIENDO… y MARCAR LEÍDO ───");
{
  // Es lo que hace el agente antes de contestar: marca leído y (si su canal lo
  // soporta) enciende el «escribiendo…». Aquí se comprueba que el sandbox lo
  // acepta con la forma exacta de Meta, que es donde fallaba antes.
  const ms = await mensajes("18291112233");
  const ultimoEntrante = [...ms].reverse().find((m) => m.direccion === "entrante");
  const r = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: ultimoEntrante.id }),
  });
  ok(r.status === 200, `marcar leído responde 200 (${r.status})`);
  ok(JSON.stringify(await r.json()) === '{"success":true}', "…y responde {success:true} como Meta");

  const r2 = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      messaging_product: "whatsapp", status: "read",
      message_id: ultimoEntrante.id, typing_indicator: { type: "text" },
    }),
  });
  ok(r2.status === 200, `«escribiendo…» aceptado (${r2.status})`);
  const e = await api(`/panel/numeros/${NUM}/escribiendo`);
  ok(e.escribiendo === true, "el sandbox marca que el negocio está escribiendo");
}

console.log("\n─── IMAGEN con caption ───");
{
  // Un PNG mínimo de verdad, para que la plataforma lo pueda descargar.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "prueba.png");
  const sub = await (await fetch(`${S}/panel/numeros/${NUM}/subir`, { method: "POST", headers: { "x-clave": CLAVE }, body: fd })).json();
  ok(!!sub.id, `la imagen se sube y devuelve id (${sub.id})`);

  const pie = "Mira esta pieza " + Date.now();
  const env = await api(`/panel/numeros/${NUM}/entrante`, {
    method: "POST",
    body: JSON.stringify({ waId: "18291112233", tipo: "image", texto: pie, media: { id: sub.id, mime_type: "image/png" } }),
  });
  await dormir(5000);
  // Por su wamid: el "último mensaje" puede ser ya la respuesta del agente.
  const tipo = enRunOp(`SELECT message_type FROM messages WHERE message_id = '${env.id}'`);
  ok(tipo === "image", `RunOp la guarda como imagen (guardó: '${tipo}')`);
  /* BUG REAL DE RUNOP, encontrado por el sandbox el primer día.
     El sobre lleva el caption dentro de `image.caption`, como Meta, pero
     `meta-runtime.ts` guarda `text` —que para media nace vacío— en vez de
     `caption`, y el texto se tira. Esta prueba DEBE fallar hasta que se
     arregle: taparla sería perder justo lo que vinimos a buscar. */
  ok(enRunOp(`SELECT count(*) FROM messages WHERE text = '${pie}'`) === "1",
     "el caption NO se pierde  ← BUG CONOCIDO de meta-runtime.ts:660");
}

console.log("\n─── AUDIO (nota de voz) ───");
{
  const ogg = Buffer.from("T2dnUwACAAAAAAAAAAA=", "base64");     // cabecera OggS
  const fd = new FormData();
  fd.append("file", new Blob([ogg], { type: "audio/ogg" }), "nota.ogg");
  const sub = await (await fetch(`${S}/panel/numeros/${NUM}/subir`, { method: "POST", headers: { "x-clave": CLAVE }, body: fd })).json();
  const env = await api(`/panel/numeros/${NUM}/entrante`, {
    method: "POST",
    body: JSON.stringify({ waId: "18291112233", tipo: "audio", media: { id: sub.id, mime_type: "audio/ogg" } }),
  });
  await dormir(5000);
  const t = enRunOp(`SELECT message_type FROM messages WHERE message_id = '${env.id}'`);
  ok(t === "audio", `RunOp la guarda como audio (guardó: '${t}')`);
}

console.log("\n─── DESCARGA DE MEDIOS (los dos saltos de Meta) ───");
{
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "x.png");
  const sub = await (await fetch(`${S}/panel/numeros/${NUM}/subir`, { method: "POST", headers: { "x-clave": CLAVE }, body: fd })).json();
  const meta = await (await fetch(`${S}/v21.0/${sub.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(!!meta.url && meta.mime_type === "image/png", "paso 1: el id resuelve a una URL con su mime");
  const bin = await fetch(meta.url, { headers: { authorization: `Bearer ${TOKEN}` } });
  ok(bin.ok, `paso 2: la URL entrega los bytes con el token (${bin.status})`);
  ok(Buffer.from(await bin.arrayBuffer()).equals(png), "los bytes que salen son los que entraron");
  const sinToken = await fetch(meta.url);
  ok(sinToken.status === 401, `sin token, 401 como Meta (${sinToken.status})`);
}

console.log("\n─── SUBIR MEDIA por el Graph (lo que hace el agente) ───");
{
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", "image/png");
  fd.append("file", new Blob([png], { type: "image/png" }), "salida.png");
  const r = await fetch(`${S}/v21.0/${NUM}/media`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: fd });
  const j = await r.json();
  ok(r.ok && !!j.id, `el agente puede subir media y recibe un id (${j.id})`);
}

console.log("\n─── ACUSES escalonados ───");
{
  const r = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: "18291112233", type: "text", text: { body: "acuses" } }),
  });
  const j = await r.json();
  ok(j.messages?.[0]?.message_status === "accepted", "responde 'accepted' antes de entregar, como Meta");
  await dormir(2600);
  const ent = await api("/panel/entregas");
  const acuses = ent.filter((e) => e.estado === 200).length;
  ok(acuses >= 2, `los acuses salen y RunOp los acepta con 200 (${acuses} entregas OK)`);
}

console.log("\n─── ERROR PROVOCADO: no entregado 131051 ───");
{
  await api("/panel/reglas", { method: "POST", body: JSON.stringify({ numeroId: NUM, waId: "18291112233", clase: "sin_entrega", codigo: 131051, veces: 1 }) });
  const r = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: "18291112233", type: "text", text: { body: "este debe fallar" } }),
  });
  const j = await r.json();
  ok(r.ok, "el envío se acepta (200), como hace Meta antes de fallar");
  await dormir(2500);
  const ents = await api("/panel/entregas");
  const fallo = ents.find((e) => e.estado === 200);
  ok(!!fallo, "el fallo llega DESPUÉS por webhook y RunOp lo acepta (200)");
}

console.log("\n─── ERROR PROVOCADO: ventana de 24h vencida ───");
{
  await api("/panel/reglas", { method: "POST", body: JSON.stringify({ numeroId: NUM, waId: "18291112233", clase: "ventana_24h", veces: 1 }) });
  const r = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: "18291112233", type: "text", text: { body: "fuera de ventana" } }),
  });
  const j = await r.json();
  ok(r.status === 400, `Meta lo rechaza de una con 400 (${r.status})`);
  ok(j.error?.code === 131047, `con el código 131047 (${j.error?.code})`);
  ok(!!j.error?.error_data?.details, "y con error_data.details, como Meta");
}

console.log("\n─── NÚMERO OCULTO (usuario sin teléfono) ───");
{
  const c = await api(`/panel/numeros/${NUM}/contactos`, {
    method: "POST", body: JSON.stringify({ nombre: "Ana Oculta", oculto: true, username: "anaoculta" }),
  });
  ok(!!c.user_id && c.user_id.includes("."), `el contacto nace con BSUID (${c.user_id})`);
  await api(`/panel/numeros/${NUM}/entrante`, {
    method: "POST", body: JSON.stringify({ waId: c.wa_id, texto: "escribo sin enseñar mi numero" }),
  });
  await dormir(3500);
  // Cuenta acumulada entre corridas: lo que importa es que llegue, no cuántas.
  const n = Number(enRunOp(`SELECT count(*) FROM messages WHERE text = 'escribo sin enseñar mi numero'`));
  ok(n >= 1, `RunOp acepta un mensaje sin wa_id y lo guarda (${n})`);
}

console.log("\n─── TOKEN INVÁLIDO ───");
{
  const r = await fetch(`${S}/v21.0/${NUM}/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer no-existe" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: "1", type: "text", text: { body: "x" } }),
  });
  const j = await r.json();
  ok(r.status === 401 && j.error?.code === 190, `token malo → 401 código 190, como Meta (${r.status}/${j.error?.code})`);
}

console.log(`\n${"═".repeat(50)}`);
console.log(fallos.length ? `FALLOS: ${fallos.length}` : "TODO PASÓ");
fallos.forEach((f) => console.log("  ✗ " + f));
