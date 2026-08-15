/**
 * Gera o print da tela de entrada para a landing page.
 *
 *   node scripts/print-tela-entrada.mjs
 *
 * Sobe um servidor de teste com algumas salas cadastradas, carrega o renderer
 * real num Chromium e fotografa a tela de conexão já com a lista preenchida.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const rendererDir = path.join(clientDir, 'renderer');
const serverDir = path.resolve(clientDir, '..', 'server');
const saidaDir = path.resolve(clientDir, '..', 'server', 'public', 'imagens');

const SIGNALING_PORT = 4991;
const STATIC_PORT = 4990;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
};

function servirRenderer() {
  const server = http.createServer((req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(rendererDir, decodeURIComponent(urlPath));
    if (!filePath.startsWith(rendererDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('nao encontrado');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server)));
}

function subirServidor() {
  const dataDir = path.join(serverDir, 'data-print');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      ROOM_PASSWORD: 'print',
      DEFAULT_ROOM: 'Geral',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '48000',
      RTC_MAX_PORT: '48020',
      ANNOUNCED_IP: '127.0.0.1',
      DATA_DIR: dataDir,
    },
  });

  let output = '';
  child.stdout.on('data', (c) => (output += c.toString()));
  child.stderr.on('data', (c) => (output += c.toString()));

  return {
    child,
    async ready() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (/PinduCcall no ar/.test(output)) return;
        if (child.exitCode !== null) throw new Error(`servidor morreu:\n${output}`);
        await sleep(200);
      }
      throw new Error(`servidor nao subiu:\n${output}`);
    },
  };
}

// O "ws" vive no servidor, não no cliente: pegamos de lá para não criar
// dependência nova só por causa de um script de print.
const { default: WebSocket } = await import(
  pathToFileURL(path.join(serverDir, 'node_modules', 'ws', 'index.js')).href
);

/** Cadastra salas de exemplo falando o protocolo direto. */
function criarSalas(nomes) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/ws`);
    let seq = 0;
    let feitos = 0;

    ws.on('open', () => {
      for (const nome of nomes) {
        seq += 1;
        ws.send(
          JSON.stringify({
            t: 'req',
            id: `p${seq}`,
            method: 'criarSala',
            data: { nome, senha: 'exemplo123', displayName: 'Cauê' },
          }),
        );
      }
    });

    ws.on('message', () => {
      feitos += 1;
      if (feitos >= nomes.length) {
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

const bridgeStub = (port) => `
window.pinducall = {
  __saved: {},
  screen: { list: async () => [], select: async () => ({ ok: true }), cancel: async () => ({ ok: true }) },
  settings: {
    get: async () => ({
      serverUrl: 'ws://127.0.0.1:${port}/ws',
      roomId: 'hunt-da-madruga',
      displayName: '',
      password: '',
      rememberPassword: false,
      inputDeviceId: 'default', outputDeviceId: 'default', micVolume: 1,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }),
    set: async (v) => v,
  },
  app: {
    info: async () => ({ version: '1.3.0', platform: 'win32', electron: '33.0.0', chrome: '130',
      defaultServerUrl: 'ws://pinduccall:4000/ws' }),
    openExternal: () => {}, flashTaskbar: () => {},
  },
  onToggleMute: () => () => {},
};
`;

async function main() {
  fs.mkdirSync(saidaDir, { recursive: true });

  const estatico = await servirRenderer();
  const servidor = subirServidor();
  await servidor.ready();
  await criarSalas(['Hunt da Madruga', 'Roshamuul', 'Só resenha']);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
    await page.addInitScript(bridgeStub(SIGNALING_PORT));
    await page.goto(`http://127.0.0.1:${STATIC_PORT}/`);

    await page.waitForSelector('#room-list .room[data-id="hunt-da-madruga"]', { timeout: 20_000 });
    await page.fill('#input-name', 'Cauê');
    await page.fill('#input-password', 'senhadasala');
    // Tira o foco para o print não sair com o cursor piscando num campo, e
    // troca o rótulo do servidor: o print é público, não faz sentido mostrar
    // o 127.0.0.1 do ambiente de teste.
    await page.evaluate(() => {
      document.activeElement?.blur();
      const alvo = document.getElementById('btn-open-server');
      if (alvo) alvo.textContent = 'servidor oficial';
    });
    await sleep(700);

    await page.locator('#connect-form').screenshot({ path: path.join(saidaDir, 'entrar.png') });
    console.log('gerado:', path.join(saidaDir, 'entrar.png'));
  } finally {
    await browser.close();
    estatico.close();
    servidor.child.kill('SIGTERM');
    await sleep(500);
    if (servidor.child.exitCode === null) servidor.child.kill('SIGKILL');
    fs.rmSync(path.join(serverDir, 'data-print'), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('falhou:', error);
  process.exit(1);
});
