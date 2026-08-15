-- MON1 F5 · El cliente enseña el consumo de la demo en PORCENTAJE, y un porcentaje
-- necesita saber el total. No puede salir de `DEMO_QUOTA` en el momento de leerlo:
-- subir la cuota mañana haría que a los tokens vivos les creciera el denominador y su
-- barra saltara hacia atrás. El total es el que tenía el token AL EMITIRSE.
--
-- 30 por defecto: es la cuota con la que se emitieron todos los tokens hasta hoy.
ALTER TABLE tokens ADD COLUMN quota INTEGER NOT NULL DEFAULT 30;
