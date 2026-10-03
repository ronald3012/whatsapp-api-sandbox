/**
 * El estado del sandbox. SQLite en un archivo: se borra y vuelves a empezar.
 *
 * Todo cuelga de un `dueno`. Hoy el sandbox es interno y siempre será el mismo,
 * pero la idea es exponerlo algún día para que cada cliente ensaye sus agentes
 * antes de conectar su WhatsApp de verdad. Separar los datos cuando ya hay
 * datos es una migración; separarlos ahora es una columna.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const RUTA = process.env.SANDBOX_DB || resolve(process.cwd(), "datos/sandbox.db");
mkdirSync(dirname(RUTA), { recursive: true });

export const db = new Database(RUTA);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS cuentas (
  -- Una cuenta de negocio: lo que en Meta sería una WABA con sus números.
  id            TEXT PRIMARY KEY,          -- waba_id
  dueno         TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  -- Con este secreto se firma el X-Hub-Signature-256, igual que el app secret
  -- de Meta. La plataforma verifica esa firma: sin esto, rechaza el webhook.
  app_secret    TEXT NOT NULL,
  verify_token  TEXT NOT NULL,
  webhook_url   TEXT,                      -- a dónde se entregan los eventos
  token         TEXT NOT NULL,             -- el access_token que espera el Bearer
  creada        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS numeros (
  -- Un número de teléfono del negocio: el phone_number_id de Meta.
  id                   TEXT PRIMARY KEY,   -- phone_number_id
  cuenta_id            TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  dueno                TEXT NOT NULL,
  display_phone_number TEXT NOT NULL,
  verified_name        TEXT NOT NULL,
  quality_rating       TEXT NOT NULL DEFAULT 'GREEN',
  registrado           INTEGER NOT NULL DEFAULT 0,
  creado               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contactos (
  -- La gente falsa que le escribe al negocio. Su "teléfono" es el wa_id.
  wa_id      TEXT NOT NULL,
  numero_id  TEXT NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
  dueno      TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  -- WhatsApp 2026: se puede escribir con nombre de usuario y sin enseñar el
  -- número. Cuando pasa, el sobre llega con user_id y SIN wa_id. Se guarda
  -- para poder ensayar ese caso, que ya nos mordió una vez.
  user_id    TEXT,
  username   TEXT,
  creado     INTEGER NOT NULL,
  PRIMARY KEY (wa_id, numero_id)
);

CREATE TABLE IF NOT EXISTS mensajes (
  id          TEXT PRIMARY KEY,            -- wamid
  numero_id   TEXT NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
  dueno       TEXT NOT NULL,
  wa_id       TEXT NOT NULL,               -- con quién es la conversación
  direccion   TEXT NOT NULL,               -- 'entrante' | 'saliente'
  tipo        TEXT NOT NULL,
  cuerpo      TEXT,                        -- el JSON del contenido, tal cual
  texto       TEXT,                        -- copia plana, para la interfaz
  estado      TEXT,                        -- sent | delivered | read | failed
  error_code  INTEGER,
  responde_a  TEXT,                        -- context.message_id
  cuando      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mensajes_conv ON mensajes (numero_id, wa_id, cuando);

CREATE TABLE IF NOT EXISTS medios (
  id         TEXT PRIMARY KEY,             -- media_id
  numero_id  TEXT NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
  dueno      TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  file_size  INTEGER NOT NULL,
  ruta       TEXT NOT NULL,                -- dónde quedó el archivo
  nombre     TEXT,
  creado     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plantillas (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  dueno       TEXT NOT NULL,
  nombre      TEXT NOT NULL,
  idioma      TEXT NOT NULL,
  categoria   TEXT NOT NULL,
  -- Meta tarda y a veces rechaza. Aquí lo decides tú desde la interfaz, que es
  -- justamente lo que no se puede ensayar contra Meta de verdad.
  estado      TEXT NOT NULL DEFAULT 'PENDING',  -- APPROVED | REJECTED | PENDING
  componentes TEXT NOT NULL,
  creada      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entregas (
  -- Cada webhook que sale, con su resultado. Para poder mirar por qué algo no
  -- llegó sin adivinar: es la mitad del valor de tener un sandbox.
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dueno     TEXT NOT NULL,
  numero_id TEXT,
  url       TEXT NOT NULL,
  cuerpo    TEXT NOT NULL,
  estado    INTEGER,                       -- código HTTP, o null si ni salió
  respuesta TEXT,
  error     TEXT,
  cuando    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reglas (
  -- «Que el próximo envío a este número falle con 131051.» Sin esto, los
  -- errores de Meta solo se ven en producción y con un cliente delante.
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dueno     TEXT NOT NULL,
  numero_id TEXT NOT NULL REFERENCES numeros(id) ON DELETE CASCADE,
  wa_id     TEXT,                          -- null = vale para todos
  clase     TEXT NOT NULL,                 -- 'error_envio' | 'sin_entrega' | 'ventana_24h'
  codigo    INTEGER,
  veces     INTEGER NOT NULL DEFAULT 1,    -- cuántas veces se aplica; -1 = siempre
  creada    INTEGER NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS productos (
  -- El catálogo del negocio. Existe por una razón concreta: cuando un cliente
  -- arma un carrito en WhatsApp, el pedido llega con puros
  -- \`product_retailer_id\` y sin nombres. Si el agente no puede cruzarlos,
  -- termina negándole al cliente lo que el cliente acaba de pedir.
  retailer_id TEXT NOT NULL,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  dueno       TEXT NOT NULL,
  nombre      TEXT NOT NULL,
  descripcion TEXT,
  precio      REAL,
  moneda      TEXT NOT NULL DEFAULT 'DOP',
  creado      INTEGER NOT NULL,
  PRIMARY KEY (retailer_id, cuenta_id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS duenos (
  -- Un negocio del sandbox: el que entra con SU cuenta y ve SOLO lo suyo.
  -- Es la llave del aislamiento: todas las tablas cuelgan de este id.
  -- El sandbox es un producto independiente — clon de WhatsApp que puede
  -- servirle a cualquier proyecto — así que las cuentas son SUYAS: nada de
  -- validar contra otra plataforma.
  id        TEXT PRIMARY KEY,
  nombre    TEXT NOT NULL,
  clave     TEXT NOT NULL UNIQUE,        -- la credencial interna de la sesión
  email     TEXT UNIQUE,                 -- con lo que entra quien se registró solo
  pass_hash TEXT,                        -- scrypt salt:hash; null si lo creó el admin
  creado    INTEGER NOT NULL
);
`);

/* La foto del contacto llegó después de crear la tabla: se añade si falta.
   SQLite no tiene ADD COLUMN IF NOT EXISTS, así que se intenta y ya. */
