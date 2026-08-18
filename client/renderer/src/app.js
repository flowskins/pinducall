import { RoomClient } from './room-client.js';
import { AudioPlayback, MicLevelMeter } from './playback.js';
import { icons } from './icons.js';
import { TibiaPanel } from './tibia-panel.js';
import { prepararAudio, tocarEntrada, tocarSaida, tocarTroca } from './sounds.js';
import { listarSalas, criarSala, verConvite } from './lobby.js';
import { iniciarNeve, iniciarChuva } from './efeitos.js';

// =============================================================================
// Helpers de DOM
// =============================================================================

const $ = (id) => document.getElementById(id);

const el = {
  connectScreen: $('connect-screen'),
  inputName: $('input-name'),

  // Modal "Entrar na sala" (a senha vive aqui agora, não mais na tela principal).
  entrarModal: $('entrar-modal'),
  entrarForm: $('entrar-form'),
  entrarNome: $('entrar-nome'),
  connectError: $('connect-error'),
  btnConnect: $('btn-connect'),
  inputPassword: $('input-password'),
  inputRemember: $('input-remember'),

  roomList: $('room-list'),
  roomsStatus: $('rooms-status'),
  btnRoomsRefresh: $('btn-rooms-refresh'),
  btnOpenCreate: $('btn-open-create'),
  serverStatus: $('server-status'),

  createModal: $('create-modal'),
  createForm: $('create-form'),
  createNome: $('create-nome'),
  createSenha: $('create-senha'),
  createSenha2: $('create-senha2'),
  createError: $('create-error'),
  btnCreate: $('btn-create'),

  roomScreen: $('room-screen'),
  roomTitle: $('room-title'),
  roomCount: $('room-count'),
  connectionDot: $('connection-dot'),
  peerList: $('peer-list'),
  btnCriarCanal: $('btn-criar-canal'),
  canalCriar: $('canal-criar'),
  inputCanal: $('input-canal'),
  btnCanalOk: $('btn-canal-ok'),
  btnCanalCancel: $('btn-canal-cancel'),

  selfAvatar: $('self-avatar'),
  selfName: $('self-name'),
  selfStatus: $('self-status'),
  btnMic: $('btn-mic'),
  btnDeafen: $('btn-deafen'),
  btnSettings: $('btn-settings'),
  btnLeave: $('btn-leave'),

  stageTitle: $('stage-title'),
  stageGrid: $('stage-grid'),
  stageEmpty: $('stage-empty'),
  btnShare: $('btn-share'),
  btnInvite: $('btn-invite'),
  btnToggleChat: $('btn-toggle-chat'),

  inviteModal: $('invite-modal'),
  inviteUrl: $('invite-url'),
  inviteSala: $('invite-sala'),
  inviteValidade: $('invite-validade'),
  inviteError: $('invite-error'),
  btnInviteCopy: $('btn-invite-copy'),

  guestModal: $('guest-modal'),
  guestForm: $('guest-form'),
  guestNome: $('guest-nome'),
  guestSala: $('guest-sala'),
  guestError: $('guest-error'),
  btnGuestCancel: $('btn-guest-cancel'),
  btnGuestEnter: $('btn-guest-enter'),

  selfPreview: $('self-preview'),
  selfPreviewVideo: $('self-preview-video'),
  selfPreviewStats: $('self-preview-stats'),
  btnPreviewSize: $('btn-preview-size'),
  btnPreviewStop: $('btn-preview-stop'),

  chatPanel: $('chat-panel'),
  chatMessages: $('chat-messages'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatDrop: $('chat-drop'),
  btnAnexo: $('btn-anexo'),
  inputAnexo: $('input-anexo'),
  uploadBar: $('upload-bar'),
  uploadNome: $('upload-nome'),
  uploadFill: $('upload-fill'),
  uploadCancelar: $('upload-cancelar'),

  screenPicker: $('screen-picker'),
  sourceGrid: $('source-grid'),
  sourceDica: $('source-dica'),
  btnSourceRefresh: $('btn-source-refresh'),
  btnStartShare: $('btn-start-share'),
  inputShareAudio: $('input-share-audio'),
  selectQuality: $('select-quality'),

  settingsModal: $('settings-modal'),
  selectInput: $('select-input'),
  selectOutput: $('select-output'),
  selectCaptura: $('select-captura'),
  inputObsPorta: $('input-obs-porta'),
  inputObsSenha: $('input-obs-senha'),
  obsAuto: $('obs-auto'),
  btnObsAuto: $('btn-obs-auto'),
  obsAutoStatus: $('obs-auto-status'),
  inputVolume: $('input-volume'),
  inputRuido: $('input-ruido'),
  inputEcho: $('input-echo'),
  inputNoise: $('input-noise'),
  inputGain: $('input-gain'),
  micMeterFill: $('mic-meter-fill'),
  appVersion: $('app-version'),

  // Perfil / avatar nas configurações
  avatarPreview: $('avatar-preview'),
  avatarEmojis: $('avatar-emojis'),
  avatarCores: $('avatar-cores'),
  btnAvatarReset: $('btn-avatar-reset'),

  toasts: $('toasts'),
};

// Clima: neve na entrada (dramática), chuva + relâmpagos no app (perceptível).
// Fica aqui, cedo, para não depender do resto do boot. Cada efeito só desenha
// quando a tela dele está visível e a aba está ativa.
iniciarNeve(document.getElementById('fx-neve'), {
  quantidade: 260,
  visivel: () => !el.connectScreen.classList.contains('hidden'),
});
iniciarChuva(document.getElementById('fx-chuva'), {
  quantidade: 150,
  visivel: () => !el.roomScreen.classList.contains('hidden'),
});

// =============================================================================
// Estado da aplicação
// =============================================================================

const room = new RoomClient();
const playback = new AudioPlayback();
const micMeter = new MicLevelMeter();

/** @type {TibiaPanel|null} — criado ao entrar na sala. */
let tibia = null;

const state = {
  settings: null,
  /** @type {Map<string, {id, displayName, state}>} */
  peers: new Map(),
  /** @type {Map<string, {consumerId, peerId, element}>} */
  tiles: new Map(),
  selectedSourceId: null,
  sourceTab: 'screen',
  focusedTile: null,
  lastChatAuthor: null,
  lastChatAt: 0,
  speakingTimers: new Map(),
  selfName: '',
  connected: false,

  /** Endereço do servidor em uso (vem das preferências, editável no modal). */
  serverUrl: '',
  /** @type {Array<{id, nome, pessoas}>} */
  salas: [],
  /** Id da sala escolhida na lista. */
  salaSelecionada: null,

  /** Sub-salas (canais de voz) da sala atual. */
  canais: [{ id: 'principal', nome: 'Principal', fixo: true, count: 0 }],
  /** Em qual sub-sala eu estou. */
  selfChannel: 'principal',
  /** Peer com o painel de volume aberto (null = nenhum). */
  openPeerPanel: null,
  /** Mostrando o campo de criar sub-sala? */
  criandoCanal: false,
  /** peerId -> consumerId do áudio da tela compartilhada (pra volume separado). */
  screenAudioByPeer: new Map(),
  /** consumerIds de vídeo que EU escolhi não assistir (ocultos + pausados). */
  hiddenTiles: new Set(),
};

// Paleta neon: verdes e roxos com brilho, para combinar com o tema.
const AVATAR_COLORS = [
  'linear-gradient(135deg, #33ff33, #1fcc1f)',
  'linear-gradient(135deg, #b14dff, #7a2ecc)',
  'linear-gradient(135deg, #a6ff2e, #1fcc1f)',
  'linear-gradient(135deg, #d6a2ff, #b14dff)',
  'linear-gradient(135deg, #33ffcc, #00a3ff)',
  'linear-gradient(135deg, #ff7bd5, #b14dff)',
  'linear-gradient(135deg, #aaff00, #33ff33)',
];

// Para texto (nomes no chat) precisamos de cor sólida, não de gradiente.
const AUTHOR_COLORS = ['#33ff33', '#c77dff', '#a6ff2e', '#d6a2ff', '#33ffcc', '#ff7bd5', '#aaff00'];

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hashOf(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** Gradiente do avatar. */
function colorFor(id) {
  return AVATAR_COLORS[hashOf(id) % AVATAR_COLORS.length];
}

/** Cor sólida para o nome no chat (gradiente não serve para texto). */
function authorColorFor(id) {
  return AUTHOR_COLORS[hashOf(id) % AUTHOR_COLORS.length];
}

// Opções do seletor de avatar (aba Perfil nas configurações).
const AVATAR_EMOJIS = ['🐉', '⚔️', '🛡️', '🏹', '🔥', '💀', '👑', '🧙', '🐺', '🦁', '🐸', '🍺', '🎧', '😎', '👾', '🤖'];
const AVATAR_PALETTE = ['#33ff33', '#00c2ff', '#b14dff', '#ff5c6c', '#ffb020', '#ff7bd5', '#2ee6a6', '#9aa4b2'];

/** Versão escurecida de um hex, para o avatar custom virar um gradiente sutil. */
function corEscura(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 255) - 55);
  const g = Math.max(0, ((n >> 8) & 255) - 55);
  const b = Math.max(0, (n & 255) - 55);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Pinta um .avatar com o avatar escolhido; sem avatar, cai nas iniciais + cor do id. */
function aplicarAvatar(elemento, { id, name, avatar }) {
  const emoji = avatar?.emoji;
  const cor = avatar?.color;
  elemento.textContent = emoji || initials(name);
  elemento.classList.toggle('avatar--emoji', Boolean(emoji));
  elemento.style.background = cor
    ? `linear-gradient(135deg, ${cor}, ${corEscura(cor)})`
    : colorFor(id);
}

function toast(message, kind = 'info', ms = 5000) {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => node.remove(), ms);
}

/**
 * Aviso clicável e persistente (para a atualização): fica na tela até a pessoa
 * clicar na ação ou fechar no "×". Usado para "reiniciar para atualizar" etc.
 */
function toastAcao(message, rotuloAcao, aoClicar, kind = 'ok') {
  const node = document.createElement('div');
  node.className = `toast toast--${kind} toast--acao`;

  const texto = document.createElement('span');
  texto.textContent = message;

  const botao = document.createElement('button');
  botao.className = 'toast__acao';
  botao.textContent = rotuloAcao;
  botao.addEventListener('click', () => {
    try {
      aoClicar();
    } finally {
      node.remove();
    }
  });

  const fechar = document.createElement('button');
  fechar.className = 'toast__fechar';
  fechar.textContent = '×';
  fechar.title = 'Dispensar';
  fechar.addEventListener('click', () => node.remove());

  node.append(texto, botao, fechar);
  el.toasts.append(node);
  return node;
}

