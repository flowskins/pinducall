const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  shell,
  session,
  screen,
} = require('electron');
const isDev = process.argv.includes('--dev');

/**
 * Perfis separados para conseguir rodar mais de uma cópia do app na mesma
 * máquina (útil para testar a sala sozinho, fazendo o papel de duas pessoas):
 *
 *   PinduCcall.exe --multi              perfil descartável, um por execução
 *   PinduCcall.exe --profile=teste      perfil nomeado, com preferências próprias
 *
 * Sem esses argumentos nada muda: um app, um perfil, uma janela.
 *
 * Precisa acontecer ANTES de qualquer require que use app.getPath('userData')
 * e antes do app ficar pronto, senão o Chromium já travou a pasta do perfil.
 */
function applyProfileOverride() {
  const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
  const wantsMulti = process.argv.includes('--multi');

  if (!profileArg && !wantsMulti) return null;

  const name = profileArg
    ? profileArg.slice('--profile='.length).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'extra'
    : `multi-${process.pid}`;

  const base = path.dirname(app.getPath('userData'));
  app.setPath('userData', path.join(base, `PinduCcall-${name}`));

  return name;
}

const profileName = applyProfileOverride();

// O store lê app.getPath('userData'), então só entra depois do override.
const store = require('./store');
const { listarJanelas } = require('./janelas-windows');
const obs = require('./obs-control');
const { configurarAtualizador } = require('./atualizador');

/**
 * Como o Windows entrega a imagem da tela para o app.
 *
 * O jeito antigo (GDI/DirectX, que o Chromium ainda escolhe sozinho em boa
 * parte das máquinas) copia o que está desenhado na área de trabalho. Janela
 * que desenha direto na placa de vídeo — jogo em DirectX, por exemplo — não
 * está lá, e sai um retângulo preto.
 *
 * O jeito novo é o Windows Graphics Capture (Windows 10 1903 em diante), a
 * mesma API que o OBS usa no modo "Windows 10" e que o Discord usa por padrão
 * no Windows 11. Ele pede a imagem para o compositor do Windows, que enxerga
 * o jogo. Os nomes abaixo são as features do Chromium 130 (as que estão dentro
 * deste Electron); nome desconhecido é ignorado em silêncio.
 */
const MODOS_DE_CAPTURA = {
  moderno: {
    rotulo: 'Moderno (Windows Graphics Capture)',
    ligar: ['AllowWgcScreenCapturer', 'AllowWgcWindowCapturer'],
    desligar: [],
  },
  automatico: { rotulo: 'Automático (o que o Windows escolher)', ligar: [], desligar: [] },
  antigo: {
    rotulo: 'Antigo (GDI/DirectX)',
    ligar: [],
    desligar: ['AllowWgcScreenCapturer', 'AllowWgcWindowCapturer'],
  },
};

const MODO_CAPTURA_PADRAO = 'moderno';

function aplicarModoDeCaptura() {
  if (process.platform !== 'win32') return 'automatico';

  const escolhido = MODOS_DE_CAPTURA[store.readAll().modoCaptura] ? store.readAll().modoCaptura : MODO_CAPTURA_PADRAO;
  const modo = MODOS_DE_CAPTURA[escolhido];

  if (modo.ligar.length) app.commandLine.appendSwitch('enable-features', modo.ligar.join(','));
  if (modo.desligar.length) app.commandLine.appendSwitch('disable-features', modo.desligar.join(','));

  return escolhido;
}

// Precisa rodar antes do app ficar pronto: depois disso o Chromium já leu a
// linha de comando e trocar de modo não tem mais efeito.
const modoCaptura = aplicarModoDeCaptura();

/** @type {BrowserWindow|null} */
let mainWindow = null;

/**
 * Fonte de tela escolhida pela pessoa no picker do app. O handler de
 * getDisplayMedia le esse valor quando o renderer chama a captura.
 * @type {{id: string, name: string, withAudio: boolean}|null}
 */
let pendingScreenSource = null;