try { db.exec(`ALTER TABLE contactos ADD COLUMN foto TEXT`); } catch { /* ya estaba */ }
/* Las cuentas propias llegaron después de las claves: se añaden si faltan. */
try { db.exec(`ALTER TABLE duenos ADD COLUMN email TEXT`); } catch { /* ya estaba */ }
try { db.exec(`ALTER TABLE duenos ADD COLUMN pass_hash TEXT`); } catch { /* ya estaba */ }
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_duenos_email ON duenos (email)`); } catch { /* base a medio migrar */ }


/* Lo que ya existía era todo del dueño «local». Al estrenar las claves, ese
   dueño se vuelve un negocio más — con la suya — para no dejar huérfano ni un
   mensaje ni regalar acceso sin credencial. */
import { randomBytes } from "node:crypto";
if (!db.prepare(`SELECT 1 FROM duenos WHERE id = 'local'`).get() &&
    db.prepare(`SELECT 1 FROM cuentas WHERE dueno = 'local'`).get()) {
  db.prepare(`INSERT INTO duenos (id, nombre, clave, creado) VALUES (?, ?, ?, ?)`)
    .run("local", "Pruebas locales", "sb_" + randomBytes(24).toString("base64url"), Date.now());
}

/**
 * La app de Meta de cada cuenta y las subidas reanudables.
 *
 * Una plantilla con encabezado de imagen, video o documento no se crea con un
 * enlace: Meta pide antes subir una muestra por la «Resumable Upload API»
 * (`POST /{app-id}/uploads` → `POST /upload:{sesión}`), que cuelga de la APP y
 * no del número ni de la cuenta de negocio. Por eso cada cuenta tiene aquí su
 * `app_id`: si la plataforma usa otro, la subida falla igual que en Meta.
 *
 * `handle` es lo que Meta devuelve al terminar (`{"h": "4::..."}`) y lo que
 * va en `example.header_handle` de la plantilla. `token_publico` hace de la URL
 * firmada de scontent.whatsapp.net con la que Meta devuelve la muestra al
 * listar las plantillas.
 */
try { db.exec(`ALTER TABLE cuentas ADD COLUMN app_id TEXT`); } catch { /* ya estaba */ }
db.exec(`
CREATE TABLE IF NOT EXISTS subidas (
  id            TEXT PRIMARY KEY,          -- lo que va detrás de «upload:»
  dueno         TEXT NOT NULL,
  cuenta_id     TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL,
  nombre        TEXT,
  largo         INTEGER NOT NULL,          -- file_length declarado
  tipo          TEXT NOT NULL,             -- file_type declarado
  recibido      INTEGER NOT NULL DEFAULT 0,
  ruta          TEXT NOT NULL,
  handle        TEXT UNIQUE,               -- null hasta que llega el último byte
  token_publico TEXT UNIQUE,
  creada        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ediciones_plantilla (
  -- Meta deja editar una aprobada 1 vez cada 24 h y 10 en 30 días.
  plantilla_id TEXT NOT NULL REFERENCES plantillas(id) ON DELETE CASCADE,
  cuando       INTEGER NOT NULL
);
`);
