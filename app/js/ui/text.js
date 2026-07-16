// Utilidades de normalización de texto seleccionado. El text-layer de un PDF conserva
// los guiones de corte de línea ("prob-\nlem"): al seleccionar a través del salto, la
// selección queda como "prob- lem" y ese guión se propaga al subrayado y a la tarjeta-
// cita. Misma heurística que la reconstrucción del agente (ver ai/segment-pdf.js):
// letra + "-" + espacio(s)/salto + minúscula ⇒ se unen sin guión ni espacio. Un guión
// legítimo dentro de palabra ("self-aware") no lleva espacio detrás, así que no se toca.
export function dehyphenate(text) {
  if (!text) return text;
  return text.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2');
}
