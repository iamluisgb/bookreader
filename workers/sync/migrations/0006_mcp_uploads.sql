-- Subidas de libros por MCP (create_book_upload): el agente pide una URL de un solo uso y sube
-- el fichero con un PUT, sin que los bytes pasen por el modelo. `wrapped` lleva la clave del
-- sync y lo declarado (hash, tamaño, formato, título), cifrado con el secreto de la URL, y del
-- secreto solo se guarda el hash: sin la URL no se puede leer ni usar. Nada de títulos ni
-- hashes de libro en claro.
CREATE TABLE mcp_uploads (
  id           TEXT PRIMARY KEY,
  user         TEXT NOT NULL,
  token_id     TEXT,
  agent        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  wrapped      TEXT NOT NULL,
  size         INTEGER NOT NULL,
  state        TEXT NOT NULL,          -- 'created' | 'uploading' | 'done' | 'failed'
  error        TEXT,
  change_id    TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX mcp_uploads_user ON mcp_uploads (user, created_at);
