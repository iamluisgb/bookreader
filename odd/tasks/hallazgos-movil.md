# Hallazgos del testeo móvil (emulador Android)

Origen: sesión de testeo en emulador `pixel7a_android16` (headless, CDP) sobre producción, que
destapó el bug de citas PDF (`e463272`, ya arreglado y desplegado). Quedaron cuatro hallazgos
menores; el usuario pidió implementarlos todos.

## Alcance

| # | Hallazgo | Impacto | Vía |
|---|----------|---------|-----|
| P1 | `https://bookreader-2h5.pages.dev` falta en `ALLOWED_ORIGINS` del gateway | En el deploy de Pages el botón demo **nunca** funciona y el medidor de cupo queda muerto (CORS bloqueado → «Failed to fetch») | `workers/gateway/wrangler.jsonc` + test de config |
| P2 | «Language · Language» duplicado en Ajustes → App | Cosmético, visible | `app/js/ui/app-settings.js` |
| P3 | Chips de cita desaparecidos al restaurar una conversación | El usuario no puede saltar a la cita desde respuestas viejas | `app/js/ai/panel.js` |
| P4 | La demo falla con «Failed to fetch» en vez del motivo real | UX: error opaco | `app/js/ai/llm.js` |

## No-objetivos

- No se toca el esquema de mensajes ni el sync (la causa de P3 no es persistencia).
- No se usa `*` en CORS.
- No se toca el pipeline de generación (EV5 intacto).

## P3 · Causa raíz (medida en código, no supuesta)

`activateConvo()` (panel.js:810) hace `await restoreChat()` **antes** de que `prepareBook()`
(panel.js:726, llamada en 665) segmente el libro y llene `anchors`. `restoreChat()` →
`renderWithCitations(text, anchors)` → `citeReplace()` exige `anchors.has(id)`: con el mapa
vacío, los `[[aN]]` se descartan y no queda chip. Es determinista, no una carrera.

**Fix elegido**: guardar el markdown crudo de cada respuesta en su burbuja y **repintar** las
citas cuando la segmentación termina (los `anchors` ya están disponibles). Sin campo nuevo
persistido, sin migración, sin riesgo de sync. `navigateCite()` ya reconstruye el índice a
demanda (`ensureIndex()`) para el resaltado.

## Tareas

1. **T1 · P2 — etiqueta de idioma.** `${t('Idioma')} · Language` → condicional por idioma.
2. **T2 · P1 — origen de Pages en el gateway.** Agregar el origen a `ALLOWED_ORIGINS` y un test
   que lea `wrangler.jsonc` y fije: los orígenes de producción presentes, ninguno `*`, ninguno
   con slash final (el match es por igualdad exacta de string).
3. **T3 · P4 — error honesto de la demo.** Envolver el `fetch` de `requestDemoToken()`: un fallo
   de red (TypeError) se reporta como problema de conexión, no como «Failed to fetch».
4. **T4 · P3 — repintar citas al terminar la segmentación.** `appendBubble` recuerda el texto
   crudo; `repaintCites()` re-renderiza las burbujas de asistente cuando `anchors` ya está
   poblado; llamado desde `prepareBook()`.
5. **T5 · Verificación.** e2e nuevo de restauración (T4) + suite completa + lint.

## Evidencia

| Tarea | Commit | Verificación |
|-------|--------|--------------|
| T1 · etiqueta de idioma | `2b60d96` | `tests/settings-lang-label.spec.ts` 2/2 (verifica «Language» en EN y «Idioma · Language» en ES) |
| T2 · origen de Pages | `4aa3755` | `npm run test:gateway` 52/52; en producción, `Origin: bookreader-2h5.pages.dev` → 200 + ACAO propio; desconocido → sin ACAO. Worker desplegado (versión `b8a6b44a`) |
| T3 · error de demo | `944a243`, `874f30a` | `tests/demo-settings.spec.ts` 8/8 (ruta abortada → mensaje accionable, sin «Failed to fetch») |
| T4 · citas al restaurar | `40efed1` | `tests/pdf-cite-restore.spec.ts` (falla sin el fix; 25/25 con `--repeat-each=5`) |
| T5 · verificación | `7a9215f` | suite completa: 715 passed; limpio de errores de lint |

## Hallazgos añadidos durante la verificación

Dos defectos que no estaban en el alcance inicial, encontrados al poner la suite en verde:

1. **`a023e11` rompió «Volver al repaso»** (`fa48b6e`): al ocultar TODOS los `.ai-taskchip` con
   `body.reading` se escondió también el chip de la sesión de repaso minimizada, que era la
   única vuelta a ella (P10 F2). Excepción solo para `is-study`; las notificaciones de jobs
   siguen sin invadir el texto.
2. **Preset de modelo**: `llm.spec` y `model-probe` esperaban `qwen3.6` cuando el preset es
   `deepseek-v4-flash` desde el sondeo IA7 F3 (`ac5d35c`).

También se endurecieron los tests de citas (esperas por señal en vez de tiempos fijos) y se
cerró una carrera real del repintado: si la segmentación terminaba antes que la restauración
del chat, los chips no volvían (`7a9215f`).

## Pendiente (flaky preexistente, no bloquea)

Bajo carga alta y en paralelo, algunos tests de selección/subrayado fallan por tiempos
(`pdf-touch-select`, `highlight-edit`, `pdf-fit-crop`, `reading-log`, `notebook`); todos pasan
en aislamiento. No se tocaron en este trabajo.