/** Liga os avisos de atualização vindos do processo principal. */
function ligarAvisosDeAtualizacao() {
  if (!window.pinducall.update?.onStatus) return;

  let barraPronta = null;
  window.pinducall.update.onStatus((info) => {
    if (!info || !info.status) return;

    if (info.status === 'baixando') {
      toast(`Baixando atualização ${info.versao ?? ''}…`.trim(), 'info', 6000);
    } else if (info.status === 'pronta') {
      barraPronta?.remove();
      barraPronta = toastAcao(
        `Atualização ${info.versao ?? ''} baixada — será aplicada quando você fechar o app.`.trim(),
        'Reiniciar agora',
        () => window.pinducall.update.reiniciarAgora(),
      );
    } else if (info.status === 'disponivel-manual') {
      toastAcao(
        `Saiu a versão ${info.versao ?? ''} do CAUCALL.`.trim(),
        'Baixar',
        () => window.pinducall.update.abrirDownload(),
        'info',
      );
    }
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// =============================================================================
// Tela de conexão
// =============================================================================

async function loadSettings() {
  state.settings = await window.pinducall.settings.get();

  // O servidor é fixo: vem embutido no app (defaultServerUrl). A gente NÃO usa
  // mais nenhum endereço salvo — nem os de teste local que sobraram por aí. Isso
  // deixa a entrada sem pedir/mostrar IP e mata de vez o "conectando no localhost".
  const info = await window.pinducall.app.info();
  el.appVersion.textContent = `CAUCALL ${info.version}`;
  state.defaultServerUrl = info.defaultServerUrl ?? state.settings.serverUrl ?? '';
  state.serverUrl = state.defaultServerUrl;
  montarModosDeCaptura(info);

  // Limpa qualquer endereço antigo gravado, pra não confundir versões futuras.
  if (state.settings.serverUrl && state.settings.serverUrl !== state.serverUrl) {
    window.pinducall.settings.set({ serverUrl: state.serverUrl }).catch(() => {});
  }

  el.inputName.value = state.settings.displayName ?? '';
  state.salaSelecionada = state.settings.roomId ?? null;
  // A senha/lembrar agora ficam no modal "Entrar" e são preenchidas em abrirEntrar().

  el.inputVolume.value = String(Math.round((state.settings.micVolume ?? 1) * 100));
  el.inputRuido.checked = state.settings.reducaoRuido !== false;
  el.inputEcho.checked = state.settings.echoCancellation !== false;
  el.inputNoise.checked = state.settings.noiseSuppression !== false;
  el.inputGain.checked = state.settings.autoGainControl !== false;

  playback.setMasterVolume(state.settings.micVolume ?? 1);

  if (el.inputObsPorta) el.inputObsPorta.value = String(state.settings.obsPorta ?? 4455);
  if (el.inputObsSenha) el.inputObsSenha.value = state.settings.obsSenha ?? '';

  mostrarEnderecoServidor();
  if (!el.inputName.value) el.inputName.focus();
  atualizarSalas();
}

// =============================================================================
// Lista de salas
// =============================================================================

/** "host:porta" do servidor fixo, só para mostrar no rodapé. */
function rotuloDoServidor() {
  try {
    const url = new URL(state.serverUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return state.serverUrl;
  }
}

/**
 * Rodapé só de leitura: mostra qual servidor está em uso. Não dá para trocar —
 * o endereço é fixo, embutido no app. Serve de indicador (online/offline).
 */
function mostrarEnderecoServidor() {
  if (el.serverStatus) el.serverStatus.textContent = `servidor: ${rotuloDoServidor()}`;
}

/** Pinta o indicador do rodapé conforme a última tentativa de falar com o servidor. */
function marcarServidor(online) {
  if (!el.serverStatus) return;
  el.serverStatus.classList.toggle('server-status--on', online);
  el.serverStatus.classList.toggle('server-status--off', !online);
}

function pluralPessoas(n) {
  if (n === 0) return 'vazia';
  return n === 1 ? '1 pessoa' : `${n} pessoas`;
}

function renderRoomList() {
  el.roomList.innerHTML = '';

  if (state.salas.length === 0) {
    el.roomsStatus.textContent = 'Nenhuma sala ainda neste servidor. Crie a primeira ali embaixo.';
    el.roomsStatus.classList.remove('hidden');
    return;
  }

  el.roomsStatus.classList.add('hidden');

  for (const sala of state.salas) {
    const item = document.createElement('li');
    item.className = 'room';
    item.dataset.id = sala.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const nome = document.createElement('span');
    nome.className = 'room__name';
    nome.textContent = sala.nome;

    const meta = document.createElement('span');
    meta.className = 'room__meta';
    meta.classList.toggle('room__meta--live', sala.pessoas > 0);
    meta.textContent = pluralPessoas(sala.pessoas);

    // Salas vazias somem sozinhas: avisa quanto tempo falta, sem poluir a lista.
    if (sala.expiraEm) {
      const horas = Math.max(1, Math.round((sala.expiraEm - Date.now()) / 3_600_000));
      item.title = `Sala vazia — some em ${horas}h se ninguém entrar.`;
    } else if (sala.fixa) {
      item.title = 'Sala fixa do servidor.';
    }

    item.append(nome, meta);

    // Clicar numa sala abre o popup que só pede a senha e entra.
    const escolher = () => abrirEntrar(sala);
    item.addEventListener('click', escolher);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        escolher();
      }
    });

    el.roomList.append(item);
  }
}

async function atualizarSalas() {
  el.roomsStatus.textContent = 'Procurando salas...';
  el.roomsStatus.classList.remove('hidden');
  el.btnRoomsRefresh.disabled = true;

  try {
    const resposta = await listarSalas(state.serverUrl);
    state.salas = resposta.salas ?? [];
    marcarServidor(true);
    renderRoomList();
  } catch (error) {
    console.warn('[app] não consegui listar as salas:', error.message);
    state.salas = [];
    el.roomList.innerHTML = '';
    marcarServidor(false);
    el.roomsStatus.textContent = 'Servidor fora do ar. Tente de novo em alguns segundos com "atualizar".';
    el.roomsStatus.classList.remove('hidden');
  } finally {
    el.btnRoomsRefresh.disabled = false;
  }
}

el.btnRoomsRefresh.addEventListener('click', () => atualizarSalas());

/** Aceita "192.168.0.10", "192.168.0.10:4000" ou a URL completa. */
function normalizeServerUrl(raw) {
  let value = String(raw).trim();
  if (!value) throw new Error('Informe o endereço do servidor');

  if (!/^wss?:\/\//i.test(value)) {
    value = value.replace(/^https?:\/\//i, (match) => (match.toLowerCase() === 'https://' ? 'wss://' : 'ws://'));
  }
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;

  const url = new URL(value);
  if (!url.port && url.protocol === 'ws:') url.port = '4000';
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';

  return url.toString();
}

/**
 * Caminho único de entrada: usado tanto pelo botão "Entrar" quanto logo
 * depois de criar uma sala. Lança se algo der errado, para quem chamou
 * decidir onde mostrar o erro.
 */
async function entrarNaSala({ roomId, password, convite, nome }) {
  const displayName = (nome ?? el.inputName.value).trim();
  if (!displayName) throw new Error('Escolha um nome antes de entrar');
  if (!roomId) throw new Error('Escolha uma sala na lista ou crie uma nova');

  el.inputName.value = displayName;

  await window.pinducall.settings.set({
    serverUrl: state.serverUrl,
    roomId,
    displayName,
    // Entrando por convite não existe senha para guardar.
    password: convite ? '' : password,
    rememberPassword: convite ? false : el.inputRemember.checked,
  });

  // Precisa estar definido ANTES do join: o evento 'joined' e emitido
  // de dentro de room.join() e já usa este nome na interface.
  state.selfName = displayName;

  await room.join({
    url: state.serverUrl,
    roomId,
    displayName,
    password,
    convite,
    avatar: state.settings?.avatar ?? null,
    audio: {
      echoCancellation: el.inputEcho.checked,
      noiseSuppression: el.inputNoise.checked,
      autoGainControl: el.inputGain.checked,
      reducaoRuido: el.inputRuido.checked,
    },
  });

  await startMicrophone();
}

/**
 * Abre o popup "Entrar na sala": exige só a senha. O nome já foi digitado na
 * tela principal, então se estiver vazio a gente para aqui e pede o nome.
 */
function abrirEntrar(sala) {
  if (!el.inputName.value.trim()) {
    toast('Digite seu nome primeiro', 'error');
    el.inputName.focus();
    return;
  }

  state.salaSelecionada = sala.id;
  el.entrarNome.textContent = sala.nome;
  el.connectError.classList.add('hidden');

  // Se a senha desta mesma sala ficou lembrada, já vem preenchida.
  const lembrouEsta = state.settings?.rememberPassword && state.settings?.roomId === sala.id;
  el.inputPassword.value = lembrouEsta ? state.settings.password ?? '' : '';
  el.inputRemember.checked = Boolean(state.settings?.rememberPassword);

  el.entrarModal.classList.remove('hidden');
  el.inputPassword.focus();
}

el.entrarForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.connectError.classList.add('hidden');
  el.btnConnect.disabled = true;
  el.btnConnect.textContent = 'Conectando...';

  try {
    await entrarNaSala({ roomId: state.salaSelecionada, password: el.inputPassword.value });
    closeModal('entrar-modal');
  } catch (error) {
    console.error('[app] falha ao entrar:', error);
    el.connectError.textContent = error.message;
    el.connectError.classList.remove('hidden');
    el.entrarModal.classList.remove('hidden');
    await room.leave().catch(() => {});
  } finally {
    el.btnConnect.disabled = false;
    el.btnConnect.textContent = 'Entrar';
  }
});

// ----------------------------------------------------------------------------
// Criar sala
// ----------------------------------------------------------------------------

el.btnOpenCreate.addEventListener('click', () => {
  if (!el.inputName.value.trim()) {
    toast('Digite seu nome primeiro', 'error');
    el.inputName.focus();
    return;
  }
  el.createError.classList.add('hidden');
  el.createModal.classList.remove('hidden');
  el.createNome.focus();
});

el.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.createError.classList.add('hidden');

  const nome = el.createNome.value.trim();
  const senha = el.createSenha.value;

  if (senha !== el.createSenha2.value) {
    el.createError.textContent = 'As duas senhas não são iguais';
    el.createError.classList.remove('hidden');
    return;
  }

  el.btnCreate.disabled = true;
  el.btnCreate.textContent = 'Criando...';

  try {
    const sala = await criarSala(state.serverUrl, {
      nome,
      senha,
      displayName: el.inputName.value.trim(),
    });

    closeModal('create-modal');
    el.createForm.reset();
    state.salaSelecionada = sala.id;
    el.inputPassword.value = senha;

    await atualizarSalas();
    toast(`Sala "${sala.nome}" criada`, 'ok');

    el.connectError.classList.add('hidden');
    await entrarNaSala({ roomId: sala.id, password: senha });
  } catch (error) {
    console.error('[app] falha ao criar sala:', error);
    el.createError.textContent = error.message;
    el.createError.classList.remove('hidden');
    el.createModal.classList.remove('hidden');
    await room.leave().catch(() => {});
  } finally {
    el.btnCreate.disabled = false;
    el.btnCreate.textContent = 'Criar e entrar';
  }
});