function createWindow() {
  const saved = store.readAll();
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(saved.windowBounds?.width ?? 1180, workWidth),
    height: Math.min(saved.windowBounds?.height ?? 760, workHeight),
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#16171d',
    show: false,
    autoHideMenuBar: true,
    // Com perfil extra, o nome vai no título para você distinguir as janelas.
    title: profileName ? `CAUCALL (${profileName})` : 'CAUCALL',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Necessario para que o audio toque sem interacao previa do usuário.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // O <title> do HTML sobrescreve o título da janela ao carregar. Com perfil
  // extra queremos manter o nome do perfil visível na barra e na taskbar.
  if (profileName) {
    mainWindow.on('page-title-updated', (event) => {
      event.preventDefault();
      mainWindow.setTitle(`CAUCALL (${profileName})`);
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Se o app foi aberto por um link de convite, o renderer só existe agora.
  mainWindow.webContents.once('did-finish-load', () => {
    if (!deepLinkPendente) return;
    const link = deepLinkPendente;
    deepLinkPendente = null;
    mainWindow.webContents.send('deeplink', link);
  });

  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    store.writeAll({ windowBounds: { width: bounds.width, height: bounds.height } });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos abrem no navegador, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Intercepta navigator.mediaDevices.getDisplayMedia() e devolve a fonte que a
 * pessoa escolheu no nosso picker. `audio: 'loopback'` captura o som do sistema
 * no Windows (o que faz o compartilhamento de vídeo/jogo ter áudio).
 *
 * Detalhe importante do Electron: NÃO existe forma silenciosa de recusar uma
 * requisição. Qualquer callback sem uma fonte válida lança no processo principal
 * ("Video was requested, but no video stream was provided") — e é justamente
 * essa exceção que faz o renderer receber AbortError, que é o comportamento
 * desejado. Por isso a recusa fica dentro de um try/catch e a exceção esperada
 * é engolida, em vez de virar um unhandled rejection.
 */
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      let alreadyAnswered = false;

      /** O callback do Electron só pode ser chamado UMA vez. */
      const answer = (response, { expectFailure = false } = {}) => {
        if (alreadyAnswered) return;
        alreadyAnswered = true;

        try {
          callback(response);
        } catch (error) {
          if (!expectFailure) {
            console.error('[display-media] o Electron recusou a fonte escolhida:', error.message);
          }
        }
      };

      /** Recusa a captura (o renderer recebe AbortError). */
      const deny = () => answer({}, { expectFailure: true });

      try {
        if (!pendingScreenSource) {
          deny();
          return;
        }

        const { id, withAudio } = pendingScreenSource;
        pendingScreenSource = null;

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          fetchWindowIcons: false,
        });
        const source = sources.find((candidate) => candidate.id === id);

        if (!source) {
          console.warn('[display-media] a fonte escolhida sumiu antes da captura');
          deny();
          return;
        }

        // 'loopback' só existe no Windows; em outros sistemas cai para sem áudio.
        const wantsLoopback = withAudio && process.platform === 'win32';
        answer(wantsLoopback ? { video: source, audio: 'loopback' } : { video: source });
      } catch (error) {
        console.error('[display-media] falhou:', error.message);
        deny();
      }
    },
    { useSystemPicker: false },
  );

  // Microfone e camera são liberados automaticamente: o app e local e a pessoa
  // já consentiu ao instalar. Qualquer outra permissão e negada.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission));
  });
}

