// Destino del redirect de Google OAuth (popup). Reenvía el authorization code
// a la pestaña principal por BroadcastChannel (mismo origen) y se cierra.
// El canal y el formato deben coincidir con js/sync/drive-auth.js.
const params = new URLSearchParams(location.search);
const channel = new BroadcastChannel('bookreader-drive-auth');
channel.postMessage({
  code: params.get('code'),
  state: params.get('state'),
  error: params.get('error'),
});
channel.close();
window.close();