// ----------------------------------------------------------------------------
// Convites: gerar o link (dentro da sala) e entrar por ele (fora dela)
// ----------------------------------------------------------------------------

function horasRestantes(expiraEm) {
  return Math.max(1, Math.round((expiraEm - Date.now()) / 3_600_000));
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // Fallback para quando a permissão de área de transferência falha.
    el.inviteUrl.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

el.btnInvite.addEventListener('click', async () => {
  el.inviteError.classList.add('hidden');
  el.inviteSala.textContent = el.roomTitle.textContent || 'esta sala';
  el.inviteUrl.value = 'gerando o link...';
  el.inviteValidade.textContent = '';
  el.inviteModal.classList.remove('hidden');

  try {
    const convite = await room.request('criarConvite');
    el.inviteUrl.value = convite.url;
    el.inviteValidade.textContent = `O link vale por mais ${horasRestantes(convite.expiraEm)} horas.`;
    el.inviteUrl.select();

    if (await copiarTexto(convite.url)) toast('Link copiado. É só colar no grupo.', 'ok');
  } catch (error) {
    console.error('[app] falha ao gerar convite:', error);
    el.inviteUrl.value = '';
    el.inviteError.textContent = error.message;
    el.inviteError.classList.remove('hidden');
  }
});

el.btnInviteCopy.addEventListener('click', async () => {
  if (!el.inviteUrl.value) return;
  toast(
    (await copiarTexto(el.inviteUrl.value))
      ? 'Link copiado'
      : 'Não consegui copiar. Selecione o link e use Ctrl+C.',
    'ok',
  );
});

/** @returns {{token: string, servidor: string|null}|null} */
function lerConvite(url) {
  try {
    const alvo = new URL(String(url));
    if (alvo.protocol !== 'pinduccall:') return null;
    const token = alvo.searchParams.get('t');
    if (!token) return null;
    return { token, servidor: alvo.searchParams.get('srv') };
  } catch {
    return null;
  }
}

/** Convite aguardando o convidado escolher um nome. */
let conviteEmEspera = null;
let entrandoPorConvite = false;

async function entrarPorConvite(url) {
  const dados = lerConvite(url);
  if (!dados) return;

  if (state.connected) {
    toast('Você já está numa sala. Saia dela antes de usar um convite.', 'info', 7000);
    return;
  }
  if (entrandoPorConvite) return;
  entrandoPorConvite = true;

  try {
    // O link carrega o servidor: assim ele funciona mesmo para quem tem o app
    // apontado para outro lugar.
    if (dados.servidor) {
      state.serverUrl = normalizeServerUrl(dados.servidor);
      await window.pinducall.settings.set({ serverUrl: state.serverUrl });
      mostrarEnderecoServidor();
    }

    const sala = await verConvite(state.serverUrl, dados.token);

    // Primeira vez no app: só falta o nome.
    if (!el.inputName.value.trim()) {
      conviteEmEspera = { sala, token: dados.token };
      el.guestSala.textContent = sala.nome;
      el.guestError.classList.add('hidden');
      el.guestNome.value = '';
      el.guestModal.classList.remove('hidden');
      el.guestNome.focus();
      return;
    }

    await entrarNaSala({ roomId: sala.roomId, convite: dados.token });
  } catch (error) {
    console.error('[app] convite falhou:', error);
    toast(error.message, 'error', 8000);
    await room.leave().catch(() => {});
  } finally {
    entrandoPorConvite = false;
    if (!state.connected) atualizarSalas();
  }
}

el.guestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!conviteEmEspera) return;

  const nome = el.guestNome.value.trim();
  if (!nome) return;

  el.guestError.classList.add('hidden');
  el.btnGuestEnter.disabled = true;
  el.btnGuestEnter.textContent = 'Entrando...';

  try {
    await entrarNaSala({
      roomId: conviteEmEspera.sala.roomId,
      convite: conviteEmEspera.token,
      nome,
    });
    closeModal('guest-modal');
    conviteEmEspera = null;
  } catch (error) {
    console.error('[app] falha ao entrar pelo convite:', error);
    el.guestError.textContent = error.message;
    el.guestError.classList.remove('hidden');
    await room.leave().catch(() => {});
  } finally {
    el.btnGuestEnter.disabled = false;
    el.btnGuestEnter.textContent = 'Entrar na sala';
  }
});

el.btnGuestCancel.addEventListener('click', () => {
  conviteEmEspera = null;
  closeModal('guest-modal');
});

window.pinducall.onDeepLink?.((url) => entrarPorConvite(url));

async function startMicrophone() {
  try {
    const stream = await room.startMic(state.settings.inputDeviceId ?? 'default');
    micMeter.start(stream, (level) => {
      el.micMeterFill.style.width = `${Math.round(level * 100)}%`;
      el.selfAvatar.classList.toggle('avatar--speaking', level > 0.06 && !room.state.micMuted);
    });
    await refreshDeviceLists();
  } catch (error) {
    console.error('[app] microfone indisponivel:', error);
    toast(`Não consegui abrir o microfone: ${error.message}`, 'error', 8000);
  }
}

// =============================================================================
// Transicao para a sala
// =============================================================================

room.on('joined', (result) => {
  state.connected = true;
  state.peers.clear();
  for (const peer of result.peers) state.peers.set(peer.id, peer);

  // Sub-salas: começo sempre no canal principal.
  state.canais = result.canais ?? [{ id: 'principal', nome: 'Principal', fixo: true, count: 0 }];
  state.selfChannel = 'principal';
  state.openPeerPanel = null;
  esconderCriarCanal();

  // O limite real vem do servidor, não das preferências locais.
  if (state.settings) state.settings.maxPeers = result.maxPeers;

  el.connectScreen.classList.add('hidden');
  el.roomScreen.classList.remove('hidden');

  el.roomTitle.textContent = result.roomName || `#${result.roomId}`;
  el.selfName.textContent = state.selfName;
  state.selfPeerId = result.peerId;
  aplicarAvatar(el.selfAvatar, {
    id: result.peerId,
    name: state.selfName,
    avatar: state.settings?.avatar,
  });

  el.chatMessages.innerHTML = '';
  state.lastChatAuthor = null;
  for (const message of result.chatHistory ?? []) appendChatMessage(message, false);
  appendSystemMessage(`Você entrou em #${result.roomId}.`);
  scrollChatToBottom();

  renderPeers();
  el.chatInput.focus();

  // O painel do Tibia só existe dentro da sala.
  tibia = new TibiaPanel({
    room,
    toast,
    settings: state.settings,
    onSettingsChange: (patch) => window.pinducall.settings.set(patch),
  });

  Promise.all([room.request('tibiaGetState'), room.request('djGetState')])
    .then(([timers, dj]) => {
      tibia.aplicarEstado(timers);
      tibia.aplicarDj(dj);
    })
    .catch((error) => console.warn('[app] não consegui carregar o painel do Tibia:', error.message));

  // O Chromium exige um gesto do usuário antes do primeiro som; entrar conta.
  prepararAudio();
});

room.on('peerJoined', (peer) => {
  state.peers.set(peer.id, peer);
  renderPeers();
  appendSystemMessage(`${peer.displayName} entrou na sala.`);
  tocarEntrada();
});

room.on('peerLeft', ({ peerId }) => {
  const peer = state.peers.get(peerId);
  state.peers.delete(peerId);
  playback.removeByPeer(peerId);
  removeTilesOfPeer(peerId);
  renderPeers();
  if (peer) {
    appendSystemMessage(`${peer.displayName} saiu da sala.`);
    tocarSaida();
  }
});

room.on('peerUpdated', ({ peerId, state: peerState }) => {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.state = { ...peer.state, ...peerState };
  renderPeers();
});

room.on('speaking', ({ peerId, volume }) => {
  const node = el.peerList.querySelector(`[data-peer-id="${peerId}"]`);
  if (!node) return;

  const avatar = node.querySelector('.avatar');
  const speaking = volume !== null && volume !== undefined;

  avatar?.classList.toggle('avatar--speaking', speaking);
  node.classList.toggle('peer--speaking', speaking);
});

room.on('canais', (canais) => {
  state.canais = Array.isArray(canais) && canais.length ? canais : state.canais;
  renderPeers();
});

room.on('canalEntrou', ({ canal }) => {
  state.selfChannel = canal;
  state.openPeerPanel = null;
  renderPeers();
  const nome = state.canais.find((c) => c.id === canal)?.nome ?? 'sub-sala';
  toast(`Você está agora em: ${nome}`, 'ok');
  tocarTroca();
});

room.on('chat', (message) => {
  appendChatMessage(message, true);
  if (message.peerId !== room.peerId) window.pinducall.app.flashTaskbar();
});

room.on('warning', (message) => toast(message, 'warn', 7000));

// A rede de segurança do RNNoise desligou a redução sozinha (estava mudo):
// reflete isso no toggle e nas preferências.
room.on('ruidoRevertido', () => {
  el.inputRuido.checked = false;
  if (state.settings) state.settings.reducaoRuido = false;
  window.pinducall.settings.set({ reducaoRuido: false });
});

room.on('localState', (localState) => {
  el.btnMic.innerHTML = localState.micMuted ? icons.micOff : icons.mic;
  el.btnMic.classList.toggle('icon-btn--on', localState.micMuted);

  el.btnDeafen.innerHTML = localState.deafened ? icons.headphonesOff : icons.headphones;
  el.btnDeafen.classList.toggle('icon-btn--on', localState.deafened);

  el.btnShare.textContent = localState.screenSharing ? 'Parar de compartilhar' : 'Compartilhar tela';
  el.btnShare.classList.toggle('btn--primary', !localState.screenSharing);
  el.btnShare.classList.toggle('btn--ghost', localState.screenSharing);

  // Texto curto: a barra inferior é estreita e não pode quebrar em várias linhas.
  // O compartilhamento não entra aqui porque a prévia já o deixa evidente.
  if (localState.deafened) el.selfStatus.textContent = 'Som desligado';
  else if (localState.micMuted) el.selfStatus.textContent = 'Microfone mudo';
  else el.selfStatus.textContent = 'Conectado';
});

