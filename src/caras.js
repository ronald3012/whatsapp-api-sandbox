/**
 * Caras para los clientes de mentira: SOLO las que tú pongas.
 *
 * Se probó bajarlas de un banco de fotos de datos de prueba y se descartó: las
 * de `randomuser.me` salen de la tanda vieja de UI Faces —personas reales,
 * fotos de origen y licencia mezclados— y su propia página dice que son para
 * maquetas, «not recommended for use in public, live projects». Esto va a ser
 * un producto público, así que no.
 *
 * Lo que queda: si dejas fotos tuyas (o de licencia clara) en esta carpeta, se
 * usan; si no, la interfaz dibuja sus propios retratos, que no son de nadie y
 * no dependen de la licencia de nadie.
 *
 *     datos/caras/women-01.jpg   → se le asignan a nombres femeninos
 *     datos/caras/men-01.jpg     → a los demás
 *     datos/caras/loquesea.jpg   → a cualquiera
 */
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const CARPETA = process.env.SANDBOX_CARAS || resolve(process.cwd(), "datos/caras");

export function carasDisponibles() {
  try {
    mkdirSync(CARPETA, { recursive: true });
    return readdirSync(CARPETA).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  } catch {
    return [];
  }
}

export const CARPETA_CARAS = CARPETA;
