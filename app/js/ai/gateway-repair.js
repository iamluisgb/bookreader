// gateway-repair.js — Repara un estado imposible de la configuración del agente.
//
// Un token `br-…` es del gateway de la demo y solo vale ahí, así que verlo junto a otra
// base URL significa que Ajustes lo movió de sitio (lo hacía "Guardar" en la vista simple
// con la demo activa). El síntoma era 401 en todo, con el usuario convencido de que la key
// de la demo nacía rota. Se restaura la demo en vez de dejarla inservible; quien pegue su
// propia key lo pisa igual que siempre.
//
// Vive FUERA de llm.js porque tiene que correr AL ARRANCAR (tests/demo-settings.spec.ts) y
// llm.js ya no está en el grafo de arranque: se carga con el panel del agente, que va
// perezoso. Quien está roto no puede arreglarlo desde la UI —no ve el token que habría que
// borrar—, así que esperar a que abra el panel no vale. Aquí solo se tocan tres claves de
// localStorage: es barato de sobra para el arranque.
import * as Storage from '../storage.js';

export const GATEWAY_BASE_URL = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';

export function isGatewayUrl(u) {
  return (u || '').trim().replace(/\/+$/, '') === GATEWAY_BASE_URL;
}

// Idempotente: si no hay nada que reparar no escribe nada.
export function repairGatewayConfig() {
  const key = (Storage.get('ai_key', '') || '').trim();
  const baseUrl = (Storage.get('ai_base_url', '') || '').trim().replace(/\/+$/, '');
  if (!/^br-/i.test(key) || isGatewayUrl(baseUrl)) return false;
  Storage.set('ai_base_url', GATEWAY_BASE_URL);
  Storage.set('ai_model', 'bookreader-fast');
  Storage.set('ai_vision_model', '');
  return true;
}
