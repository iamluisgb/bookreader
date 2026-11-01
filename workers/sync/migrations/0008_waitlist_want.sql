-- Lista de espera de Plus: qué quiere más quien se apunta (opcional, un clic en la landing):
-- 'claude' | 'sync' | 'ai', o NULL. Es la señal de demanda para decidir qué se lanza primero.
ALTER TABLE waitlist ADD COLUMN want TEXT;
