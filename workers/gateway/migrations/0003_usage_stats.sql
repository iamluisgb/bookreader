-- MON1 F1.2 · Medición de coste. Sin esto, DEMO_QUOTA y MAX_DAILY_CALLS son
-- números inventados: el gateway contaba llamadas pero no sabía lo que cuesta una
-- (BACKLOG MON1, pregunta abierta: "medir el coste por llamada real en nan para
-- dimensionar la demo sin sustos").
--
-- Retención cero intacta: son CONTADORES AGREGADOS POR DÍA, nunca contenido ni
-- nada ligado a un usuario.
--
-- Dos familias de columnas a propósito:
--   est_*  — nuestra estimación (~4 chars/token), disponible en TODAS las llamadas.
--   real_* — el `usage` que devuelve el proveedor; solo llega en las llamadas
--            NO streaming (las de tools y visión), porque el stream se reenvía sin
--            parsear. Con `measured_calls` se calibra la estimación contra la
--            realidad y se extrapola al total.
ALTER TABLE daily_stats ADD COLUMN calls             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN est_input_tokens  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN measured_calls    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN real_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN real_output_tokens INTEGER NOT NULL DEFAULT 0;
