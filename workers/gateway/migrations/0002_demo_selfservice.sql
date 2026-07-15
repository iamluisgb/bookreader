-- MON1 F3 · Demo self-service. `demo_grants` limita a 1 demo por IP (hasheada
-- con salt secreto: no se almacenan IPs crudas) y día. `daily_stats` alimenta
-- los DISYUNTORES globales: tope de tokens emitidos/día y de llamadas demo/día
-- — el gasto máximo diario queda acotado por config aunque haya abuso.
CREATE TABLE demo_grants (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  PRIMARY KEY (ip_hash, day)
);

CREATE TABLE daily_stats (
  day           TEXT PRIMARY KEY,
  tokens_issued INTEGER NOT NULL DEFAULT 0,
  demo_calls    INTEGER NOT NULL DEFAULT 0
);
