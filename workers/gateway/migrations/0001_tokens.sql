-- MON1 F1 · Tokens del gateway. `license_key` va desde el día uno aunque quede
-- vacío (enlace con MON2: emisión de tokens Pro al validar la licencia) para no
-- migrar después. `tier` decide la fila de routing (demo → modelo barato).
CREATE TABLE tokens (
  token       TEXT PRIMARY KEY,
  remaining   INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  tier        TEXT NOT NULL DEFAULT 'demo',
  license_key TEXT,
  note        TEXT,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);
