-- Cuántas veces se ha abierto (descargado) cada enlace: lo ve quien lo creó, con su token.
-- Solo un número: ni quién, ni desde dónde, ni cuándo.
ALTER TABLE shares ADD COLUMN opens INTEGER NOT NULL DEFAULT 0;
