const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Preferências em JSON dentro de %APPDATA%/PinduCcall.
 * Evita uma dependencia extra só para guardar quatro campos.
 */
/**
 * Endereço oficial do servidor do PinduCcall. Como agora existe um servidor
 * fixo na internet, a tela de entrada não pede mais IP: ela já chega aqui.
 * Quem quiser apontar para outro lugar muda em "Servidor" na tela de entrada.
 */
const SERVIDOR_PADRAO = 'ws://201.54.18.186:4000/ws';

const DEFAULTS = {
  serverUrl: SERVIDOR_PADRAO,
  roomId: '',
  displayName: '',
  password: '',
  rememberPassword: false,
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  micVolume: 1,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  // Redução de ruído avançada (RNNoise): remove ruído de fundo deixando só a voz.
  reducaoRuido: true,
  // Avatar escolhido: { emoji, color } ou null (usa iniciais + cor do nome).
  avatar: null,
  screenFrameRate: 30,
  // 'moderno' | 'automatico' | 'antigo' — ver MODOS_DE_CAPTURA no main.js.
  modoCaptura: 'moderno',

  // Modo automático do OBS (para transmitir o Tibia sem abrir o OBS na mão).
  obsPath: '', // vazio = procurar nos lugares padrão
  obsPorta: 4455,
  obsSenha: '',

  // Painel do Tibia
  alarmeVolume: 0.6,
  alarmeAviso: 10,
  djVolumeCall: 0.7,
  djVolumeLocal: 0.4,

  screenMaxHeight: 1080,
  windowBounds: { width: 1180, height: 760 },
};

let cache = null;
let filePath = null;

function getFilePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function readAll() {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(getFilePath(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function writeAll(values) {
  cache = { ...readAll(), ...values };

  // Nunca grava a senha em disco se a pessoa não pediu para lembrar.
  const toPersist = { ...cache };
  if (!toPersist.rememberPassword) toPersist.password = '';

  try {
    fs.mkdirSync(path.dirname(getFilePath()), { recursive: true });
    fs.writeFileSync(getFilePath(), JSON.stringify(toPersist, null, 2), 'utf8');
  } catch (error) {
    console.error('[store] não foi possível salvar as preferências:', error.message);
  }
  return cache;
}

module.exports = { readAll, writeAll, DEFAULTS };
