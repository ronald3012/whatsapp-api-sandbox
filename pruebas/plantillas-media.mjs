/**
 * Plantillas con encabezado de imagen, video o documento: el contrato de Meta.
 *
 *   1. La subida reanudable: POST /{app-id}/uploads → POST /upload:{sesión}
 *      con `file_offset` → `{h}`; GET /upload:{sesión} para reanudar.
 *   2. Crear: el HEADER de media exige `example.header_handle[0]` = ese `h`.
 *   3. Listar: la muestra vuelve como URL descargable (la «scontent» de Meta).
 *   4. Editar: POST /{template-id}, con las reglas de estado y de 24 h.
 *   5. Enviar: sin el archivo del encabezado, 132012.
 *
 * Usa la cuenta «Repuesto de Prueba», que no está conectada a ninguna
 * plataforma: así las plantillas de ensayo no ensucian el canal de nadie.
 *
 *   node pruebas/plantillas-media.mjs
 */
import Database from "better-sqlite3";

const S = process.env.SANDBOX_URL || "http://localhost:8095";
const V = `${S}/v21.0`;
const bd = new Database(new URL("../datos/sandbox.db", import.meta.url).pathname, { readonly: true });
const cta = bd.prepare("SELECT * FROM cuentas WHERE nombre = 'Repuesto de Prueba'").get();
if (!cta) { console.error("Falta la cuenta «Repuesto de Prueba» en el sandbox"); process.exit(1); }
const nro = bd.prepare("SELECT * FROM numeros WHERE cuenta_id = ?").get(cta.id);
const CLAVE = bd.prepare("SELECT clave FROM duenos WHERE id = ?").get(cta.dueno).clave;
const ajena = bd.prepare("SELECT * FROM cuentas WHERE dueno <> ? LIMIT 1").get(cta.dueno);
const TOKEN = cta.token;

const fallos = [];
const ok = (c, m) => { console.log((c ? "OK   " : "FALLO") + " " + m); if (!c) fallos.push(m); };
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });
const json = async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function subir(buf, tipo, { token = TOKEN, appId } = {}) {
  const app = appId || (await (await fetch(`${V}/debug_token?input_token=${token}`, { headers: auth(token) })).json()).data.app_id;
  const ses = await json(await fetch(
    `${V}/${app}/uploads?file_name=x&file_length=${buf.length}&file_type=${encodeURIComponent(tipo)}`,
    { method: "POST", headers: { authorization: `OAuth ${token}` } }));
  const sub = await json(await fetch(`${V}/${ses.j.id}`, {
    method: "POST", headers: { authorization: `OAuth ${token}`, file_offset: "0" }, body: buf }));
  return sub.j.h;
}

const crear = (name, components) => fetch(`${V}/${cta.id}/message_templates`, {
  method: "POST", headers: { ...auth(), "content-type": "application/json" },
  body: JSON.stringify({ name, language: "es", category: "MARKETING", components }),
}).then(json);
const editar = (id, cuerpo) => fetch(`${V}/${id}`, {
  method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(cuerpo),
}).then(json);
const aprobar = (id) => fetch(`${S}/panel/plantillas/${id}/estado`, {
  method: "POST", headers: { "x-clave": CLAVE, "content-type": "application/json" },
  body: JSON.stringify({ estado: "APPROVED" }),
});
const cab = (format, h) => ({ type: "HEADER", format, example: { header_handle: [h] } });
const cuerpo = { type: "BODY", text: "Hola, mira esto" };
const sufijo = Date.now().toString(36);

console.log("\n--- 1. La app del token ---");
const dbg = await json(await fetch(`${V}/debug_token?input_token=${TOKEN}`, { headers: auth() }));
const APP = dbg.j.data?.app_id;
ok(dbg.status === 200 && /^\d+$/.test(APP || ""), `debug_token devuelve data.app_id numérico (${APP})`);

