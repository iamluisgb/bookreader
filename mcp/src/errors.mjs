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

/**
 * Un `bookId` que no existe. Es un `SourceError` (la fuente es quien conoce los libros) pero se
 * distingue a propósito: la tool que lo recibe puede añadir la lista de ids válidos, y con un
 * `String.match` sobre el mensaje eso sería control de flujo por texto — el mensaje es para el
 * lector, no para el programa.
 */
export class UnknownBookError extends SourceError {
  constructor(bookId) {
    super('Libro desconocido: ' + bookId);
    this.name = 'UnknownBookError';
    this.bookId = bookId;
  }
}