room.on('disconnected', ({ reason }) => {
  if (!state.connected) return;
  state.connected = false;

  el.connectionDot.className = 'dot dot--bad';
  el.connectionDot.title = 'Desconectado';
  toast(reason, 'error', 9000);
  appendSystemMessage('Conexão perdida. Feche e entre de novo quando o servidor voltar.');
});

// =============================================================================
// Prévia da própria tela (monitoramento do que você está enviando)
// =============================================================================

const shareMonitor = {
  timer: null,
  previous: null,
};

function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1).replace('.', ',')} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/**
 * Lê as estatísticas reais do envio a cada 2s e mostra na barrinha da prévia.
 * É o que sai da sua máquina, não o que você configurou: se a rede apertar e o
 * WebRTC baixar a resolução sozinho, você vê acontecer aqui.
 */
async function updateShareStats() {
  try {
    const current = await room.getScreenShareStats();
    if (!current) return;

    const parts = [];

    if (current.width > 0) parts.push(`${current.width}x${current.height}`);
    if (current.framesPerSecond > 0) parts.push(`${Math.round(current.framesPerSecond)} fps`);

    if (shareMonitor.previous) {
      const deltaBits = (current.bytesSent - shareMonitor.previous.bytesSent) * 8;
      const deltaSeconds = (current.at - shareMonitor.previous.at) / 1000;
      const bitrate = formatBitrate(deltaBits / deltaSeconds);
      if (bitrate) parts.push(bitrate);
    }

    shareMonitor.previous = current;
    el.selfPreviewStats.textContent = parts.length > 0 ? parts.join(' · ') : 'conectando...';
  } catch (error) {
    console.warn('[app] não consegui ler as estatísticas do envio:', error.message);
  }
}

room.on('localScreen', ({ stream }) => {
  el.selfPreviewVideo.srcObject = stream;
  el.selfPreviewVideo.play().catch(() => {});
  el.selfPreview.classList.remove('hidden');

  el.selfPreviewStats.textContent = 'iniciando...';
  shareMonitor.previous = null;

  clearInterval(shareMonitor.timer);
  shareMonitor.timer = setInterval(updateShareStats, 2000);
  setTimeout(updateShareStats, 700);
});

room.on('localScreenEnded', () => {
  clearInterval(shareMonitor.timer);
  shareMonitor.timer = null;
  shareMonitor.previous = null;

  el.selfPreviewVideo.srcObject = null;
  el.selfPreview.classList.add('hidden');
  el.selfPreview.classList.remove('self-preview--large');
  el.btnPreviewSize.innerHTML = icons.expand;
  el.btnPreviewSize.title = 'Ampliar prévia';
});

el.btnPreviewSize.addEventListener('click', () => {
  const large = el.selfPreview.classList.toggle('self-preview--large');
  el.btnPreviewSize.innerHTML = large ? icons.shrink : icons.expand;
  el.btnPreviewSize.title = large ? 'Reduzir prévia' : 'Ampliar prévia';
});

el.btnPreviewStop.addEventListener('click', () => {
  room.stopScreenShare().catch((error) => toast(error.message, 'error'));
});

// =============================================================================
// Mídia recebida
// =============================================================================

room.on('track', ({ consumerId, peerId, source, kind, track }) => {
  if (kind === 'audio') {
    playback.add(consumerId, peerId, track);
    // Guarda o áudio da tela separado do microfone: dá pra ter volume próprio.
    if (source === 'screen-audio') state.screenAudioByPeer.set(peerId, consumerId);
    return;
  }

  if (source === 'screen') addScreenTile(consumerId, peerId, track);
});

room.on('trackEnded', ({ consumerId }) => {
  playback.remove(consumerId);
  removeTile(consumerId);
  state.hiddenTiles.delete(consumerId);
  for (const [pid, cid] of state.screenAudioByPeer) {
    if (cid === consumerId) state.screenAudioByPeer.delete(pid);
  }
});

function addScreenTile(consumerId, peerId, track) {
  const peer = state.peers.get(peerId);
  const name = peer?.displayName ?? 'Alguém';

  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.consumerId = consumerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // o audio da tela vem por um consumer separado
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});

  const label = document.createElement('div');
  label.className = 'tile__label';
  label.innerHTML = `<span class="live"></span><span>${escapeHtml(name)}</span>`;

  const ctrls = document.createElement('div');
  ctrls.className = 'tile__ctrls';

  // Volume da tela (áudio compartilhado) — abre o menu com o slider.
  const btnVol = document.createElement('button');
  btnVol.type = 'button';
  btnVol.className = 'tile__ctrl';
  btnVol.title = 'Volume da tela';
  btnVol.innerHTML = icons.volume;
  btnVol.addEventListener('click', (event) => {
    event.stopPropagation();
    const r = btnVol.getBoundingClientRect();
    menuDoVideo(r.left, r.bottom + 6, consumerId);
  });

  // Não assistir: oculta o vídeo e para de receber (economiza banda).
  const btnHide = document.createElement('button');
  btnHide.type = 'button';
  btnHide.className = 'tile__ctrl';
  btnHide.title = 'Não assistir (ocultar)';
  btnHide.innerHTML = icons.eyeOff;
  btnHide.addEventListener('click', (event) => {
    event.stopPropagation();
    alternarOcultarTile(consumerId);
  });

  // Botão de tela cheia: joga a transmissão da pessoa em tela cheia de verdade.
  const btnFull = document.createElement('button');
  btnFull.type = 'button';
  btnFull.className = 'tile__ctrl tile__ctrl--full';
  btnFull.title = 'Tela cheia';
  btnFull.innerHTML = icons.expand;
  btnFull.addEventListener('click', (event) => {
    event.stopPropagation();
    alternarTelaCheia(tile);
  });

  ctrls.append(btnVol, btnHide, btnFull);

  // Capa de "vídeo oculto": aparece quando a pessoa escolhe não assistir.
  const capa = document.createElement('button');
  capa.type = 'button';
  capa.className = 'tile__oculto';
  capa.innerHTML = `<span class="tile__oculto-ico">${icons.eyeOff}</span><span>Vídeo oculto</span><small>clique para assistir</small>`;
  capa.addEventListener('click', (event) => {
    event.stopPropagation();
    alternarOcultarTile(consumerId);
  });

  tile.append(video, label, ctrls, capa);
  tile.addEventListener('click', () => {
    if (!state.hiddenTiles.has(consumerId)) toggleFocus(consumerId);
  });
  // Duplo clique no vídeo também entra/sai de tela cheia (atalho do costume).
  video.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    alternarTelaCheia(tile);
  });
  // Clique direito: menu com volume da tela, ocultar e tela cheia.
  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    menuDoVideo(event.clientX, event.clientY, consumerId);
  });

  el.stageGrid.append(tile);
  state.tiles.set(consumerId, { consumerId, peerId, element: tile });

  updateStageLayout();
}

/** Liga/desliga o "não assistir" de um vídeo: oculta e pausa (ou volta). */
function alternarOcultarTile(consumerId) {
  const info = state.tiles.get(consumerId);
  if (!info) return;

  if (state.hiddenTiles.has(consumerId)) {
    state.hiddenTiles.delete(consumerId);
    room.retomarConsumer(consumerId).catch(() => {});
  } else {
    state.hiddenTiles.add(consumerId);
    room.pausarConsumer(consumerId).catch(() => {});
    if (state.focusedTile === consumerId) state.focusedTile = null;
  }

  info.element.classList.toggle('tile--oculto', state.hiddenTiles.has(consumerId));
  const botao = info.element.querySelector('.tile__ctrl[title^="Não assistir"], .tile__ctrl[title^="Assistir"]');
  if (botao) {
    const oculto = state.hiddenTiles.has(consumerId);
    botao.title = oculto ? 'Assistir de novo' : 'Não assistir (ocultar)';
    botao.innerHTML = oculto ? icons.eye : icons.eyeOff;
  }
  updateStageLayout();
}

/** Menu de contexto de um vídeo compartilhado. */
function menuDoVideo(x, y, consumerId) {
  const info = state.tiles.get(consumerId);
  if (!info) return;
  const nome = state.peers.get(info.peerId)?.displayName ?? 'alguém';
  const oculto = state.hiddenTiles.has(consumerId);
  const audioCid = state.screenAudioByPeer.get(info.peerId);

  const itens = [
    { tipo: 'titulo', texto: `Tela de ${nome}` },
    {
      tipo: 'botao',
      rotulo: oculto ? 'Voltar a assistir' : 'Não assistir (ocultar)',
      icone: oculto ? icons.eye : icons.eyeOff,
      aoClicar: () => alternarOcultarTile(consumerId),
    },
  ];

  if (audioCid) {
    const mudoTela = playback.isConsumerMuted(audioCid);
    itens.push({
      tipo: 'botao',
      rotulo: mudoTela ? 'Ativar som da tela' : 'Mudo no som da tela',
      icone: mudoTela ? icons.volumeOff : icons.volume,
      aoClicar: () => playback.setConsumerMuted(audioCid, !mudoTela),
    });
    itens.push({
      tipo: 'range',
      rotulo: 'Volume da tela',
      valor: playback.getConsumerVolume(audioCid),
      aoAlterar: (v) => {
        if (v > 0 && playback.isConsumerMuted(audioCid)) playback.setConsumerMuted(audioCid, false);
        playback.setConsumerVolume(audioCid, v);
      },
    });
  } else {
    itens.push({ tipo: 'titulo', texto: 'Esta tela está sem som' });
  }

  itens.push({ tipo: 'separador' });
  itens.push({
    tipo: 'botao',
    rotulo: 'Tela cheia',
    icone: icons.expand,
    aoClicar: () => alternarTelaCheia(info.element),
  });

  abrirMenuContexto(x, y, itens);
}

function removeTile(consumerId) {
  const tile = state.tiles.get(consumerId);
  if (!tile) return;

  const video = tile.element.querySelector('video');
  if (video) video.srcObject = null;

  tile.element.remove();
  state.tiles.delete(consumerId);

  if (state.focusedTile === consumerId) state.focusedTile = null;
  updateStageLayout();
}

function removeTilesOfPeer(peerId) {
  for (const [consumerId, tile] of state.tiles) {
    if (tile.peerId === peerId) removeTile(consumerId);
  }
}

/** Destaca a tela compartilhada de uma pessoa (clicando nela na lista). */
function focarTelaDoPeer(peerId) {
  const tile = [...state.tiles.values()].find((t) => t.peerId === peerId);
  if (!tile) {
    toast('A tela dessa pessoa ainda está chegando — tenta de novo num instante.', 'info');
    return;
  }
  state.focusedTile = tile.consumerId;
  updateStageLayout();
  tile.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function toggleFocus(consumerId) {
  state.focusedTile = state.focusedTile === consumerId ? null : consumerId;
  updateStageLayout();
}

/** Entra em tela cheia com o elemento dado, ou sai se já estiver em tela cheia. */
function alternarTelaCheia(elemento) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    elemento.requestFullscreen?.().catch((erro) => {
      console.warn('[app] não consegui entrar em tela cheia:', erro?.message);
    });
  }
}

