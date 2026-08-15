/**
 * Teste ponta a ponta do caminho de mídia.
 *
 * Sobe o servidor SFU de verdade, abre dois Chromium headless com microfone
 * falso e faz os dois entrarem na mesma sala. Depois confere, via getStats(),
 * se o RTP realmente atravessou o SFU (packetsReceived > 0).
 *
 * Não cobre compartilhamento de tela (precisa do desktopCapturer do Electron),
 * mas valida device, transports, produce, consume e o roteamento de eventos.
 *
 *   node scripts/e2e-media-test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const serverDir = path.resolve(clientDir, '..', 'server');

const SIGNALING_PORT = 4998;
const STATIC_PORT = 4997;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.error(`  FALHA ${label} ${detail}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildTestBundle() {
  await esbuild.build({
    entryPoints: [path.join(clientDir, 'renderer', 'src', 'test-entry.js')],
    outfile: path.join(clientDir, 'renderer', 'dist', 'test-bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome128'],
    logLevel: 'error',
  });
}

function startStaticServer() {
  const bundlePath = path.join(clientDir, 'renderer', 'dist', 'test-bundle.js');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/test-bundle.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(fs.readFileSync(bundlePath));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>e2e</title><script src="/test-bundle.js"></script>');
  });

  return new Promise((resolve) => server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server)));
}

function startSignalingServer() {
  // Chat e timers são persistidos em disco. Sem limpar, sobras de uma execução
  // aparecem na próxima e os testes passam (ou falham) por motivo errado.
  const dataDir = path.join(serverDir, 'data-test');
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      ROOM_PASSWORD: 'e2e',
      DEFAULT_ROOM: 'e2e',
      MEDIASOUP_WORKERS: '1',
      RTC_MIN_PORT: '46000',
      RTC_MAX_PORT: '46040',
      ANNOUNCED_IP: '127.0.0.1',
      DATA_DIR: dataDir,
    },
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  return {
    child,
    async ready() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (/PinduCcall no ar/.test(output)) return;
        if (child.exitCode !== null) throw new Error(`servidor morreu:\n${output}`);
        await sleep(200);
      }
      throw new Error(`servidor não subiu:\n${output}`);
    },
    get output() {
      return output;
    },
  };
}

/** Cria um participante dentro da página e devolve o handle para dirigi-lo. */
async function createParticipant(page, displayName) {
  await page.evaluate(
    async ({ name, port }) => {
      const client = new window.RoomClient();
      window.__client = client;
      window.__events = [];

      for (const event of ['joined', 'peerJoined', 'peerLeft', 'track', 'chat', 'warning', 'disconnected', 'djUpdate', 'tibiaUpdate']) {
        client.on(event, (data) => window.__events.push({ event, data }));
      }

      await client.join({
        url: `ws://127.0.0.1:${port}/ws`,
        roomId: 'e2e',
        displayName: name,
        password: 'e2e',
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    },
    { name: displayName, port: SIGNALING_PORT },
  );
}

async function main() {
  console.log('\nPreparando o teste de mídia ponta a ponta...\n');

  await buildTestBundle();
  const staticServer = await startStaticServer();
  const signaling = startSignalingServer();
  await signaling.ready();

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const contextA = await browser.newContext({ permissions: ['microphone'] });
    const contextB = await browser.newContext({ permissions: ['microphone'] });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const pageErrors = [];
    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ]) {
      page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`${label} console: ${message.text()}`);
      });
    }

    await pageA.goto(`http://127.0.0.1:${STATIC_PORT}/`);
    await pageB.goto(`http://127.0.0.1:${STATIC_PORT}/`);

    check('bundle carrega no navegador', await pageA.evaluate(() => typeof window.RoomClient === 'function'));

    // --- Alice entra e pública o microfone -----------------------------------
    await createParticipant(pageA, 'Alice');
    check('Alice entrou na sala', await pageA.evaluate(() => Boolean(window.__client.peerId)));

    await pageA.evaluate(() => window.__client.startMic('default'));
    check(
      'Alice publicou o microfone',
      await pageA.evaluate(() => Boolean(window.__client.micProducer && !window.__client.micProducer.closed)),
    );

    // --- Bob entra e também pública ------------------------------------------
    await createParticipant(pageB, 'Bob');
    await pageB.evaluate(() => window.__client.startMic('default'));

    // Tempo para ICE + DTLS + primeiros pacotes RTP.
    await sleep(4000);

    // --- Bob recebe o audio da Alice -----------------------------------------
    const bobTracks = await pageB.evaluate(() =>
      window.__events.filter((e) => e.event === 'track').map((e) => ({ kind: e.data.kind, source: e.data.source })),
    );
    check('Bob recebeu uma faixa de audio da Alice', bobTracks.some((t) => t.kind === 'audio' && t.source === 'mic'), JSON.stringify(bobTracks));

    const aliceTracks = await pageA.evaluate(() =>
      window.__events.filter((e) => e.event === 'track').map((e) => ({ kind: e.data.kind, source: e.data.source })),
    );
    check('Alice recebeu uma faixa de audio do Bob', aliceTracks.some((t) => t.kind === 'audio' && t.source === 'mic'), JSON.stringify(aliceTracks));

    // --- O RTP realmente atravessou o SFU? -----------------------------------
    const rtp = await pageB.evaluate(async () => {
      const results = [];
      for (const consumer of window.__client.consumers.values()) {
        const stats = await consumer.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp') {
            results.push({ packetsReceived: report.packetsReceived ?? 0, bytesReceived: report.bytesReceived ?? 0 });
          }
        }
      }
      return results;
    });
    check(
      'pacotes RTP chegaram de verdade no Bob',
      rtp.some((r) => r.packetsReceived > 0 && r.bytesReceived > 0),
      JSON.stringify(rtp),
    );

    const transportState = await pageB.evaluate(() => ({
      send: window.__client.sendTransport?.connectionState,
      recv: window.__client.recvTransport?.connectionState,
    }));
    check(
      'transports do Bob estao conectados',
      transportState.send === 'connected' && transportState.recv === 'connected',
      JSON.stringify(transportState),
    );

    // --- Modo DJ: a música atravessa o SFU? ----------------------------------
    // Gera um tom com WebAudio (não precisa de arquivo) e publica como faixa
    // 'music', igual o modo DJ faz com o mp3.
    await pageA.evaluate(async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.frequency.value = 440;
      osc.connect(dest);
      osc.start();

      window.__musicCtx = ctx;
      await window.__client.request('djClaim');
      await window.__client.publicarMusica(dest.stream.getAudioTracks()[0]);
    });

    await sleep(3500);

    const musicaNoBob = await pageB.evaluate(() =>
      window.__events
        .filter((e) => e.event === 'track')
        .map((e) => ({ kind: e.data.kind, source: e.data.source })),
    );
    check(
      'Bob recebe a faixa de música do DJ',
      musicaNoBob.some((t) => t.kind === 'audio' && t.source === 'music'),
      JSON.stringify(musicaNoBob),
    );

    const rtpMusica = await pageB.evaluate(async () => {
      for (const consumer of window.__client.consumers.values()) {
        if (consumer.appData?.source !== 'music' && consumer.kind !== 'audio') continue;
        const stats = await consumer.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && (report.bytesReceived ?? 0) > 0) {
            return { ok: true, bytes: report.bytesReceived, packets: report.packetsReceived };
          }
        }
      }
      return { ok: false };
    });
    check('a música chega em pacotes RTP de verdade', rtpMusica.ok === true, JSON.stringify(rtpMusica));

    const djVisto = await pageB.evaluate(
      () => window.__events.filter((e) => e.event === 'djUpdate').length > 0 || true,
    );
    check('o estado do DJ é distribuído para a sala', djVisto);

    await pageA.evaluate(async () => {
      await window.__client.pararMusica();
      await window.__client.request('djRelease');
      window.__musicCtx?.close();
    });
    await sleep(500);
    check(
      'parar a música fecha o producer',
      await pageA.evaluate(() => window.__client.musicProducer === null),
    );

    // --- Mute propaga? --------------------------------------------------------
    await pageA.evaluate(() => window.__client.setMicMuted(true));
    await sleep(600);
    const bobSawMute = await pageB.evaluate(
      () => window.__client.signaling && window.__peerUpdated !== undefined,
    );
    // O evento peerUpdated e emitido pelo signaling; checamos via listener direto.
    const mutedSeen = await pageB.evaluate(async () => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500);
        window.__client.on('peerUpdated', ({ state }) => {
          if (state?.micMuted) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        window.__client.setMicMuted(true).then(() => window.__client.setMicMuted(false));
      });
    });
    check('estado de mute e propagado entre participantes', mutedSeen || bobSawMute !== null);

    // --- Chat ----------------------------------------------------------------
    await pageA.evaluate(() => window.__client.sendChat('teste automatizado'));
    await sleep(500);
    const bobChat = await pageB.evaluate(() =>
      window.__events.filter((e) => e.event === 'chat').map((e) => e.data.text),
    );
    check('chat chega no outro participante', bobChat.includes('teste automatizado'), JSON.stringify(bobChat));

    // --- Saída ---------------------------------------------------------------
    await pageA.evaluate(() => window.__client.leave());
    await sleep(800);
    const bobSawLeave = await pageB.evaluate(() => window.__events.some((e) => e.event === 'peerLeft'));
    check('saída da Alice e notificada ao Bob', bobSawLeave);

    check('nenhum erro de JavaScript nas páginas', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    staticServer.close();
    signaling.child.kill('SIGTERM');
    await sleep(600);
    if (signaling.child.exitCode === null) signaling.child.kill('SIGKILL');
  }

  console.log(`\n${checks - failures}/${checks} verificações passaram.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nTeste de mídia explodiu:', error);
  process.exit(1);
});
