# Estudiar: fixes de visualización (post flashcards-dominio)

Tres defectos reportados con capturas del libro *Knowledge Graphs and LLMs in Action*:

- [x] **WU1 — «Ver el pasaje del libro» voltea la tarjeta.** El click en el `<summary>`
  burbujea al handler de toggle de `.study-card3d` → `unflip()` borra `.study-a` (con el
  pasaje dentro). Fix: excluir `details, summary` en el closest() (igual que ya hacía
  `wireSwipe`). Test: abrir/cerrar el pasaje no deshace el flip.
- [x] **WU2 — Frente cloze en dos columnas.** `.study-screen .study-q` es flex row; el
  frente cloze genera varios hijos (texto + span del hueco + texto) y cada fragmento se
  vuelve un flex item en columna estrecha. Fix: `frontHtml` envuelve todo en un único
  `<span class="study-qtext">`. Test: `.study-q` tiene un solo hijo elemento.
- [x] **WU3 — Diagramas en negro.** Las clases `d-box/d-txt/d-cap/d-line` que el prompt
  exige al modelo nunca tuvieron CSS en la app (quedaron en `demo/visual-cards.html`):
  rect/text caen al fill negro por defecto del SVG. Fix: portar los estilos a
  `modern.css` adaptados a tokens de tema (claro/oscuro). Test: el fill computado de
  `.d-box` no es negro.

## Commits

| WU | Commit | Nota |
|---|---|---|
| WU1 | `5805aab` | study.js + test en study.spec.ts (RED→GREEN) |
| WU2 | `9ced03a` | frontHtml wrapper + CSS .study-qtext + test |
| WU3 | `9ca13d5` | modern.css estilos de diagrama + test RED→GREEN |

Verificación: 43/43 tests de estudio (7 specs) · lint 0 errores (6 warnings pre-existentes).