// Troca o ícone do botão (expandir <-> encolher) conforme entra/sai de tela cheia.
document.addEventListener('fullscreenchange', () => {
  const emTela = document.fullscreenElement;
  for (const { element } of state.tiles.values()) {
    const botao = element.querySelector('.tile__ctrl--full');
    if (botao) botao.innerHTML = element === emTela ? icons.shrink : icons.expand;
  }
});

function updateStageLayout() {
  const count = state.tiles.size;
  el.stageEmpty.classList.toggle('hidden', count > 0);

  el.stageGrid.classList.remove('stage__grid--two', 'stage__grid--many');
  if (!state.focusedTile) {
    if (count === 2) el.stageGrid.classList.add('stage__grid--two');
    else if (count > 2) el.stageGrid.classList.add('stage__grid--many');
  }

  for (const [consumerId, tile] of state.tiles) {
    const focused = state.focusedTile === consumerId;
    tile.element.classList.toggle('tile--focused', focused);
    tile.element.classList.toggle('hidden', Boolean(state.focusedTile) && !focused);
  }

  if (count === 0) {
    el.stageTitle.textContent = 'Ninguém está compartilhando a tela';
  } else {
    const names = [...state.tiles.values()]
      .map((tile) => state.peers.get(tile.peerId)?.displayName ?? 'Alguém')
      .join(', ');
    el.stageTitle.textContent = `Compartilhando: ${names}`;
  }
}

// =============================================================================
// Menu de contexto (clique direito) — participantes e vídeos
// =============================================================================

let menuAberto = null;

function fecharMenuContexto() {
  if (!menuAberto) return;
  menuAberto.remove();
  menuAberto = null;
  document.removeEventListener('mousedown', aoClicarForaDoMenu, true);
  document.removeEventListener('keydown', aoTeclarNoMenu, true);
  window.removeEventListener('blur', fecharMenuContexto);
}

function aoClicarForaDoMenu(ev) {
  if (menuAberto && !menuAberto.contains(ev.target)) fecharMenuContexto();
}

function aoTeclarNoMenu(ev) {
  if (ev.key === 'Escape') fecharMenuContexto();
}

/**
 * Abre um menu flutuante em (x, y). Cada item pode ser:
 *   { tipo: 'botao', rotulo, icone?, perigo?, aoClicar }
 *   { tipo: 'range', rotulo, valor(0..1), aoAlterar }
 *   { tipo: 'titulo', texto }
 *   { tipo: 'separador' }
 */
function abrirMenuContexto(x, y, itens) {
  fecharMenuContexto();

  const menu = document.createElement('div');
  menu.className = 'ctxmenu';

  for (const item of itens) {
    if (item.tipo === 'titulo') {
      const t = document.createElement('div');
      t.className = 'ctxmenu__titulo';
      t.textContent = item.texto;
      menu.append(t);
    } else if (item.tipo === 'separador') {
      const s = document.createElement('div');
      s.className = 'ctxmenu__sep';
      menu.append(s);
    } else if (item.tipo === 'range') {
      const linha = document.createElement('div');
      linha.className = 'ctxmenu__range';

      const topo = document.createElement('div');
      topo.className = 'ctxmenu__range-topo';
      const rot = document.createElement('span');
      rot.textContent = item.rotulo;
      const val = document.createElement('span');
      val.className = 'ctxmenu__range-val';
      topo.append(rot, val);

      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.value = String(Math.round((item.valor ?? 1) * 100));
      const pintar = () => (val.textContent = `${range.value}%`);
      pintar();
      range.addEventListener('input', () => {
        item.aoAlterar?.(Number(range.value) / 100);
        pintar();
      });
      // Mexer no slider não fecha o menu.
      range.addEventListener('mousedown', (e) => e.stopPropagation());

      linha.append(topo, range);
      menu.append(linha);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctxmenu__item' + (item.perigo ? ' ctxmenu__item--perigo' : '');
      btn.innerHTML =
        (item.icone ? `<span class="ctxmenu__ico">${item.icone}</span>` : '') +
        `<span>${escapeHtml(item.rotulo)}</span>`;
      btn.addEventListener('click', () => {
        item.aoClicar?.();
        fecharMenuContexto();
      });
      menu.append(btn);
    }
  }

  // Coloca na tela sem estourar as bordas.
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const px = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  const py = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  menu.style.visibility = 'visible';

  menuAberto = menu;
  // Espera um tick pra não capturar o próprio clique que abriu o menu.
  setTimeout(() => {
    if (!menuAberto) return;
    document.addEventListener('mousedown', aoClicarForaDoMenu, true);
    document.addEventListener('keydown', aoTeclarNoMenu, true);
    window.addEventListener('blur', fecharMenuContexto);
  }, 0);
}

/** Menu de contexto de um participante: mutar só pra mim + volume. */
function abrirMenuPeer(x, y, membro) {
  const mudo = playback.isPeerMuted(membro.id);
  abrirMenuContexto(x, y, [
    { tipo: 'titulo', texto: membro.displayName },
    {
      tipo: 'botao',
      rotulo: mudo ? 'Ouvir de novo' : 'Silenciar só pra mim',
      icone: mudo ? icons.volumeOff : icons.volume,
      aoClicar: () => {
        playback.setPeerMuted(membro.id, !mudo);
        renderPeers();
      },
    },
    {
      tipo: 'range',
      rotulo: 'Volume',
      valor: playback.getPeerVolume(membro.id),
      aoAlterar: (v) => {
        if (v > 0 && playback.isPeerMuted(membro.id)) playback.setPeerMuted(membro.id, false);
        playback.setPeerVolume(membro.id, v);
      },
    },
  ]);
}

// =============================================================================
// Lista de participantes
// =============================================================================

function renderPeers() {
  el.peerList.innerHTML = '';

  // O "eu" também vira um membro, para aparecer dentro da minha sub-sala.
  const eu = state.selfPeerId && {
    id: state.selfPeerId,
    displayName: state.selfName,
    isSelf: true,
    state: {
      channel: state.selfChannel,
      avatar: state.settings?.avatar ?? null,
      micMuted: room.state?.micMuted,
      deafened: room.state?.deafened,
      screenSharing: room.state?.screenSharing,
    },
  };

  // Agrupa todo mundo por sub-sala.
  const porCanal = new Map();
  const empurrar = (m) => {
    const c = m.state?.channel ?? 'principal';
    if (!porCanal.has(c)) porCanal.set(c, []);
    porCanal.get(c).push(m);
  };
  for (const peer of state.peers.values()) empurrar(peer);
  if (eu) empurrar(eu);

  // Ordena as sub-salas: principal primeiro, depois por nome.
  const canais = [...state.canais].sort((a, b) => {
    if (a.id === 'principal') return -1;
    if (b.id === 'principal') return 1;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  // Só mostra os cabeçalhos de sub-sala quando existe mais de uma.
  const agrupar = canais.length > 1;

  for (const canal of canais) {
    const membros = (porCanal.get(canal.id) ?? []).sort((a, b) => {
      if (a.isSelf) return -1;
      if (b.isSelf) return 1;
      return a.displayName.localeCompare(b.displayName, 'pt-BR');
    });

    if (agrupar) el.peerList.append(criarCabecalhoCanal(canal, membros.length));

    for (const membro of membros) {
      el.peerList.append(criarLinhaPeer(membro));
    }
  }

  const total = state.peers.size + 1;
  el.roomCount.textContent = `${total} / ${state.settings?.maxPeers ?? 10} conectados`;
}

/** Cabeçalho de uma sub-sala. Clicar no título entra nela. */
function criarCabecalhoCanal(canal, count) {
  const li = document.createElement('li');
  li.className = 'canal';
  const atual = canal.id === state.selfChannel;

  if (atual) {
    li.classList.add('canal--atual');
  } else {
    li.classList.add('canal--clicavel');
    li.title = 'Clique para entrar nesta sub-sala';
    li.addEventListener('click', () => entrarSubSala(canal.id));
  }

  const nome = document.createElement('span');
  nome.className = 'canal__nome';
  nome.innerHTML = `${icons.users}<span>${escapeHtml(canal.nome)}</span>`;

  const cont = document.createElement('span');
  cont.className = 'canal__count';
  cont.textContent = String(count);

  li.append(nome, cont);
  return li;
}

/** Uma linha de participante (funciona para os outros e para você). */
function criarLinhaPeer(membro) {
  const item = document.createElement('li');
  item.className = 'peer';
  if (membro.isSelf) item.classList.add('peer--self');
  item.dataset.peerId = membro.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  aplicarAvatar(avatar, { id: membro.id, name: membro.displayName, avatar: membro.state?.avatar });

  const name = document.createElement('div');
  name.className = 'peer__name';

  if (membro.state?.screenSharing) {
    const rec = document.createElement('span');
    rec.className = 'peer__rec';
    rec.innerHTML = '<span class="peer__rec-dot"></span>REC';
    name.append(rec);
  }
  const nomeTexto = document.createElement('span');
  nomeTexto.className = 'peer__name-txt';
  nomeTexto.textContent = membro.isSelf ? `${membro.displayName} (você)` : membro.displayName;
  name.append(nomeTexto);

  const badges = document.createElement('div');
  badges.className = 'peer__badges';
  if (membro.state?.deafened) {
    const badge = document.createElement('span');
    badge.className = 'peer__badge--muted';
    badge.title = 'Com o som desligado';
    badge.innerHTML = icons.headphonesOff;
    badges.append(badge);
  } else if (membro.state?.micMuted) {
    const badge = document.createElement('span');
    badge.className = 'peer__badge--muted';
    badge.title = 'Microfone mudo';
    badge.innerHTML = icons.micOff;
    badges.append(badge);
  }

  item.append(avatar, name, badges);

  // Controles de quem NÃO é você: mudo rápido + clique direito p/ volume.
  if (!membro.isSelf) {
    const ctrls = document.createElement('div');
    ctrls.className = 'peer__ctrls';

    const mudo = playback.isPeerMuted(membro.id);
    const btnMudo = document.createElement('button');
    btnMudo.className = 'peer__ctrl' + (mudo ? ' peer__ctrl--on' : '');
    btnMudo.title = mudo ? 'Ouvir de novo' : 'Silenciar só pra mim';
    btnMudo.innerHTML = mudo ? icons.volumeOff : icons.volume;
    btnMudo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      playback.setPeerMuted(membro.id, !playback.isPeerMuted(membro.id));
      renderPeers();
    });

    ctrls.append(btnMudo);
    item.append(ctrls);

    // No lugar da antiga engrenagem: clique direito abre mutar + volume.
    item.classList.add('peer--menu');
    item.title = 'Clique direito para volume e opções';
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      abrirMenuPeer(ev.clientX, ev.clientY, membro);
    });
  }

  // Quem compartilha vira clicável: leva a tela dessa pessoa para o destaque.
  if (membro.state?.screenSharing && !membro.isSelf) {
    item.classList.add('peer--sharing');
    item.title = 'Compartilhando a tela — clique para assistir';
    item.addEventListener('click', () => focarTelaDoPeer(membro.id));
  }

  return item;
}