console.log("\n--- 2. La subida reanudable ---");
{
  const r = await json(await fetch(`${V}/999999999/uploads?file_length=10&file_type=image/png`,
    { method: "POST", headers: { authorization: `OAuth ${TOKEN}` } }));
  ok(r.status === 400 && r.j.error?.code === 100, `con una app que no es la del token, error 100 (${r.status}/${r.j.error?.code})`);
  const t = await json(await fetch(`${V}/${APP}/uploads?file_length=10&file_type=image/gif`,
    { method: "POST", headers: { authorization: `OAuth ${TOKEN}` } }));
  ok(t.status === 400 && t.j.error?.code === 100, `un gif no se admite: solo pdf, jpeg, jpg, png y mp4 (${t.j.error?.code})`);

  const s = await json(await fetch(`${V}/${APP}/uploads?file_name=a.png&file_length=${PNG.length}&file_type=image/png`,
    { method: "POST", headers: { authorization: `OAuth ${TOKEN}` } }));
  ok(/^upload:/.test(s.j.id || ""), `la sesión empieza por «upload:» (${s.j.id?.slice(0, 16)}…)`);
  const mitad = Math.floor(PNG.length / 2);
  const p1 = await json(await fetch(`${V}/${s.j.id}`, { method: "POST",
    headers: { authorization: `OAuth ${TOKEN}`, file_offset: "0" }, body: PNG.subarray(0, mitad) }));
  ok(p1.j.file_offset === mitad && !p1.j.h, `a medias no hay handle todavía (offset ${p1.j.file_offset})`);
  const g = await json(await fetch(`${V}/${s.j.id}`, { headers: { authorization: `OAuth ${TOKEN}` } }));
  ok(g.j.file_offset === mitad, `GET de la sesión dice desde dónde reanudar (${g.j.file_offset})`);
  const malo = await json(await fetch(`${V}/${s.j.id}`, { method: "POST",
    headers: { authorization: `OAuth ${TOKEN}`, file_offset: "0" }, body: PNG.subarray(mitad) }));
  ok(malo.status === 400, `reanudar con el offset equivocado se rechaza (${malo.status})`);
  const p2 = await json(await fetch(`${V}/${s.j.id}`, { method: "POST",
    headers: { authorization: `OAuth ${TOKEN}`, file_offset: String(mitad) }, body: PNG.subarray(mitad) }));
  ok(/^4::/.test(p2.j.h || ""), `al llegar el último byte devuelve {h} (${String(p2.j.h).slice(0, 10)}…)`);
}

console.log("\n--- 3. Crear con encabezado de media ---");
const hImg = await subir(PNG, "image/png");
const hPdf = await subir(PDF, "application/pdf");
{
  const sin = await crear(`img_sin_${sufijo}`, [{ type: "HEADER", format: "IMAGE" }, cuerpo]);
  ok(sin.status === 400 && sin.j.error?.error_subcode === 2388047, `IMAGE sin header_handle → 2388047 (${sin.j.error?.error_subcode})`);
  const url = await crear(`img_url_${sufijo}`, [cab("IMAGE", "https://scontent.whatsapp.net/v/x.png"), cuerpo]);
  ok(url.status === 400, `una URL en lugar del handle se rechaza (${url.status})`);
  const cruzado = await crear(`img_pdf_${sufijo}`, [cab("IMAGE", hPdf), cuerpo]);
  ok(cruzado.status === 400, `un PDF como muestra de IMAGE se rechaza (${cruzado.status})`);
  if (ajena) {
    const hAjeno = await subir(PNG, "image/png", { token: ajena.token });
    const r = await crear(`img_ajena_${sufijo}`, [cab("IMAGE", hAjeno), cuerpo]);
    ok(r.status === 400, `el handle de otro negocio no vale aquí (${r.status})`);
  }
}
const creada = await crear(`img_ok_${sufijo}`, [cab("IMAGE", hImg), cuerpo]);
ok(creada.status === 200 && creada.j.status === "PENDING", `con su handle nace PENDING (${creada.j.status})`);
const ID = creada.j.id;

