-- MON4 F1 · Sync de BookReader: índice de lo que hay en R2, por usuario (ADR-056).
--
-- R2 no se lista nunca (listar es clase A) y no da barata la cuenta de lo que ocupa. Todo
-- eso sale de aquí: qué ficheros tiene cada usuario, cuánto ocupa, sus versiones y lo que
-- se ha gastado en el mes.

-- Un usuario = una licencia. El id es el hash de la license key: el servidor no guarda la key.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  -- Primera vez que la licencia dejó de valer (NULL = activa). Desde aquí corren los días de
  -- solo lectura; al pasar GRACE_DAYS, la purga borra todo.
  lapsed_at   INTEGER
);

-- Tokens de sesión `br-sync-…`. Se guarda su hash, no el token.
CREATE TABLE tokens (
  hash        TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  read_only   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tokens_expires ON tokens (expires_at);

-- El puntero: qué clave de R2 es la versión actual de cada ruta. `path` es el hash de la ruta
-- con la clave del usuario y `name` la ruta cifrada: el servidor no ve ni títulos ni ids.
CREATE TABLE objects (
  user        TEXT NOT NULL,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- 'data' (notas, ajustes…) | 'file' (fichero de libro)
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user, path)
);

-- Cada clave de R2 que existe (o está a punto de existir): es lo que cuenta para las cuotas.
-- Las escrituras no sobrescriben: van a una clave nueva y luego se mueve el puntero.
CREATE TABLE blobs (
  key         TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL,          -- 'pending' (reservado) | 'live' | 'version'
  upload_id   TEXT,                   -- subida por partes en curso (F4)
  created_at  INTEGER NOT NULL
);
CREATE INDEX blobs_user ON blobs (user, kind);
CREATE INDEX blobs_path ON blobs (user, path, state, created_at);
CREATE INDEX blobs_state ON blobs (state, created_at);

-- Una fila por mes natural (UTC, «2026-10»): R2 factura por mes de calendario.
CREATE TABLE usage (
  month    TEXT PRIMARY KEY,
  class_a  INTEGER NOT NULL DEFAULT 0,
  class_b  INTEGER NOT NULL DEFAULT 0,
  refused  INTEGER NOT NULL DEFAULT 0
);
