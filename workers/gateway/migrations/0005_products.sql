-- MON1 F4 · El gateway pasa a servir a DOS apps (bookreader y arete). Sin saber de
-- cuál salió cada token, la medición que costó F1.2 se vuelve inútil en cuanto hay
-- una segunda fuente: "300 llamadas hoy" no dice cuál las gastó ni cuál conviene
-- dimensionar. `product` es esa procedencia, escrita en la emisión y verificada en
-- cada llamada (un token de arete no puede usar los alias de bookreader).
--
-- Default 'bookreader': los tokens ya emitidos son todos suyos, y los clientes ya
-- desplegados piden /demo-token sin decir producto.
ALTER TABLE tokens ADD COLUMN product TEXT NOT NULL DEFAULT 'bookreader';

-- demo_grants necesita el producto DENTRO de la clave: con la PK anterior
-- (ip_hash, day), probar la demo de bookreader dejaba sin demo la de arete el resto
-- del día en esa red. Son dos productos distintos y cada uno se prueba una vez.
-- SQLite no sabe añadir una columna a una PRIMARY KEY: se recrea la tabla.
CREATE TABLE demo_grants_new (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT 'bookreader',
  PRIMARY KEY (ip_hash, day, product)
);
INSERT INTO demo_grants_new (ip_hash, day, product) SELECT ip_hash, day, 'bookreader' FROM demo_grants;
DROP TABLE demo_grants;
ALTER TABLE demo_grants_new RENAME TO demo_grants;

-- El desglose por producto va aparte y NO sustituye a daily_stats: los disyuntores
-- globales (MAX_DAILY_TOKENS, MAX_DAILY_CALLS) acotan el gasto TOTAL, que es lo que
-- se paga, y deben seguir leyendo una sola fila por día. Esta tabla es para saber
-- quién consume qué. Mismos contadores agregados: retención cero intacta.
CREATE TABLE product_stats (
  day                TEXT NOT NULL,
  product            TEXT NOT NULL,
  tokens_issued      INTEGER NOT NULL DEFAULT 0,
  demo_calls         INTEGER NOT NULL DEFAULT 0,
  calls              INTEGER NOT NULL DEFAULT 0,
  est_input_tokens   INTEGER NOT NULL DEFAULT 0,
  measured_calls     INTEGER NOT NULL DEFAULT 0,
  est_input_measured INTEGER NOT NULL DEFAULT 0,
  real_input_tokens  INTEGER NOT NULL DEFAULT 0,
  real_output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, product)
);
