// Config para comprobar una web ya desplegada: no levanta ningún servidor local, las pruebas apuntan
// a SMOKE_BASE. Se usa desde `npm run smoke:filtros` al final de cada despliegue.
import base from './playwright.config';

export default {
  ...base,
  webServer: [],
  use: { ...base.use, baseURL: undefined },
};