// =============================================================================
// Sub-salas (canais de voz)
// =============================================================================

async function entrarSubSala(canalId) {
  if (canalId === state.selfChannel) return;
  try {
    await room.entrarCanal(canalId);
  } catch (error) {
    toast(`Não consegui entrar na sub-sala: ${error.message}`, 'warn');
  }
}

async function criarSubSala(nome) {
  const limpo = String(nome ?? '').trim();
  if (!limpo) {
    el.inputCanal?.focus();
    return;
  }
  try {
    await room.criarCanal(limpo);
    esconderCriarCanal();
  } catch (error) {
    toast(`Não consegui criar a sub-sala: ${error.message}`, 'warn');
  }
}

function mostrarCriarCanal() {
  state.criandoCanal = true;
  el.canalCriar?.classList.remove('hidden');
  if (el.inputCanal) {
    el.inputCanal.value = '';
    el.inputCanal.focus();
  }
}

function esconderCriarCanal() {
  state.criandoCanal = false;
  el.canalCriar?.classList.add('hidden');
  if (el.inputCanal) el.inputCanal.value = '';
}

// =============================================================================
// Chat
// =============================================================================

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = el.chatMessages;
  return scrollHeight - scrollTop - clientHeight < 120;
}

function scrollChatToBottom() {
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function appendChatMessage(message, autoScroll = true) {
  const stick = autoScroll && isNearBottom();

  // Agrupa mensagens seguidas da mesma pessoa em até 5 minutos.
  const grouped =
    state.lastChatAuthor === message.peerId && message.sentAt - state.lastChatAt < 5 * 60_000;

  const node = document.createElement('div');
  node.className = grouped ? 'msg msg--grouped' : 'msg';

  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'msg__head';

    const author = document.createElement('span');
    author.className = 'msg__author';
    author.textContent = message.displayName;
    author.style.color = authorColorFor(message.peerId);

    const time = document.createElement('span');
    time.className = 'msg__time';
    time.textContent = formatTime(message.sentAt);

    head.append(author, time);
    node.append(head);
  }

  node.append(message.arquivo ? cartaoDeArquivo(message.arquivo) : textoDaMensagem(message));

  el.chatMessages.append(node);
  state.lastChatAuthor = message.peerId;
  state.lastChatAt = message.sentAt;

  if (stick) scrollChatToBottom();
}

function textoDaMensagem(message) {
  const text = document.createElement('div');
  text.className = 'msg__text';
  text.textContent = message.text;
  return text;
}

function formatarTamanho(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ICONES_ARQUIVO = [
  [/\.(png|jpe?g|gif|webp|bmp|svg)$/i, '🖼️'],
  [/\.(pdf)$/i, '📕'],
  [/\.(docx?|odt|rtf)$/i, '📘'],
  [/\.(xlsx?|csv|ods)$/i, '📗'],
  [/\.(pptx?|odp)$/i, '📙'],
  [/\.(zip|rar|7z|tar|gz)$/i, '🗜️'],
  [/\.(mp3|wav|ogg|flac|m4a)$/i, '🎵'],
  [/\.(mp4|mkv|avi|mov|webm)$/i, '🎬'],
  [/\.(txt|log|md|json)$/i, '📄'],
];

function iconeDoArquivo(nome) {
  for (const [padrao, icone] of ICONES_ARQUIVO) {
    if (padrao.test(nome)) return icone;
  }
  return '📎';
}

/** Cartão de arquivo no chat: nome, tamanho, prazo e o botão de baixar. */
function cartaoDeArquivo(arquivo) {
  const cartao = document.createElement('div');
  cartao.className = 'arquivo';

  const icone = document.createElement('span');
  icone.className = 'arquivo__icone';
  icone.textContent = iconeDoArquivo(arquivo.nome);

  const corpo = document.createElement('div');
  corpo.className = 'arquivo__corpo';

  const nome = document.createElement('div');
  nome.className = 'arquivo__nome';
  nome.textContent = arquivo.nome;
  nome.title = arquivo.nome;

  const meta = document.createElement('div');
  meta.className = 'arquivo__meta';
  const restam = Math.max(0, Math.round((arquivo.expiraEm - Date.now()) / 3_600_000));
  meta.textContent = restam
    ? `${formatarTamanho(arquivo.tamanho)} · some em ${restam}h`
    : `${formatarTamanho(arquivo.tamanho)} · expirando`;

  corpo.append(nome, meta);

  const baixar = document.createElement('button');
  baixar.className = 'btn btn--ghost btn--sm arquivo__baixar';
  baixar.type = 'button';
  baixar.textContent = 'Baixar';
  baixar.addEventListener('click', () => {
    const base = state.serverUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    window.pinducall.app.openExternal(`${base}/arquivo/${arquivo.token}`);
  });

  cartao.append(icone, corpo, baixar);
  return cartao;
}

function appendSystemMessage(text) {
  const stick = isNearBottom();

  const node = document.createElement('div');
  node.className = 'msg msg--system';

  const body = document.createElement('div');
  body.className = 'msg__text';
  body.textContent = text;
  node.append(body);

  el.chatMessages.append(node);
  state.lastChatAuthor = null;

  if (stick) scrollChatToBottom();
}

el.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;

  el.chatInput.value = '';
  try {
    await room.sendChat(text);
  } catch (error) {
    toast(error.message, 'error');
    el.chatInput.value = text;
  }
});

// =============================================================================
// Arquivos no chat
// =============================================================================

/** Fila de envios: um de cada vez, para a barra de progresso fazer sentido. */
const filaDeEnvio = [];
let envioAtual = null;

function mostrarBarra(nome) {
  el.uploadNome.textContent = nome;
  el.uploadFill.style.width = '0%';
  el.uploadBar.classList.remove('hidden');
}

function esconderBarra() {
  el.uploadBar.classList.add('hidden');
  el.uploadFill.style.width = '0%';
}

/**
 * Sobe um arquivo. O WebSocket pede a autorização e o conteúdo vai por HTTP —
 * XHR em vez de fetch porque só ele avisa o progresso do upload.
 */
function subirArquivo(url, file, aoProgresso) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    envioAtual = xhr;

    xhr.open('POST', url, true);
    xhr.responseType = 'json';
    xhr.setRequestHeader('content-type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (evento) => {
      if (evento.lengthComputable) aoProgresso(evento.loaded / evento.total);
    });

    xhr.addEventListener('load', () => {
      envioAtual = null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response ?? {});
      else reject(new Error(xhr.response?.erro ?? `O servidor recusou (${xhr.status})`));
    });

    xhr.addEventListener('error', () => {
      envioAtual = null;
      reject(new Error('A conexão caiu durante o envio'));
    });

    xhr.addEventListener('abort', () => {
      envioAtual = null;
      reject(new Error('Envio cancelado'));
    });

    xhr.send(file);
  });
}

async function processarFila() {
  if (envioAtual || filaDeEnvio.length === 0) return;

  const file = filaDeEnvio.shift();
  mostrarBarra(file.name);

  try {
    const permissao = await room.request('pedirEnvioDeArquivo', {
      nome: file.name,
      tamanho: file.size,
      tipo: file.type,
    });

    await subirArquivo(permissao.url, file, (fracao) => {
      el.uploadFill.style.width = `${Math.round(fracao * 100)}%`;
    });

    // A mensagem no chat vem do servidor pelo WebSocket; aqui é só o aviso.
    toast(`"${file.name}" enviado`, 'ok');
  } catch (error) {
    console.warn('[app] envio de arquivo falhou:', error.message);
    toast(error.message, 'error', 8000);
  } finally {
    esconderBarra();
    envioAtual = null;
    if (filaDeEnvio.length) processarFila();
  }
}

function enfileirarArquivos(lista) {
  if (!state.connected) {
    toast('Entre numa sala antes de mandar arquivo.', 'info');
    return;
  }

  const arquivos = [...lista].filter(Boolean);
  if (!arquivos.length) return;

  filaDeEnvio.push(...arquivos);
  processarFila();
}

el.btnAnexo.addEventListener('click', () => el.inputAnexo.click());

el.inputAnexo.addEventListener('change', () => {
  enfileirarArquivos(el.inputAnexo.files);
  el.inputAnexo.value = '';
});

el.uploadCancelar.addEventListener('click', () => {
  filaDeEnvio.length = 0;
  envioAtual?.abort();
});

// Arrastar e soltar em cima do chat.
let arrastando = 0;

el.chatPanel.addEventListener('dragenter', (event) => {
  if (!state.connected || !event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  arrastando += 1;
  el.chatDrop.classList.remove('hidden');
});

el.chatPanel.addEventListener('dragover', (event) => {
  if (!state.connected) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

el.chatPanel.addEventListener('dragleave', () => {
  arrastando = Math.max(0, arrastando - 1);
  if (arrastando === 0) el.chatDrop.classList.add('hidden');
});

el.chatPanel.addEventListener('drop', (event) => {
  event.preventDefault();
  arrastando = 0;
  el.chatDrop.classList.add('hidden');
  enfileirarArquivos(event.dataTransfer?.files ?? []);
});

// Soltar arquivo fora do chat não pode fazer o Electron navegar para ele.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

// =============================================================================
// Controles
// =============================================================================

el.btnMic.addEventListener('click', () => room.setMicMuted(!room.state.micMuted));

el.btnDeafen.addEventListener('click', async () => {
  const next = !room.state.deafened;
  await room.setDeafened(next);
  playback.setDeafened(next);
});

// Sub-salas: criar e cancelar.
el.btnCriarCanal?.addEventListener('click', () => {
  if (state.criandoCanal) esconderCriarCanal();
  else mostrarCriarCanal();
});
el.btnCanalCancel?.addEventListener('click', () => esconderCriarCanal());
el.btnCanalOk?.addEventListener('click', () => criarSubSala(el.inputCanal?.value));
el.inputCanal?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    criarSubSala(el.inputCanal.value);
  } else if (ev.key === 'Escape') {
    esconderCriarCanal();
  }
});

