-- P24 F4 · Control de lo que hay en R2 y de lo que se gasta (ADR-053).
--
-- R2 cobra por almacenamiento (GB-mes) y por operaciones (clase A: escribir/listar; clase
-- B: leer). No hay una forma barata de preguntarle cuánto llevamos, así que se lleva aquí:
-- cada enlace con su tamaño (el almacenamiento vivo es SUM(size)) y un contador mensual de
-- operaciones. El Worker reserva ANTES de tocar R2 y se niega al llegar al tope.

CREATE TABLE shares (
  id          TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  del_hash    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX shares_expires ON shares (expires_at);

-- Un fila por mes natural (UTC, «2026-10»). R2 factura por mes de calendario.
CREATE TABLE usage (
  month    TEXT PRIMARY KEY,
  class_a  INTEGER NOT NULL DEFAULT 0,
  class_b  INTEGER NOT NULL DEFAULT 0,
  refused  INTEGER NOT NULL DEFAULT 0
);
