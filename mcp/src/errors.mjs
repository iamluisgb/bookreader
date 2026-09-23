// errors.mjs — dos errores con destinatarios distintos.
//
//   SourceError  la fuente no se puede leer (fichero que no existe, no es un backup,
//                manifest ausente, Drive caído). El servidor NO arranca si pasa al inicio.
//   ToolError    la petición concreta no se puede responder (libro desconocido, `range`
//                inválido). Se devuelve al cliente como resultado de la tool con isError,
//                porque el modelo que la llamó tiene que poder leerla y corregir.

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}