console.log("\n--- 4. Listar: la muestra vuelve como URL ---");
{
  const l = await json(await fetch(`${V}/${cta.id}/message_templates?name=img_ok_${sufijo}`, { headers: auth() }));
  ok(l.j.data?.length === 1, `el filtro por name devuelve solo esa (${l.j.data?.length})`);
  const u = l.j.data?.[0]?.components?.[0]?.example?.header_handle?.[0] || "";
  ok(/^https?:\/\/.+\/muestras\//.test(u), "header_handle se lista como URL, como scontent de Meta");
  const b = await fetch(u);
  ok(b.ok && b.headers.get("content-type") === "image/png", `la URL se baja sin token y con su tipo (${b.status})`);
  ok(Buffer.from(await b.arrayBuffer()).equals(PNG), "los bytes son los que se subieron");
}

console.log("\n--- 5. Editar ---");
{
  const pend = await editar(ID, { components: [cab("IMAGE", hImg), cuerpo] });
  ok(pend.status === 400, `una PENDING no se edita (${pend.status})`);
  await aprobar(ID);
  const l = await json(await fetch(`${V}/${cta.id}/message_templates?name=img_ok_${sufijo}`, { headers: auth() }));
  const urlActual = l.j.data[0].components[0].example.header_handle[0];
  const conUrl = await editar(ID, { components: [cab("IMAGE", urlActual), { type: "BODY", text: "Texto nuevo" }] });
  ok(conUrl.status === 400, `editar mandando la URL de la muestra se rechaza (${conUrl.status})`);
  const cat = await editar(ID, { category: "UTILITY" });
  ok(cat.status === 400, `a una aprobada no se le cambia la categoría (${cat.status})`);
  const hNuevo = await subir(PNG, "image/png");
  const bien = await editar(ID, { components: [cab("IMAGE", hNuevo), { type: "BODY", text: "Texto nuevo" }] });
  ok(bien.status === 200 && bien.j.success === true, `con un handle nuevo, {success:true} (${bien.status})`);
  await aprobar(ID);
  const otra = await editar(ID, { components: [cab("IMAGE", hNuevo), cuerpo] });
  ok(otra.status === 400, `una aprobada no se edita dos veces en 24 h (${otra.status})`);
}

console.log("\n--- 6. Enviar: el archivo del encabezado es obligatorio ---");
{
  const env = (template) => fetch(`${V}/${nro.id}/messages`, {
    method: "POST", headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: "18295550101", type: "template", template }),
  }).then(json);
  const sin = await env({ name: `img_ok_${sufijo}`, language: { code: "es" } });
  ok(sin.status === 400 && sin.j.error?.code === 132012, `sin encabezado → 132012 (${sin.j.error?.code})`);
  ok(/expected IMAGE, received UNKNOWN/.test(sin.j.error?.error_data?.details || ""), "con el detalle que da Meta");
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("file", new Blob([PNG], { type: "image/png" }), "e.png");
  const media = await json(await fetch(`${V}/${nro.id}/media`, { method: "POST", headers: auth(), body: fd }));
  const doc = await env({ name: `img_ok_${sufijo}`, language: { code: "es" },
    components: [{ type: "header", parameters: [{ type: "document", document: { id: media.j.id } }] }] });
  ok(doc.status === 400 && doc.j.error?.code === 132012, `un documento para una IMAGE → 132012 (${doc.j.error?.code})`);
  const bien = await env({ name: `img_ok_${sufijo}`, language: { code: "es" },
    components: [{ type: "header", parameters: [{ type: "image", image: { id: media.j.id } }] }] });
  ok(bien.status === 200 && !!bien.j.messages?.[0]?.id, `con la imagen, se acepta (${bien.status})`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(fallos.length ? `FALLOS: ${fallos.length}` : "TODO PASÓ");
fallos.forEach((f) => console.log("  x " + f));
process.exit(fallos.length ? 1 : 0);
