-- Añadir un dispositivo (docs/PROPUESTA_EMPAREJAR_DISPOSITIVOS.md, F2 y F3).
--
-- pair_codes: el relevo del emparejamiento `#pair2=`. El dispositivo de origen sube aquí, cifrado
-- con un secreto que solo viaja en el fragmento del enlace (el servidor no lo ve), la licencia y la
-- clave del sync. El nuevo dispositivo lo reclama UNA vez y antes de `expires_at` (10 min); al
-- reclamarlo se borra el blob y queda solo quién lo usó, para que el origen pueda decir
-- «Emparejado: {dispositivo}».
CREATE TABLE IF NOT EXISTS pair_codes (
  id          TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  blob        TEXT,                   -- NULL en cuanto se reclama
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  claimed_at  INTEGER,
  claimed_by  TEXT                    -- etiqueta del dispositivo («Chrome en Windows»)
);
CREATE INDEX IF NOT EXISTS pair_codes_user ON pair_codes (user, expires_at);
CREATE INDEX IF NOT EXISTS pair_codes_expires ON pair_codes (expires_at);

-- F3 · POST /v1/key-owner: ¿la ruta del fichero de control de una clave existe en el espacio de
-- OTRO usuario? (la clave es de un sync abierto con otra licencia). Busca por `path` sin `user`.
CREATE INDEX IF NOT EXISTS objects_path ON objects (path);

-- Empezar de cero sin la clave (DELETE /v1/all sin prueba): no se borra al momento, se apunta y
-- la purga diaria lo ejecuta pasados WIPE_DELAY_DAYS, salvo que un dispositivo con la clave lo
-- cancele. Con la licencia sola ya no se puede vaciar el sync de golpe.
ALTER TABLE users ADD COLUMN wipe_at INTEGER;
