/**
 * Gera o print da sala (com o painel do Tibia) para a landing page.
 *
 *   node scripts/print-sala.mjs
 *
 * Sobe um servidor de teste, entra com três pessoas, troca umas mensagens,
 * liga um timer, põe alguém compartilhando a tela e fotografa a janela.
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
const saidaDir = path.join(serverDir, 'public', 'imagens');

const SIGNALING_PORT = 4993;
const STATIC_PORT = 4992;

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
      DEFAULT_ROOM: 'Hunt da Madruga',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '48100',
      RTC_MAX_PORT: '48140',
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

const bridgeStub = (port) => `
window.pinducall = {
  __saved: {},
  screen: {
    list: async () => ([
      { id: 'screen:0:0', name: 'Tela inteira', kind: 'screen', thumbnail: null, appIcon: null },
    ]),
    select: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
  },
  settings: {
    get: async () => ({
      serverUrl: 'ws://127.0.0.1:${port}/ws',
      roomId: 'hunt-da-madruga', displayName: '', password: '', rememberPassword: false,
      inputDeviceId: 'default', outputDeviceId: 'default', micVolume: 1,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      alarmeVolume: 0.6, alarmeAviso: 10, djVolumeCall: 0.7, djVolumeLocal: 0.4,
    }),
    set: async (v) => v,
  },
  app: {
    info: async () => ({ version: '1.6.0', platform: 'win32', electron: '33.0.0', chrome: '130',
      defaultServerUrl: 'ws://pinduccall:4000/ws' }),
    openExternal: () => {}, flashTaskbar: () => {},
  },
  onToggleMute: () => () => {},
};
`;

async function abrir(browser, nome, escala = 1) {
  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1400, height: 880 },
    deviceScaleFactor: escala,
  });
  const page = await context.newPage();
  await page.addInitScript(bridgeStub(SIGNALING_PORT));
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`);

  await page.waitForSelector('#room-list .room[data-id="hunt-da-madruga"]', { timeout: 20_000 });
  await page.fill('#input-name', nome);
  await page.click('#room-list .room[data-id="hunt-da-madruga"]');
  await page.fill('#input-password', 'print');
  await page.click('#btn-connect');
  await page.waitForSelector('#room-screen:not(.hidden)', { timeout: 20_000 });
  return page;
}

async function main() {
  fs.mkdirSync(saidaDir, { recursive: true });

  const estatico = await servirRenderer();
  const servidor = subirServidor();
  await servidor.ready();

  // Sem isto o Chromium compartilha o padrão de teste dele (um "pac-man" verde).
  // Aponte TELA_EXEMPLO para um .y4m para o print sair com uma tela plausível:
  //   ffmpeg -i tela.png -pix_fmt yuv420p -f yuv4mpegpipe tela.y4m
  const telaExemplo = process.env.TELA_EXEMPLO;

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen',
      '--allow-http-screen-capture',
      ...(telaExemplo ? [`--use-file-for-fake-video-capture=${telaExemplo}`] : []),
    ],
  });

  try {
    const caue = await abrir(browser, 'Cauê', 2);
    const marina = await abrir(browser, 'Marina Alves');
    const rafael = await abrir(browser, 'Rafael Souza');

    // Conversa curta, para o chat não aparecer vazio no print.
    const falar = async (page, texto) => {
      await page.fill('#chat-input', texto);
      await page.click('#chat-form button[type="submit"]');
      await sleep(250);
    };
    await falar(rafael, 'bora? já tô com as runas');
    await falar(marina, 'to indo, 2 min');
    await falar(caue, 'compartilhando a tela aqui, olha só');

    // Marina compartilha a tela para o palco não ficar vazio.
    await marina.click('#btn-share');
    await marina.waitForSelector('#source-grid .source', { timeout: 15_000 });
    await marina.click('#source-grid .source');
    await marina.click('#btn-start-share');
    await caue.waitForSelector('#stage-grid video', { timeout: 25_000 });

    // O Chromium só sabe compartilhar o padrão de teste dele (um "pac-man"
    // verde), que fica horrível no print. Se TELA_EXEMPLO apontar para uma
    // imagem, ela é desenhada por cima do vídeo — só para a foto.
    if (process.env.TELA_EXEMPLO && fs.existsSync(process.env.TELA_EXEMPLO)) {
      const dataUrl = `data:image/png;base64,${fs.readFileSync(process.env.TELA_EXEMPLO).toString('base64')}`;
      await caue.evaluate((src) => {
        const video = document.querySelector('#stage-grid video');
        if (!video) return;
        video.style.visibility = 'hidden';
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText =
          'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit';
        video.parentElement.appendChild(img);
      }, dataUrl);
      await sleep(600);
    }

    // Um arquivo no chat, para o print mostrar o cartão de download.
    await rafael.evaluate(() => {
      const arquivo = new File(['loot: 1.234.567 gp\n'], 'split da hunt.txt', { type: 'text/plain' });
      const dados = new DataTransfer();
      dados.items.add(arquivo);
      document
        .getElementById('chat-panel')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dados }));
    });
    await caue.waitForSelector('#chat-messages .arquivo', { timeout: 20_000 });

    // Liga o timer da mastermind, que é o que dá vida ao painel do Tibia.
    await caue.click('#timer-list .timer .timer__btn--play');
    await sleep(1500);

    await caue.evaluate(() => document.activeElement?.blur());
    await sleep(800);

    await caue.screenshot({ path: path.join(saidaDir, 'sala.png') });
    console.log('gerado:', path.join(saidaDir, 'sala.png'));
  } finally {
    await browser.close();
    estatico.close();
    servidor.child.kill('SIGTERM');
    await sleep(600);
    if (servidor.child.exitCode === null) servidor.child.kill('SIGKILL');
    fs.rmSync(path.join(serverDir, 'data-print'), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('falhou:', error);
  process.exit(1);
});
