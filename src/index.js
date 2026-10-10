/**
 * El sandbox de WhatsApp.
 *
 *   /v21.0/...   el clon del Graph API de Meta (lo que la plataforma cree Meta)
 *   /panel/...   lo que Meta no tiene: crear cuentas falsas y escribir como ellas
 *   /            la interfaz
 *
 * No habla con Meta ni con ningún WhatsApp real. Ese es el punto entero: aquí
 * se puede probar mil veces sin que le llegue un mensaje a un cliente.
 */
import express from "express";
import { resolve } from "node:path";
import { graph, servirMuestra } from "./graph.js";
import { panel } from "./panel.js";
import { negocios } from "./negocios.js";
import { conectarSSE } from "./eventos.js";
import { quienEs, claveAdmin, registrarse, entrarConCuenta } from "./acceso.js";
import { carasDisponibles, CARPETA_CARAS } from "./caras.js";
import { rutasQr, socketQr } from "./qr.js";

/* La configuración de esta instalación, si existe: sobrevive a los reinicios
   sin obligar a exportar variables a mano cada vez. (datos/ no va al repo.) */
try { process.loadEnvFile(resolve(process.cwd(), "datos/entorno.env")); } catch { /* no hay, y está bien */ }

const app = express();
const PUERTO = Number(process.env.PORT || 8095);

/**
 * Las cabeceras que no cuestan nada y evitan clases enteras de problema.
 *
 * La CSP es estricta porque la interfaz es un solo archivo servido por
 * nosotros: no carga scripts de fuera, así que no hay que dejar la puerta
 * abierta «por si acaso». `unsafe-inline` sí hace falta —el JS y el CSS viven
 * dentro del HTML—, y quitarlo pide separarlos en archivos con su hash.
 */
app.use((_req, res, next) => {
  res.setHeader("content-security-policy",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");   // que la clave del enlace no viaje a terceros
  res.setHeader("x-frame-options", "DENY");
  next();
});

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

/* Meta acepta cualquier versión en la ruta y nosotros también: si mañana la
   plataforma sube a v22.0, el sandbox no debería ser el que se rompa. */
app.use(/^\/v\d+\.\d+/, graph);

/* La pantalla pregunta «¿quién soy con esta clave?» antes de enseñar nada. */
app.get("/panel/quien", (req, res) => {
  /* «¿quién soy?» es la primera parada del enlace de acceso, así que aquí sí
     se mira la dirección; el resto del panel, no. */
  const q = quienEs(req, { porLaUrl: true });
  if (!q) return res.status(401).json({ error: "Clave no válida." });
  /* A dónde avisar por defecto: lo pone quien opera esta instalación
     (SANDBOX_WEBHOOK_DEFECTO). Así el campo llega escrito y no hay que teclear
     la misma dirección en cada negocio. */
  res.json({ admin: q.admin, nombre: q.nombre, webhookDefecto: process.env.SANDBOX_WEBHOOK_DEFECTO || "" });
});
/* Autoservicio: cuentas propias del sandbox — registrarse y entrar. */
app.post("/panel/registrar", registrarse);
app.post("/panel/entrar", entrarConCuenta);
/* La gestión de negocios va ANTES que el panel: es solo-admin y el panel es solo-negocio. */
app.use("/panel/negocios", negocios);
/* El río de eventos: la pantalla se entera de lo que pasa sin preguntar.
   EventSource no sabe poner cabeceras, así que aquí la clave viaja en la query. */
app.get("/panel/eventos", (req, res) => {
  const q = quienEs(req, { porLaUrl: true });   // EventSource no pone cabeceras
  if (!q || q.admin) return res.status(401).end();
  conectarSSE(req, res, q.dueno);
});
/* Las caras de los clientes de mentira: fotos de archivo, iguales para todos,
   así que no hay nada que aislar. Van ANTES del panel, que exige clave. */
app.use("/caras", express.static(CARPETA_CARAS, { maxAge: "7d" }));
app.get("/panel/caras", (_req, res) => res.json(carasDisponibles()));
/* Las muestras de los encabezados de plantilla, sin token: hacen de la URL
   firmada de scontent.whatsapp.net que Meta devuelve al listar plantillas.
   El nombre es un azar de 24 bytes, igual de imposible de adivinar. */
app.get("/muestras/:token", servirMuestra);
/* WhatsApp por QR (Baileys): su propio mundo y sus propias reglas (ver qr.js). */
app.use("/qr", rutasQr());
app.use("/panel", panel);
app.use(express.static(resolve(process.cwd(), "public")));

app.get("/salud", (_req, res) => res.json({ ok: true, servicio: "wa-sandbox" }));

const servidor = app.listen(PUERTO, () => {
  claveAdmin();   // que exista desde el primer arranque
  console.log(`\n  wa-sandbox escuchando en http://localhost:${PUERTO}`);
  console.log(`  · clave de administración en datos/admin.clave`);
  console.log(`  · interfaz:  http://localhost:${PUERTO}`);
  console.log(`  · Graph API: http://localhost:${PUERTO}/v21.0`);
  console.log(`\n  Para que tu plataforma le hable, en vez de a Meta:`);
  console.log(`      META_GRAPH_URL=http://localhost:${PUERTO}\n`);
});
socketQr(servidor);