el.btnLeave.addEventListener('click', async () => {
  tibia?.encerrar();
  tibia = null;

  esconderCriarCanal();
  state.selfChannel = 'principal';
  state.openPeerPanel = null;

  await room.leave();
  playback.clear();
  micMeter.stop();

  for (const consumerId of [...state.tiles.keys()]) removeTile(consumerId);
  state.peers.clear();
  state.connected = false;

  el.roomScreen.classList.add('hidden');
  el.connectScreen.classList.remove('hidden');
  el.connectionDot.className = 'dot dot--ok';

  // A contagem de pessoas fica velha enquanto você está na sala.
  atualizarSalas();
});

el.btnToggleChat.addEventListener('click', () => {
  // Esconde só o chat: o painel do Tibia continua e ocupa a coluna inteira.
  const hidden = el.roomScreen.classList.toggle('chat-hidden');
  el.btnToggleChat.textContent = hidden ? 'Mostrar chat' : 'Ocultar chat';
});

window.pinducall.onToggleMute(() => {
  if (!state.connected) return;
  room.setMicMuted(!room.state.micMuted);
});

// Push-to-talk enquanto a janela estiver em foco: segure a barra de espaço.
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT') return;
  if (!state.connected || !room.state.micMuted) return;

  event.preventDefault();
  room.setMicMuted(false);
  el.selfStatus.textContent = 'Falando (push-to-talk)';
  document.body.dataset.pushToTalk = '1';
});

document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || document.body.dataset.pushToTalk !== '1') return;
  delete document.body.dataset.pushToTalk;
  room.setMicMuted(true);
});

// =============================================================================
// Compartilhamento de tela
// =============================================================================

el.btnShare.addEventListener('click', async () => {
  if (room.state.screenSharing) {
    await room.stopScreenShare();
    // Se estávamos transmitindo via OBS, desliga a câmera virtual dele também.
    window.pinducall.obs?.parar?.().catch(() => {});
    return;
  }
  await openScreenPicker();
});

async function openScreenPicker() {
  state.selectedSourceId = null;
  el.btnStartShare.disabled = true;
  el.sourceGrid.innerHTML = '<div class="source-grid__empty">Carregando telas e janelas...</div>';
  el.screenPicker.classList.remove('hidden');

  try {
    renderSources(await listarFontes());
  } catch (error) {
    el.sourceGrid.innerHTML = `<div class="source-grid__empty">Não consegui listar as telas: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Câmeras do computador, incluindo as virtuais (OBS, Streamlabs, ManyCam).
 *
 * A câmera virtual é a ponte para transmitir uma janela que o Windows proíbe
 * copiar: quem captura o jogo é o OBS, e o PinduCcall só lê o resultado, que
 * chega como uma câmera comum.
 */
async function listarCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  let dispositivos = await navigator.mediaDevices.enumerateDevices();

  // Sem permissão de câmera, os nomes vêm vazios e a lista fica inútil. Um
  // pedido rápido destrava os nomes; se a pessoa recusar, seguimos sem.
  if (dispositivos.some((d) => d.kind === 'videoinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((track) => track.stop());
      dispositivos = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // Segue com os nomes vazios; o rótulo genérico resolve.
    }
  }

  return dispositivos
    .filter((d) => d.kind === 'videoinput')
    .map((d, indice) => ({
      id: `camera:${d.deviceId}`,
      name: d.label || `Câmera ${indice + 1}`,
      kind: 'camera',
      thumbnail: null,
      appIcon: null,
      miniaturaVazia: false,
    }));
}

async function listarFontes() {
  const [telas, cameras] = await Promise.all([
    window.pinducall.screen.list(),
    listarCameras().catch(() => []),
  ]);
  return [...telas, ...cameras];
}

let cachedSources = [];

const DICA_CAMERA =
  'Serve para transmitir o que o Windows não deixa copiar. Programa com trava de cópia '
  + '(o Tibia, por exemplo) não pode ser capturado por ninguém de fora — mas se o OBS já '
  + 'consegue mostrar esse jogo, ligue nele a "Câmera Virtual" e escolha ela aqui: o OBS '
  + 'captura, o CAUCALL transmite.';

const DICA_GENERICA =
  'O Windows não conseguiu ler a imagem desta janela. Tente, nesta ordem: trocar o "Modo de ' +
  'captura de tela" nas Configurações, colocar o programa em "janela sem bordas", ou ' +
  'compartilhar a tela inteira pela aba Telas.';

/**
 * Explica o que fazer quando alguma janela da lista vier sem imagem. Se o
 * programa for conhecido (o Tibia, por exemplo), mostra a instrução dele em vez
 * do conselho genérico.
 */
async function mostrarDicaDeCaptura(fontes) {
  const cegas = fontes.filter((fonte) => fonte.miniaturaVazia);
  const conhecida = cegas.find((fonte) => fonte.dica);

  const escrever = (texto) => {
    el.sourceDica.textContent = texto;
    el.sourceDica.classList.toggle('hidden', texto === '');
  };

  if (state.sourceTab === 'camera') {
    escrever(DICA_CAMERA);
    atualizarBlocoObs();
    return;
  }

  el.obsAuto?.classList.add('hidden');

  // Primeiro o palpite barato, que aparece na hora.
  escrever(conhecida?.dica ?? (cegas.length > 0 ? DICA_GENERICA : ''));

  if (state.sourceTab !== 'window') return;

  // Depois a resposta certa, que custa uma consulta ao Windows: a trava de
  // cópia é uma propriedade da janela, então ela explica tanto a janela que
  // aparece preta quanto a que sumiu da lista — e diz o nome de qual é.
  try {
    const avisos = (await window.pinducall.screen.avisos?.(fontes.map((f) => f.name))) ?? [];
    // A pessoa pode ter trocado de aba enquanto a consulta ia e voltava.
    if (state.sourceTab !== 'window') return;
    if (avisos[0]) escrever(avisos[0].aviso);
  } catch {
    // Sem a consulta, fica valendo o palpite acima.
  }
}

function renderSources(sources) {
  cachedSources = sources ?? cachedSources;
  const filtered = cachedSources.filter((source) => source.kind === state.sourceTab);

  el.sourceGrid.innerHTML = '';

  if (filtered.length === 0) {
    el.sourceGrid.innerHTML = state.sourceTab === 'camera'
      ? '<div class="source-grid__empty">Nenhuma câmera encontrada. No OBS, clique em <b>Iniciar Câmera Virtual</b> e depois em "procurar de novo".</div>'
      : '<div class="source-grid__empty">Nada encontrado nesta aba.</div>';
    mostrarDicaDeCaptura([]).catch(() => {});
    return;
  }

  mostrarDicaDeCaptura(filtered).catch(() => {});

  for (const source of filtered) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source';
    button.dataset.sourceId = source.id;

    // Algumas fontes não devolvem miniatura; nesse caso mostramos um ícone
    // em vez de deixar um <img> quebrado na tela.
    let thumb;
    if (source.thumbnail) {
      thumb = document.createElement('img');
      thumb.className = 'source__thumb';
      thumb.src = source.thumbnail;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.className = 'source__thumb source__thumb--placeholder';
      thumb.innerHTML = icons.monitor;
    }

    const name = document.createElement('div');
    name.className = 'source__name';
    name.textContent = source.name;
    name.title = source.name;

    button.append(thumb, name);

    // Miniatura preta = o Windows não consegue ler o desenho dessa janela, e a
    // transmissão vai preta também. Avisa antes de a sala reclamar.
    if (source.miniaturaVazia) {
      button.classList.add('source--cega');
      const aviso = document.createElement('span');
      aviso.className = 'source__aviso';
      aviso.textContent = 'pode ir preto';
      aviso.title = source.dica ?? DICA_GENERICA;
      button.append(aviso);
    }
    button.addEventListener('click', () => {
      state.selectedSourceId = source.id;
      el.btnStartShare.disabled = false;
      for (const node of el.sourceGrid.querySelectorAll('.source')) {
        node.classList.toggle('source--selected', node.dataset.sourceId === source.id);
      }
    });

    el.sourceGrid.append(button);
  }
}

el.btnSourceRefresh.addEventListener('click', async () => {
  el.btnSourceRefresh.disabled = true;
  el.btnSourceRefresh.textContent = 'procurando...';
  try {
    renderSources(await listarFontes());
  } catch (error) {
    toast(`Não consegui listar as telas: ${error.message}`, 'error');
  } finally {
    el.btnSourceRefresh.disabled = false;
    el.btnSourceRefresh.textContent = 'procurar de novo';
  }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.remove('tab--active');
    tab.classList.add('tab--active');
    state.sourceTab = tab.dataset.tab;
    state.selectedSourceId = null;
    el.btnStartShare.disabled = true;
    renderSources();
  });
}

async function iniciarCompartilhamento() {
  if (!state.selectedSourceId) return;

  const [height, frameRate] = el.selectQuality.value.split('-').map(Number);
  el.btnStartShare.disabled = true;
  el.btnStartShare.textContent = 'Iniciando...';

  try {
    await room.startScreenShare({
      sourceId: state.selectedSourceId,
      withAudio: el.inputShareAudio.checked,
      frameRate,
      maxHeight: height,
    });
    closeModal('screen-picker');
    toast('Você está compartilhando a tela.', 'ok');
  } catch (error) {
    console.error('[app] compartilhamento falhou:', error);
    toast(error.message, 'error', 8000);
  } finally {
    el.btnStartShare.disabled = false;
    el.btnStartShare.textContent = 'Compartilhar';
  }
}

el.btnStartShare.addEventListener('click', iniciarCompartilhamento);

// =============================================================================
// Modais
// =============================================================================

function closeModal(id) {
  $(id)?.classList.add('hidden');
  if (id === 'screen-picker') window.pinducall.screen.cancel();
}

for (const node of document.querySelectorAll('[data-close]')) {
  node.addEventListener('click', () => closeModal(node.dataset.close));
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const modal of document.querySelectorAll('.modal:not(.hidden)')) closeModal(modal.id);
});

for (const button of document.querySelectorAll('.icon-btn[data-close]')) {
  button.innerHTML = icons.close;
}

// =============================================================================
// Configurações de áudio
// =============================================================================

el.btnSettings.addEventListener('click', async () => {
  await refreshDeviceLists();
  desenharSeletorAvatar();
  el.settingsModal.classList.remove('hidden');
});

// ----------------------------------------------------------------------------
// Configurações em abas
// ----------------------------------------------------------------------------

for (const aba of document.querySelectorAll('.set-tab')) {
  aba.addEventListener('click', () => {
    const alvo = aba.dataset.set;
    for (const t of document.querySelectorAll('.set-tab')) {
      t.classList.toggle('set-tab--active', t === aba);
    }
    for (const painel of document.querySelectorAll('.set-panel')) {
      painel.classList.toggle('hidden', painel.id !== `set-${alvo}`);
    }
  });
}

// ----------------------------------------------------------------------------
// Avatar (aba Perfil)
// ----------------------------------------------------------------------------

/** Avatar atual em edição, lido das preferências. */
function avatarAtual() {
  return state.settings?.avatar ?? null;
}

/** Redesenha o preview + destaca o emoji e a cor selecionados. */
function pintarPreviewAvatar() {
  const av = avatarAtual();
  aplicarAvatar(el.avatarPreview, {
    id: state.selfPeerId ?? state.selfName ?? 'eu',
    name: state.selfName || el.inputName?.value || 'Você',
    avatar: av,
  });
  for (const b of el.avatarEmojis.children) {
    b.classList.toggle('picked', b.dataset.emoji === (av?.emoji ?? ''));
  }
  for (const b of el.avatarCores.children) {
    b.classList.toggle('picked', b.dataset.cor === (av?.color ?? ''));
  }
}

/** Aplica uma mudança no avatar: salva, repinta e avisa a sala. */
async function mudarAvatar(mudanca) {
  const atual = avatarAtual() ?? { emoji: '', color: '' };
  let novo = { emoji: atual.emoji ?? '', color: atual.color ?? '', ...mudanca };
  if (!novo.emoji && !novo.color) novo = null;

  state.settings.avatar = novo;
  await window.pinducall.settings.set({ avatar: novo });

  pintarPreviewAvatar();
  // Repinta o meu próprio avatar na barra de baixo, na hora.
  if (state.selfPeerId) {
    aplicarAvatar(el.selfAvatar, { id: state.selfPeerId, name: state.selfName, avatar: novo });
  }
  // Avisa todo mundo na sala (se já estiver conectado).
  if (state.connected) room.setAvatar(novo).catch(() => {});
}

/** Monta os botões de emoji e de cor uma única vez, e sincroniza a seleção. */
function desenharSeletorAvatar() {
  if (!el.avatarEmojis.dataset.pronto) {
    // Opção "sem emoji" (iniciais) + os emojis.
    const semEmoji = document.createElement('button');
    semEmoji.type = 'button';
    semEmoji.className = 'pick-emoji pick-emoji--none';
    semEmoji.dataset.emoji = '';
    semEmoji.title = 'Iniciais do nome';
    semEmoji.textContent = 'Aa';
    semEmoji.addEventListener('click', () => mudarAvatar({ emoji: '' }));
    el.avatarEmojis.append(semEmoji);

    for (const emoji of AVATAR_EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-emoji';
      b.dataset.emoji = emoji;
      b.textContent = emoji;
      b.addEventListener('click', () => mudarAvatar({ emoji }));
      el.avatarEmojis.append(b);
    }

    for (const cor of AVATAR_PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-cor';
      b.dataset.cor = cor;
      b.style.background = cor;
      b.addEventListener('click', () => mudarAvatar({ color: cor }));
      el.avatarCores.append(b);
    }

    el.btnAvatarReset.addEventListener('click', () => mudarAvatar({ emoji: '', color: '' }));
    el.avatarEmojis.dataset.pronto = '1';
  }
  pintarPreviewAvatar();
}

async function refreshDeviceLists() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (error) {
    console.warn('[app] enumerateDevices falhou:', error.message);
    return;
  }

  const fill = (select, kind, savedId) => {
    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'Padrão do sistema';
    select.append(defaultOption);

    for (const device of devices.filter((d) => d.kind === kind)) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${kind} ${device.deviceId.slice(0, 6)}`;
      select.append(option);
    }

    select.value = [...select.options].some((o) => o.value === savedId) ? savedId : 'default';
  };

  fill(el.selectInput, 'audioinput', state.settings?.inputDeviceId ?? 'default');
  fill(el.selectOutput, 'audiooutput', state.settings?.outputDeviceId ?? 'default');
}

