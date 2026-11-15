---
updated: 2026-11-15
---

# Sync y almacenamiento

Los números y los topes, en una página. El paso a paso está en
[Sincroniza y guarda una copia](../guias/sync-and-backup.md).

## Dónde vive cada cosa

| Qué                                  | Dónde                                   |
| ------------------------------------ | --------------------------------------- |
| Libros, notas, mazos, conversaciones | El navegador de este dispositivo        |
| API key                              | Solo en este dispositivo, nunca viaja   |
| Copia de sync (si activas Drive)     | Carpeta privada de tu Drive (`appDataFolder`) |
| Backup (JSON)                        | Un fichero que tú descargas             |

## Topes

| Límite                                      | Valor                                       |
| ------------------------------------------- | ------------------------------------------- |
| Libro que se sube solo al sync con Drive    | Hasta **50 MB**; más grande, se pide desde el menú del libro |
| Estantería compartida con libros dentro     | **100 MB**; sin libros, el enlace es ligero |
| Libros y lector                             | Gratis, sin cuenta                          |
| Demo del agente                             | Cupo de preguntas de prueba                 |
| Con tu clave (BYOK)                         | El límite de tu cuenta con el proveedor     |

## Qué sube el sync

- Los **datos** (notas, progreso, mazos, ajustes) siempre.
- Los **archivos de los libros** solo si activas esa opción; los de más de 50 MB nunca se suben
  solos.

## Backup (JSON) vs sync

|                   | Backup (JSON)                    | Sync                                  |
| ----------------- | -------------------------------- | ------------------------------------- |
| Qué es            | Un fichero con todo lo tuyo      | Los mismos datos en varios dispositivos |
| API key           | No la incluye                    | No viaja                              |
| Archivos de libros | No los incluye                  | Opcional                              |
| Restaurar         | Fusiona: no borra lo que sobra   | Automático                            |

## Siguiente

- [Sincroniza y guarda una copia](../guias/sync-and-backup.md), el paso a paso.
- [Qué pasa con tus datos](../explicacion/your-data.md), el porqué.
