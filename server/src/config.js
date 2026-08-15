import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Carrega um .env simples (KEY=VALOR por linha) sem depender de pacote externo.
 * Variaveis já presentes no ambiente tem prioridade sobre o arquivo.
 */
function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Variável ${name} precisa ser numerica (recebido: "${raw}")`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(raw.toLowerCase());
}

/**
 * Descobre o IPv4 da LAN (192.168.x.x / 10.x.x.x / 100.x.x.x do Tailscale).
 * Serve de fallback quando ANNOUNCED_IP não foi definido.
 */
export function detectLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }

  // Prioriza Tailscale (100.64.0.0/10), depois LAN comum.
  const tailscale = candidates.find((c) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(c.address));
  if (tailscale) return tailscale.address;

  const lan = candidates.find((c) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
  if (lan) return lan.address;

  return candidates[0]?.address ?? '127.0.0.1';
}

const announcedIp = process.env.ANNOUNCED_IP?.trim() || detectLocalIp();

export const config = {
  rootDir,

  /** Porta do HTTP + WebSocket de sinalização. */
  port: num('PORT', 4000),

  /** Interface onde o HTTP escuta. 0.0.0.0 = todas. */
  bindAddress: process.env.BIND_ADDRESS?.trim() || '0.0.0.0',

  /**
   * Senha usada só para semear a sala padrão na primeira execução (compatível
   * com a versão de sala única). Cada sala criada depois tem senha própria.
   */
  roomPassword: process.env.ROOM_PASSWORD ?? '',

  /**
   * Teto de salas cadastradas no servidor. Quem tem o app pode criar sala à
   * vontade até bater neste número — é o freio contra alguém encher o disco.
   */
  maxRooms: num('MAX_ROOMS', 30),

  /** Quanto tempo um link de convite continua abrindo a sala. */
  inviteTtlMs: num('CONVITE_HORAS', 24) * 60 * 60 * 1000,

  /**
   * Quanto tempo uma sala sobrevive sem ninguém dentro. Passado o prazo ela é
   * apagada com chat, timers e convites. A sala padrão do .env não expira.
   */
  roomTtlMs: num('SALA_EXPIRA_HORAS', 24) * 60 * 60 * 1000,

  /** De quanto em quanto tempo a faxina roda. */
  limpezaIntervaloMs: num('LIMPEZA_MINUTOS', 15) * 60 * 1000,

  /** Quanto tempo um arquivo enviado no chat fica disponível. */
  arquivoTtlMs: num('ARQUIVO_HORAS', 24) * 60 * 60 * 1000,

  /** Teto por arquivo. */
  arquivoMaxBytes: num('ARQUIVO_MAX_MB', 25) * 1024 * 1024,

  /** Teto de arquivos guardados por sala. */
  arquivoSalaBytes: num('ARQUIVO_SALA_MB', 300) * 1024 * 1024,

  /** Teto de arquivos guardados no servidor inteiro. */
  arquivoTotalBytes: num('ARQUIVO_TOTAL_MB', 3000) * 1024 * 1024,

  /**
   * Endereço público do site, usado para montar o link de convite. Sem isto
   * ele é deduzido do IP anunciado e da porta.
   */
  publicUrl: (process.env.PUBLIC_URL?.trim() || '').replace(/\/+$/, ''),

  /** Limite de pessoas simultaneas por sala. */
  maxPeersPerRoom: num('MAX_PEERS', 10),

  /** Nome da sala padrão criada no boot. */
  defaultRoom: process.env.DEFAULT_ROOM?.trim() || 'geral',

  /** Onde o histórico de chat e gravado. */
  dataDir: process.env.DATA_DIR?.trim() || path.join(rootDir, 'data'),

  /** Quantas mensagens de chat são enviadas ao entrar na sala. */
  chatHistorySize: num('CHAT_HISTORY_SIZE', 200),

  mediasoup: {
    /** Número de workers. Cada worker é um processo C++ separado. */
    numWorkers: Math.max(1, Math.min(num('MEDIASOUP_WORKERS', os.cpus().length), 8)),

    workerSettings: {
      logLevel: process.env.MEDIASOUP_LOG_LEVEL?.trim() || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'bwe', 'score'],
      /**
       * Faixa de portas UDP/TCP usada pela mídia. Precisa estar liberada no
       * firewall do Windows e (se você usa port forwarding) no roteador.
       */
      rtcMinPort: num('RTC_MIN_PORT', 40000),
      rtcMaxPort: num('RTC_MAX_PORT', 40100),
    },

    webRtcTransport: {
      /** Endereço anunciado nos ICE candidates: IP público, IP da LAN ou hostname. */
      announcedAddress: announcedIp,
      /** Também anuncia o IP interno, para quem estiver na mesma LAN conectar direto. */
      exposeInternalIp: bool('EXPOSE_INTERNAL_IP', true),
      enableUdp: bool('ENABLE_UDP', true),
      /** TCP é o fallback para quem esta atrás de firewall que bloqueia UDP. */
      enableTcp: bool('ENABLE_TCP', true),
      preferUdp: true,
      /**
       * Estimativa inicial de banda por transporte. Vale também no sentido
       * servidor->quem assiste: começar alto faz o espectador já receber a
       * camada cheia em vez de subir do borrado devagar. É o que mais mexe na
       * qualidade percebida do compartilhamento de tela.
       */
      initialAvailableOutgoingBitrate: num('INITIAL_BITRATE', 8_000_000),
      /** Teto por transporte de envio. Cabe a soma das camadas (~8.6 Mbps). */
      maxIncomingBitrate: num('MAX_INCOMING_BITRATE', 10_000_000),
    },
  },
};

export const announcedAddress = announcedIp;

/** Base http(s) do site, para montar links de convite. */
export const siteBaseUrl =
  config.publicUrl || `${process.env.TLS_CERT ? 'https' : 'http'}://${announcedIp}:${config.port}`;

/** Endereço de sinalização que vai dentro do link de convite. */
export const signalingUrl = `${process.env.TLS_CERT ? 'wss' : 'ws'}://${announcedIp}:${config.port}/ws`;