el.selectInput.addEventListener('change', async () => {
  const deviceId = el.selectInput.value;
  await window.pinducall.settings.set({ inputDeviceId: deviceId });
  state.settings.inputDeviceId = deviceId;

  try {
    const stream = await room.switchMic(deviceId);
    micMeter.start(stream, (level) => {
      el.micMeterFill.style.width = `${Math.round(level * 100)}%`;
      el.selfAvatar.classList.toggle('avatar--speaking', level > 0.06 && !room.state.micMuted);
    });
    toast('Microfone trocado.', 'ok', 3000);
  } catch (error) {
    toast(`Não consegui trocar o microfone: ${error.message}`, 'error');
  }
});

el.selectOutput.addEventListener('change', async () => {
  const deviceId = el.selectOutput.value;
  await window.pinducall.settings.set({ outputDeviceId: deviceId });
  state.settings.outputDeviceId = deviceId;
  await playback.setOutputDevice(deviceId);
});

/**
 * Lista os modos de captura que o processo principal conhece. Fora do Windows
 * só existe um jeito de capturar, então o campo some.
 */
function montarModosDeCaptura(info) {
  const modos = info.modosDeCaptura ?? [];
  const campo = el.selectCaptura.closest('.field');

  if (info.platform !== 'win32' || modos.length < 2) {
    campo?.classList.add('hidden');
    return;
  }

  el.selectCaptura.innerHTML = '';
  for (const modo of modos) {
    const opcao = document.createElement('option');
    opcao.value = modo.id;
    opcao.textContent = modo.rotulo;
    el.selectCaptura.append(opcao);
  }
  el.selectCaptura.value = info.modoCaptura;
}

// ---------------------------------------------------------------------------
// Modo automático do OBS (transmitir o Tibia sem abrir o OBS)
// ---------------------------------------------------------------------------

async function atualizarBlocoObs() {
  if (!el.obsAuto) return;
  try {
    const disp = await window.pinducall.obs?.disponivel?.();
    if (disp?.ok) {
      el.obsAuto.classList.remove('hidden');
      el.obsAutoStatus.classList.add('hidden');
    } else {
      // Fora do Windows ou sem OBS: não adianta mostrar o botão.
      el.obsAuto.classList.add('hidden');
    }
  } catch {
    el.obsAuto.classList.add('hidden');
  }
}

function statusObs(texto, tipo) {
  if (!el.obsAutoStatus) return;
  el.obsAutoStatus.textContent = texto;
  el.obsAutoStatus.className = 'obs-auto__status'
    + (tipo ? ` obs-auto__status--${tipo}` : '')
    + (texto ? '' : ' hidden');
}

el.btnObsAuto?.addEventListener('click', async () => {
  el.btnObsAuto.disabled = true;
  statusObs('Abrindo o OBS e montando a cena do Tibia... (pode levar uns segundos)');
  try {
    const r = await window.pinducall.obs.iniciar();
    statusObs(`Câmera do OBS ligada${r?.janela ? ` (${r.janela})` : ''}. Escolhendo a câmera...`, 'ok');

    // A câmera virtual leva um instante para aparecer no sistema. Tenta algumas
    // vezes até ela surgir na lista.
    let camera = null;
    for (let i = 0; i < 8 && !camera; i += 1) {
      const fontes = await listarFontes();
      renderSources(fontes);
      camera = fontes.find((f) => f.kind === 'camera' && /obs/i.test(f.name));
      if (!camera) await new Promise((res) => setTimeout(res, 800));
    }

    if (!camera) {
      statusObs('O OBS ligou, mas a câmera virtual dele ainda não apareceu. Clique em "procurar de novo".', 'erro');
      return;
    }

    // Seleciona e já compartilha.
    state.selectedSourceId = camera.id;
    statusObs(`Pronto: transmitindo o Tibia pela câmera do OBS.`, 'ok');
    await iniciarCompartilhamento();
  } catch (error) {
    statusObs(error.message, 'erro');
  } finally {
    el.btnObsAuto.disabled = false;
  }
});

if (el.inputObsPorta) {
  el.inputObsPorta.addEventListener('change', () => {
    const porta = Number(el.inputObsPorta.value) || 4455;
    window.pinducall.settings.set({ obsPorta: porta });
    if (state.settings) state.settings.obsPorta = porta;
  });
}
if (el.inputObsSenha) {
  el.inputObsSenha.addEventListener('change', () => {
    const senha = el.inputObsSenha.value;
    window.pinducall.settings.set({ obsSenha: senha });
    if (state.settings) state.settings.obsSenha = senha;
  });
}

el.selectCaptura.addEventListener('change', async () => {
  const modo = el.selectCaptura.value;
  toast('Trocando o modo de captura — o app vai reabrir.', 'ok', 4000);
  try {
    // Se o modo mudou de verdade, o processo principal reabre o app e esta
    // página morre no meio da chamada; então não há o que fazer depois.
    await window.pinducall.app.setModoCaptura(modo);
  } catch (error) {
    toast(`Não consegui trocar o modo: ${error.message}`, 'error');
  }
});

el.inputVolume.addEventListener('input', () => {
  const volume = Number(el.inputVolume.value) / 100;
  playback.setMasterVolume(volume);
});

el.inputVolume.addEventListener('change', () => {
  window.pinducall.settings.set({ micVolume: Number(el.inputVolume.value) / 100 });
});

for (const [input, key] of [
  [el.inputEcho, 'echoCancellation'],
  [el.inputNoise, 'noiseSuppression'],
  [el.inputGain, 'autoGainControl'],
]) {
  input.addEventListener('change', () => {
    window.pinducall.settings.set({ [key]: input.checked });
    if (state.settings) state.settings[key] = input.checked;
    room.audioConstraints[key] = input.checked;
  });
}

// Redução de ruído (RNNoise): aplica na hora, trocando o track do microfone no ar.
el.inputRuido.addEventListener('change', async () => {
  const ligado = el.inputRuido.checked;
  window.pinducall.settings.set({ reducaoRuido: ligado });
  if (state.settings) state.settings.reducaoRuido = ligado;
  if (room.audioConstraints) room.audioConstraints.reducaoRuido = ligado;
  try {
    await room.setNoiseSuppression(ligado);
    if (state.connected) toast(ligado ? 'Voz limpa ligada.' : 'Voz limpa desligada.', 'ok', 3000);
  } catch (error) {
    toast(`Não consegui mudar a redução de ruído: ${error.message}`, 'warn');
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  refreshDeviceLists().catch(() => {});
});

// =============================================================================
// Boot
// =============================================================================

el.btnPreviewSize.innerHTML = icons.expand;
el.btnPreviewStop.innerHTML = icons.stopShare;
el.btnMic.innerHTML = icons.mic;
el.btnDeafen.innerHTML = icons.headphones;
el.btnSettings.innerHTML = icons.settings;
el.btnLeave.innerHTML = icons.logout;

loadSettings().catch((error) => {
  console.error('[app] não consegui carregar as preferências:', error);
});

ligarAvisosDeAtualizacao();

window.addEventListener('beforeunload', () => {
  room.leave().catch(() => {});
});
