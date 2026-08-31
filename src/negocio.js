/**
 * Crear un negocio de ensayo con su número.
 *
 * Vive aparte porque lo hacen dos caminos: el registro (que crea el primero con
 * el nombre que la persona acaba de dar — preguntárselo otra vez sería tonto) y
 * el panel, cuando ya dentro quiere otro.
 *
 * El número NO se pregunta: en el sandbox es de mentira y en Meta tampoco lo
 * eliges tú, te lo dan. Un campo que hay que llenar para nada es un campo de más.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { nuevoId, comoLoEnsenaMeta } from "./meta.js";

/** Un número dominicano plausible, distinto en cada negocio. */
const numeroInventado = () =>
  "1809" + String(Math.floor(1000000 + Math.random() * 8999999));

export function crearNegocio({ dueno, nombre, telefono, webhook_url }) {
  const cuenta = {
    id: nuevoId(15),
    dueno,
    nombre,
    app_secret: randomBytes(16).toString("hex"),
    verify_token: randomBytes(8).toString("hex"),
    webhook_url: webhook_url || null,
    token: "sandbox_" + randomBytes(24).toString("base64url"),
    creada: Date.now(),
  };
  db.prepare(
    `INSERT INTO cuentas (id, dueno, nombre, app_secret, verify_token, webhook_url, token, creada)
     VALUES (@id, @dueno, @nombre, @app_secret, @verify_token, @webhook_url, @token, @creada)`,
  ).run(cuenta);

  const numero = {
    id: nuevoId(15),
    cuenta_id: cuenta.id,
    dueno,
    display_phone_number: comoLoEnsenaMeta(telefono || numeroInventado()),
    verified_name: nombre,
    creado: Date.now(),
  };
  db.prepare(
    `INSERT INTO numeros (id, cuenta_id, dueno, display_phone_number, verified_name, creado)
     VALUES (@id, @cuenta_id, @dueno, @display_phone_number, @verified_name, @creado)`,
  ).run(numero);

  return { cuenta, numero };
}