function registerIpc() {
  ipcMain.handle('screen:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });

    return sources.map((source) => {
      const vazia = miniaturaEstaVazia(source.thumbnail);
      return {
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail?.toDataURL() ?? null,
      appIcon: source.appIcon?.toDataURL() ?? null,
      // Jogos com aceleração de vídeo costumam devolver miniatura toda preta.
      // Quando isso acontece, a transmissão quase sempre vai preta também, e
      // é melhor avisar antes do que a pessoa descobrir com a sala reclamando.
      miniaturaVazia: vazia,
      // Instrução específica quando reconhecemos o programa.
      dica: vazia ? dicaDaJanela(source.name) : null,
      };
    });
  });

  // Janela que existe mas o Windows não deixa listar/copiar.
  ipcMain.handle('screen:avisos', async (_event, nomesListados) =>
    avisosDeCaptura(Array.isArray(nomesListados) ? nomesListados.map(String) : []),
  );

  // Modo automático do OBS: transmitir o Tibia sem a pessoa abrir o OBS.
  ipcMain.handle('obs:disponivel', () => obsDisponivel());
  ipcMain.handle('obs:iniciar', () => iniciarObsTibia());
  ipcMain.handle('obs:parar', () => pararObsTibia());

  // O renderer avisa qual fonte escolheu logo antes de chamar getDisplayMedia.
  ipcMain.handle('screen:select', (_event, { id, withAudio }) => {
    pendingScreenSource = { id, withAudio: Boolean(withAudio), name: '' };
    return { ok: true };
  });

  ipcMain.handle('screen:cancel', () => {
    pendingScreenSource = null;
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => store.readAll());
  ipcMain.handle('settings:set', (_event, values) => store.writeAll(values ?? {}));

  // Redução de ruído (RNNoise): o renderer não pode ler arquivos (file:// + fetch
  // bloqueado), então o processo principal entrega o worklet (texto) e o binário
  // WASM. O renderer monta um Blob para o AudioWorklet e passa o wasm ao nó.
  ipcMain.handle('ruido:carregar', () => {
    const base = path.join(__dirname, '..', 'renderer', 'assets', 'rnnoise');
    const workletCode = fs.readFileSync(path.join(base, 'workletProcessor.js'), 'utf8');
    const buf = fs.readFileSync(path.join(base, 'rnnoise_simd.wasm'));
    // Buffer -> ArrayBuffer exato (sem carregar o resto do pool do Node).
    const wasm = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { workletCode, wasm };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    // Endereço oficial do servidor, para o botão "voltar ao padrão".
    defaultServerUrl: store.DEFAULTS.serverUrl,
    modoCaptura,
    modosDeCaptura: Object.entries(MODOS_DE_CAPTURA).map(([id, modo]) => ({ id, rotulo: modo.rotulo })),
  }));

  // Trocar o modo de captura só vale na próxima abertura: o Chromium lê a
  // linha de comando uma vez, na largada. Então gravamos e reabrimos o app.
  ipcMain.handle('app:modo-captura', (_event, modo) => {
    if (!MODOS_DE_CAPTURA[modo]) return { ok: false, erro: 'modo desconhecido' };
    store.writeAll({ modoCaptura: modo });
    if (modo === modoCaptura) return { ok: true, reiniciou: false };

    // Reabre com os mesmos argumentos (perfil extra continua sendo perfil extra).
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
    return { ok: true, reiniciou: true };
  });

  ipcMain.handle('app:open-external', (_event, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.on('window:flash', () => {
    if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });
}

/**
 * Programas que se recusam a ser copiados em certos modos de vídeo. Quando um
 * deles aparece com a janela sem imagem, entregamos a instrução exata em vez do
 * conselho genérico — é a diferença entre a pessoa resolver em dez segundos ou
 * desistir de compartilhar.
 */
const INSTRUCAO_TIBIA =
  'Trocar o motor gráfico não resolve mais: a trava está ligada em DirectX 5, DirectX 9 e '
  + 'OpenGL. A saída é a aba "Câmera / OBS" aqui do lado — no OBS, clique em Iniciar Câmera '
  + 'Virtual e escolha ela aqui. O OBS captura o jogo, o CAUCALL transmite.';

const JANELAS_CONHECIDAS = [
  { padrao: /\btibia\b/i, instrucao: INSTRUCAO_TIBIA },
];

function instrucaoDaJanela(nome) {
  return (
    JANELAS_CONHECIDAS.find((item) => item.padrao.test(String(nome ?? '')))?.instrucao
    ?? INSTRUCAO_GENERICA
  );
}

function dicaDaJanela(nome) {
  const conhecida = JANELAS_CONHECIDAS.find((item) => item.padrao.test(String(nome ?? '')));
  return conhecida ? `${nome} está travado contra cópia. ${conhecida.instrucao}` : null;
}

/**
 * Avisos sobre janelas que o Windows não deixa copiar.
 *
 * Em vez de deduzir pela miniatura preta, aqui a gente pergunta ao Windows: a
 * marca de "não copiar" (display affinity) é uma propriedade da janela, e ela
 * responde de uma vez as duas confusões que apareciam antes — a janela que
 * aparecia preta e a janela que simplesmente sumia da lista (dependendo do
 * modo de captura, o Windows faz uma coisa ou outra com a mesma trava).
 *
 * @param {string[]} nomesListados nomes das janelas que apareceram para escolher
 */
async function avisosDeCaptura(nomesListados) {
  const janelas = await listarJanelas().catch(() => []);
  const travadas = janelas.filter((janela) => janela.travada);

  return travadas.map((janela) => {
    const naLista = nomesListados.includes(janela.titulo);
    const situacao = naLista
      ? `A janela "${janela.titulo}" vai sair preta para todo mundo:`
      : `"${janela.titulo}" está aberto mas não aparece na lista:`;

    return {
      janela: janela.titulo,
      naLista,
      aviso: `${situacao} o Windows está com a trava de cópia ligada nela. ${instrucaoDaJanela(janela.titulo)}`,
    };
  });
}

// ---------------------------------------------------------------------------
// OBS escondido: transmitir o Tibia sem a pessoa abrir o OBS
// ---------------------------------------------------------------------------

const WebSocket = require('ws');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Nome fixo da cena e da fonte que o PinduCcall cria dentro do OBS. Fixo de
// propósito: assim, ao ligar de novo, a gente reaproveita em vez de empilhar.
const OBS_CENA = 'PinduCcall';
const OBS_FONTE = 'Tibia (PinduCcall)';

/** @type {import('./obs-control').ObsControle|null} */
let obsAtivo = null;

/** Está tudo pronto para o modo automático (Windows + OBS instalado)? */
function obsDisponivel() {
  if (process.platform !== 'win32') return { ok: false, motivo: 'so-windows' };
  const caminho = obs.acharObs(store.readAll().obsPath);
  return caminho ? { ok: true, caminho } : { ok: false, motivo: 'sem-obs' };
}

/** Descobre a janela do Tibia para apontar o "Captura de Jogo". */
async function alvoTibia() {
  const janelas = await listarJanelas().catch(() => []);
  const alvo = janelas.find((j) => j.travada && /tibia/i.test(j.titulo))
    ?? janelas.find((j) => /tibia/i.test(j.titulo));
  return alvo
    ? { titulo: alvo.titulo, classe: alvo.classe || 'Qt5152QWindowIcon', exe: 'client.exe' }
    : { titulo: 'Tibia', classe: 'Qt5152QWindowIcon', exe: 'client.exe' };
}

/**
 * Liga o modo automático: garante o OBS aberto (escondido), monta a cena do
 * Tibia e inicia a câmera virtual. Quando isto resolve, a câmera do OBS já
 * existe no sistema e o renderer pode escolhê-la.
 */
async function iniciarObsTibia() {
  const disp = obsDisponivel();
  if (!disp.ok) {
    throw new Error(
      disp.motivo === 'so-windows'
        ? 'o modo automático do OBS só funciona no Windows'
        : 'não encontrei o OBS instalado. Instale o OBS Studio (uma vez só) e tente de novo.',
    );
  }

  const cfg = store.readAll();
  const porta = Number(cfg.obsPorta) || 4455;
  const senha = cfg.obsSenha || '';
  const controle = new obs.ObsControle((url) => new WebSocket(url));

  const tentar = async (vezes) => {
    for (let i = 0; i < vezes; i += 1) {
      try { await controle.conectar({ porta, senha, timeoutMs: 4000 }); return true; }
      catch { await dormir(1500); }
    }
    return false;
  };

  // Se o OBS já estiver de pé com o websocket ligado, conecta na hora. Senão,
  // abre ele escondido e espera subir.
  let conectou = await tentar(1);
  if (!conectou) {
    obs.abrirObsEscondido(disp.caminho);
    conectou = await tentar(10); // ~15s de margem para o OBS carregar
  }
  if (!conectou) {
    throw new Error(
      'não consegui falar com o OBS. Abra o OBS uma vez, vá em Ferramentas → '
      + 'Configurações do Servidor WebSocket, marque "Ativar" e confira se a porta e a '
      + 'senha batem com as das configurações do CAUCALL.',
    );
  }

  const janela = await alvoTibia();
  const settings = obs.configDoCaptura(janela);

  await controle.pedir('CreateScene', { sceneName: OBS_CENA }).catch(() => {});
  await controle.pedir('SetCurrentProgramScene', { sceneName: OBS_CENA }).catch(() => {});
  try {
    await controle.pedir('CreateInput', {
      sceneName: OBS_CENA,
      inputName: OBS_FONTE,
      inputKind: 'game_capture',
      inputSettings: settings,
    });
  } catch {
    // Já existe de uma vez anterior: só reaponta para a janela atual.
    await controle.pedir('SetInputSettings', {
      inputName: OBS_FONTE,
      inputSettings: settings,
      overlay: true,
    }).catch(() => {});
  }

  await controle.pedir('StartVirtualCam', {});
  obsAtivo = controle;
  return { ok: true, janela: janela.titulo };
}

/** Desliga a câmera virtual e solta a conexão (não fecha o OBS à força). */
async function pararObsTibia() {
  if (!obsAtivo) return { ok: true };
  try { await obsAtivo.pedir('StopVirtualCam', {}); } catch {}
  obsAtivo.fechar();
  obsAtivo = null;
  return { ok: true };
}

/**
 * A miniatura é praticamente toda preta?
 *
 * O Windows entrega a imagem de uma janela lendo o que está desenhado nela.
 * Jogo em tela cheia exclusiva (Tibia, por exemplo) desenha direto na placa de
 * vídeo, e o que sobra para ler é uma superfície vazia — miniatura preta, e
 * transmissão preta junto. Detectar isso aqui é barato: a imagem tem 320x200 e
 * a checagem é uma passada amostrada pelos pixels.
 *
 * @param {import('electron').NativeImage|null|undefined} imagem
 */
function miniaturaEstaVazia(imagem) {
  if (!imagem || imagem.isEmpty()) return true;

  let bitmap;
  try {
    bitmap = imagem.toBitmap(); // BGRA
  } catch {
    return false;
  }

  if (bitmap.length < 4) return true;

  const LIMITE_ESCURO = 12; // 0-255: abaixo disso o olho já lê como preto
  let acesos = 0;
  let amostras = 0;

  // Um pixel a cada 16 (64 bytes) já basta e mantém a checagem instantânea.
  for (let i = 0; i < bitmap.length - 3; i += 64) {
    amostras += 1;
    if (bitmap[i] > LIMITE_ESCURO || bitmap[i + 1] > LIMITE_ESCURO || bitmap[i + 2] > LIMITE_ESCURO) {
      acesos += 1;
      // 2% de pixels acesos já é conteúdo de verdade; não precisa varrer o resto.
      if (acesos > amostras * 0.02 && acesos > 8) return false;
    }
  }

  return acesos <= Math.max(8, amostras * 0.02);
}

// ---------------------------------------------------------------------------
// Links de convite (pinduccall://entrar?t=...&srv=...)
// ---------------------------------------------------------------------------

const PROTOCOLO = 'pinduccall';

/** Guarda o link recebido antes da janela existir, para entregar depois. */
let deepLinkPendente = null;

/** Acha um "pinduccall://..." numa lista de argumentos da linha de comando. */
function acharDeepLink(argv) {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOLO}://`)) ?? null;
}

