const { contextBridge, ipcRenderer } = require('electron');

/**
 * Única ponte entre o renderer e o processo principal.
 * Nada de Node.js vaza para a página: só estas funcoes nominais.
 */
contextBridge.exposeInMainWorld('pinducall', {
  screen: {
    /** Lista telas e janelas disponíveis, com miniatura em data URL. */
    list: () => ipcRenderer.invoke('screen:list'),
    /** Registra a escolha antes de chamar getDisplayMedia(). */
    select: (id, withAudio) => ipcRenderer.invoke('screen:select', { id, withAudio }),
    cancel: () => ipcRenderer.invoke('screen:cancel'),
    /** Programas conhecidos que estão abertos mas sumiram da lista. */
    avisos: (nomesListados) => ipcRenderer.invoke('screen:avisos', nomesListados),
  },

  /** Modo automático: PinduCcall pilota o OBS escondido para pegar o Tibia. */
  obs: {
    disponivel: () => ipcRenderer.invoke('obs:disponivel'),
    iniciar: () => ipcRenderer.invoke('obs:iniciar'),
    parar: () => ipcRenderer.invoke('obs:parar'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (values) => ipcRenderer.invoke('settings:set', values),
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    // Troca o jeito como o Windows entrega a imagem da tela. Reabre o app.
    setModoCaptura: (modo) => ipcRenderer.invoke('app:modo-captura', modo),
    flashTaskbar: () => ipcRenderer.send('window:flash'),
  },

  /** Auto-atualização: acompanha o estado e reinicia quando a pessoa quiser. */
  update: {
    onStatus: (handler) => {
      const listener = (_event, payload) => handler(payload ?? {});
      ipcRenderer.on('update:status', listener);
      return () => ipcRenderer.removeListener('update:status', listener);
    },
    reiniciarAgora: () => ipcRenderer.invoke('update:reiniciar'),
    abrirDownload: () => ipcRenderer.invoke('update:abrir-download'),
  },

  /** Atalho global Ctrl+Shift+M -> alterna o microfone. */
  onToggleMute: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('shortcut:toggle-mute', listener);
    return () => ipcRenderer.removeListener('shortcut:toggle-mute', listener);
  },

  /** Link de convite clicado fora do app (pinduccall://entrar?...). */
  onDeepLink: (handler) => {
    const listener = (_event, url) => handler(String(url ?? ''));
    ipcRenderer.on('deeplink', listener);
    return () => ipcRenderer.removeListener('deeplink', listener);
  },
});
