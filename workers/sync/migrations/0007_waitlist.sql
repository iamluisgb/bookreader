-- Lista de espera de Plus (ADR-061): quien pide en la landing que le avisemos cuando salga.
-- Solo el email, el idioma de la página y cuándo. Sirve para un único aviso de lanzamiento;
-- se borra a petición. Exportar: npx wrangler d1 execute bookreader-sync --remote
--   --command "SELECT email, lang, created_at FROM waitlist ORDER BY created_at"
CREATE TABLE waitlist (
  email      TEXT PRIMARY KEY,
  lang       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
