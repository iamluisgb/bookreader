-- Permisos de cada token de agente (MCP): 'read' siempre; 'write' (cambiar tarjetas, mazos y
-- artefactos) y 'text' (leer el texto de los libros) solo si el usuario los marcó al crearlo.
-- Los tokens que ya existían se quedan como estaban: solo lectura.
ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'read';