/**
 * Registra o app como dono do protocolo. Em desenvolvimento o executável é o
 * próprio electron.exe, então é preciso dizer qual script ele deve abrir.
 */
function registrarProtocolo() {
  // Perfis de teste não sequestram o protocolo da instalação de verdade.
  if (profileName) return;

  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOLO, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOLO);
    }
  } catch (error) {
    console.warn('[deeplink] não consegui registrar o protocolo:', error.message);
  }
}

function entregarDeepLink(url) {
  if (!url) return;

  if (!mainWindow || mainWindow.webContents.isLoading()) {
    deepLinkPendente = url;
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('deeplink', url);
}

function registerShortcuts() {
  // Um atalho global é do sistema inteiro: só a instância principal registra,
  // senão as cópias de teste brigariam entre si pela mesma combinação.
  if (profileName) {
    console.log('[shortcut] perfil extra: atalho global desativado nesta janela');
    return;
  }

  // Funciona mesmo com o app minimizado ou fora de foco.
  const registered = globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('shortcut:toggle-mute');
  });

  if (!registered) {
    console.warn('[shortcut] Ctrl+Shift+M já está em uso por outro programa');
  }
}

// Uma instância só: abrir de novo apenas foca a janela existente.
//
// Exceção: com --multi (ou --dev) o app abre quantas janelas você quiser, cada
// uma com seu próprio perfil. É assim que dá para testar a sala sozinho, com
// duas "pessoas" no mesmo computador:
//   PinduCcall.exe --multi
const allowMultipleInstances = isDev || process.argv.includes('--multi');
const gotLock = allowMultipleInstances || app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  // No Windows o link chega como argumento da segunda instância.
  app.on('second-instance', (_event, argv) => {
    const link = acharDeepLink(argv);
    if (link) {
      entregarDeepLink(link);
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // No macOS ele chega por evento próprio, antes ou depois do app ficar pronto.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    entregarDeepLink(url);
  });

  app.whenReady().then(() => {
    registrarProtocolo();
    setupDisplayMediaHandler();
    registerIpc();
    registerShortcuts();
    createWindow();

    // Toda abertura confere se saiu versão nova e atualiza (ver atualizador.js).
    configurarAtualizador(mainWindow);

    // App aberto direto pelo link: o argumento já veio nesta execução.
    deepLinkPendente = acharDeepLink(process.argv) ?? deepLinkPendente;

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
