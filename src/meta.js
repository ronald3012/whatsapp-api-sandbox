/**
 * Las formas exactas del API de Meta.
 *
 * Todo lo que aquí se genera tiene que ser indistinguible de lo real, porque el
 * objetivo del sandbox es que la plataforma NO se entere. Si un id no tiene la
 * pinta correcta o falta un campo del sobre, lo que se ensaya no es el código
 * de producción sino una variante suya, y las pruebas mienten.
 */
import { createHmac, randomBytes, createHash } from "node:crypto";

/**
 * Un wamid de verdad es `wamid.` + base64 de un blob binario. La plataforma lo
 * guarda como llave y lo cruza con los acuses, así que solo importa que sea
 * único, estable y con el mismo prefijo y alfabeto.
 */
export const nuevoWamid = () =>
  "wamid." + randomBytes(24).toString("base64").replace(/=+$/, "");

/**
 * Los ids de Meta son numéricos y largos.
 *
 * Con azar criptográfico, no con `Math.random()`. Hoy estos ids no son
 * secretos —el acceso se comprueba aparte, con la clave y el token—, pero un id
 * adivinable es el tipo de cosa que se vuelve el fallo el día que alguien lo
 * usa como si fuera una credencial.
 */
export const nuevoId = (largo = 15) => {
  const d = randomBytes(largo);
  let s = "1";
  for (let i = 1; i < largo; i++) s += d[i] % 10;
  return s;
};

/** Un BSUID: `CC.` + alfanumérico. Así llega quien escribe solo con usuario. */
export const nuevoUserId = (pais = "12") =>
  `${pais}.${randomBytes(12).toString("base64url")}`;

/**
 * El número como lo devuelve Meta: `+1 829-631-5392`, no `18295551234`.
 *
 * `display_phone_number` es literalmente eso —lo que se ENSEÑA—, y Meta lo manda
 * ya con su formato. Guardándolo en crudo, un panel acaba mezclando dos
 * formatos en la misma lista y el del sandbox se delataba a la legua.
 */
export function comoLoEnsenaMeta(crudo) {
  const d = String(crudo || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `+1 ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d ? `+${d}` : "";
}

export const ahora = () => Math.floor(Date.now() / 1000);
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * La firma que Meta pone en cada webhook. La plataforma la verifica contra el
 * cuerpo CRUDO; si se firma el objeto ya re-serializado, un espacio de más
 * cambia el hash y el webhook se rechaza sin decir por qué.
 */
export const firmar = (crudo, appSecret) =>
  "sha256=" + createHmac("sha256", appSecret).update(crudo).digest("hex");

/**
 * El error tal como lo devuelve Meta. La plataforma lee `error.code` y
 * `error.error_data.details` para decidir qué enseñarle al vendedor, así que
 * la forma importa tanto como el código.
 */
export function errorMeta(code, message, { subcode, details, status = 400 } = {}) {
  return {
    status,
    cuerpo: {
      error: {
        message,
        type: "OAuthException",
        code,
        ...(subcode ? { error_subcode: subcode } : {}),
        ...(details ? { error_data: { messaging_product: "whatsapp", details } } : {}),
        fbtrace_id: randomBytes(12).toString("base64url"),
      },
    },
  };
}

/** Catálogo de los errores que de verdad nos han mordido. */
export const ERRORES = {
  131051: {
    message: "Unsupported message type",
    details: "Message type is not currently supported.",
  },
  131047: {
    message: "Re-engagement message",
    details:
      "More than 24 hours have passed since the recipient last replied to the sender number.",
  },
  131009: {
    message: "Parameter value is not valid",
    details: "Invalid parameter: the recipient phone number must include the country code, digits only.",
  },
  131026: {
    message: "Message undeliverable",
    details: "Unable to deliver message. Reasons can include: the recipient phone number is not a WhatsApp phone number.",
  },
  131060: {
    message: "Message deleted",
    details: "The message was deleted by the sender before it was delivered.",
  },
  132000: {
    message: "Template param count mismatch",
    details: "Number of parameters does not match the expected number of params.",
  },
  132001: {
    message: "Template does not exist",
    details: "template name does not exist in the translation",
  },
};

/**
 * El sobre de un mensaje ENTRANTE, tal como lo manda Meta.
 *
 * `contacts` y `messages` van juntos y el `wa_id` se repite en los dos sitios.
 * Cuando quien escribe oculta su número (username/BSUID), NO viene `wa_id`:
 * viene `user_id`. Ese caso se puede pedir aquí a propósito, que es justo lo
 * que no se puede provocar contra Meta de verdad.
 */
export function sobreEntrante({ waba, numero, contacto, mensaje }) {
  const ocultoTrasUsuario = !!contacto.user_id && !contacto.wa_id;
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: numero.display_phone_number,
                phone_number_id: numero.id,
              },
              contacts: [
                {
                  profile: { name: contacto.nombre },
                  ...(ocultoTrasUsuario
                    ? { user_id: contacto.user_id, username: contacto.username }
                    : { wa_id: contacto.wa_id }),
                },
              ],
              messages: [mensaje],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

/** El sobre de un ACUSE (enviado / entregado / leído / fallido). */
export function sobreEstado({ waba, numero, estado }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: numero.display_phone_number,
                phone_number_id: numero.id,
              },
              statuses: [estado],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}
