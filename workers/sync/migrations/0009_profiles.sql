-- Perfiles públicos alojados (MON7): uno por usuario, con su nombre (handle) único.
-- `objects` es la lista JSON de claves de R2 del perfil (perfil.json, portadas, now.svg), para
-- borrar lo que sobra al volver a publicar y todo al retirarlo, sin listar R2 (clase A).
CREATE TABLE IF NOT EXISTS profiles (
  handle     TEXT PRIMARY KEY,
  user       TEXT NOT NULL UNIQUE,
  objects    TEXT NOT NULL DEFAULT '[]',
  bytes      INTEGER NOT NULL DEFAULT 0,
  books      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
