/**
 * Entrada usada apenas pelo teste automatizado de mídia (scripts/e2e-media-test.mjs).
 * Expõe o RoomClient no window para que o Playwright possa dirigir dois "participantes"
 * dentro de um Chromium headless com microfone falso.
 *
 * Não entra no build do app: o electron-builder só empacota renderer/dist/renderer.js.
 */
import { RoomClient } from './room-client.js';

window.RoomClient = RoomClient;

// O room-client só toca em window.pinducall no compartilhamento de tela,
// que não faz parte deste teste; o stub evita ReferenceError se algo mudar.
window.pinducall = window.pinducall ?? {
  screen: {
    select: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    list: async () => [],
  },
  settings: { get: async () => ({}), set: async () => ({}) },
  app: { info: async () => ({ version: 'test' }), flashTaskbar: () => {}, openExternal: () => {} },
  onToggleMute: () => () => {},
};
