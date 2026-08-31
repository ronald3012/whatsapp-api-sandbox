/**
 * La gestión de negocios: el alta que pedía el salto a producción.
 *
 * Crear un negocio devuelve su clave UNA vez, para entregársela. Quien la
 * pierde no la recupera: se le gira una nueva y la vieja muere en el acto,
 * que es exactamente lo que uno quiere poder hacer cuando una clave se filtró.
 */
import { Router } from "express";
import { db } from "./db.js";
import { soloAdmin, nuevaClaveDeNegocio } from "./acceso.js";
import { nuevoId } from "./meta.js";

export const negocios = Router();
negocios.use(soloAdmin);

negocios.get("/", (_req, res) => {
  /* Columnas a mano, no `*`: la clave se enseña a propósito (hay que poder
     entregarla), pero el hash de la contraseña no pinta nada aquí y en un
     vuelco de esta respuesta se ataca sin conexión. */
  res.json(db.prepare(`SELECT id, nombre, clave, email, creado FROM duenos ORDER BY creado`).all().map((d) => ({
    ...d,
    cuentas: db.prepare(`SELECT count(*) c FROM cuentas WHERE dueno = ?`).get(d.id).c,
    mensajes: db.prepare(`SELECT count(*) c FROM mensajes WHERE dueno = ?`).get(d.id).c,
  })));
});

negocios.post("/", (req, res) => {
  const nombre = String(req.body?.nombre || "").trim();
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del negocio." });
  const d = { id: nuevoId(12), nombre, clave: nuevaClaveDeNegocio(), creado: Date.now() };
  db.prepare(`INSERT INTO duenos (id, nombre, clave, creado) VALUES (@id, @nombre, @clave, @creado)`).run(d);
  res.json(d);
});

negocios.post("/:id/clave", (req, res) => {
  const clave = nuevaClaveDeNegocio();
  const r = db.prepare(`UPDATE duenos SET clave = ? WHERE id = ?`).run(clave, req.params.id);
  if (!r.changes) return res.status(404).json({ error: "Ese negocio no existe." });
  res.json({ clave });
});

/** Borra el negocio Y todo lo suyo. Es la única puerta destructiva y es solo admin. */
negocios.delete("/:id", (req, res) => {
  const d = db.prepare(`SELECT * FROM duenos WHERE id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: "Ese negocio no existe." });
  const tx = db.transaction(() => {
    // cuentas arrastra numeros, y numeros arrastra contactos/mensajes/medios/reglas.
    db.prepare(`DELETE FROM cuentas WHERE dueno = ?`).run(d.id);
    db.prepare(`DELETE FROM entregas WHERE dueno = ?`).run(d.id);
    db.prepare(`DELETE FROM duenos WHERE id = ?`).run(d.id);
  });
  tx();
  res.json({ ok: true });
});
