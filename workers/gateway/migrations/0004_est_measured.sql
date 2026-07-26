-- MON1 F1.2 (corrección) · Calibrar exige comparar lo mismo contra lo mismo.
--
-- `est_input_tokens` acumula TODAS las llamadas, pero `real_input_tokens` solo las
-- no-streaming (las únicas que traen `usage`). Dividir una entre otra no mide el
-- error de la estimación: mide qué proporción del tráfico fue streaming. Con una
-- llamada grande en streaming y una pequeña medida, el "factor" salía en 3892.
--
-- Esta columna acumula la estimación SOLO de las llamadas medidas, que es el
-- término comparable con `real_input_tokens`.
ALTER TABLE daily_stats ADD COLUMN est_input_measured INTEGER NOT NULL DEFAULT 0;
