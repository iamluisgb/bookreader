-- Cambios que un agente (MCP) hace en la biblioteca, para poder DESHACERLOS desde la app.
-- `undo` son los valores anteriores de lo que tocó (solo esos libros y estanterías), cifrados
-- con la clave del sync del usuario: el servidor no los puede leer. `summary` son contadores
-- (cuántos libros, cuántas estanterías), sin títulos ni nombres.
CREATE TABLE mcp_changes (
  id          TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  token_id    TEXT,
  agent       TEXT NOT NULL,
  target      TEXT NOT NULL,          -- 'library'
  summary     TEXT NOT NULL,
  undo        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  undone_at   INTEGER
);
CREATE INDEX mcp_changes_user ON mcp_changes (user, created_at);
