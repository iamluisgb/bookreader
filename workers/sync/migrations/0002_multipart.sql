-- MON4 F4 · Subida por partes de los libros de más de 100 MB (el tope de cuerpo de Workers).
-- La reserva de cuota se hace al empezar, con el tamaño total declarado; aquí se cuenta lo que
-- de verdad llega, para que nadie suba más de lo reservado.
ALTER TABLE blobs ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
