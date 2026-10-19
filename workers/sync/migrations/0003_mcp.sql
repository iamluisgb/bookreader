-- MCP remoto (MON4): los tokens con los que un agente lee la biblioteca del usuario.
--
-- `wrapped` es la clave del sync y la licencia, cifradas con una clave que se deriva del PROPIO
-- token (HKDF). El servidor guarda solo el hash del token: sin el token, lo de esta tabla no se
-- puede descifrar. Con él, solo mientras dura cada petición del agente.
CREATE TABLE mcp_tokens (
  id            TEXT PRIMARY KEY,
  user          TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'pat',   -- 'pat' (creado en la app) | 'oauth'
  wrapped       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  checked_at    INTEGER NOT NULL              -- última vez que se validó la licencia
);
CREATE INDEX mcp_tokens_user ON mcp_tokens (user);
