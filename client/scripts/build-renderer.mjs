import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');
const production = !watch && process.env.NODE_ENV !== 'development';

/**
 * O RNNoise (redução de ruído) roda num AudioWorklet + WASM que precisam existir
 * como ARQUIVOS soltos em runtime (o worklet é carregado por URL, o wasm é lido
 * pelo processo principal). Copiamos do node_modules para renderer/assets a cada
 * build, para irem junto no instalador (renderer/assets/**).
 */
function copiarAssetsRuido() {
  const origem = path.join(
    clientDir,
    'node_modules',
    '@sapphi-red',
    'web-noise-suppressor',
    'dist',
  );
  const destino = path.join(clientDir, 'renderer', 'assets', 'rnnoise');
  fs.mkdirSync(destino, { recursive: true });

  const arquivos = [
    ['rnnoise/workletProcessor.js', 'workletProcessor.js'],
    ['rnnoise_simd.wasm', 'rnnoise_simd.wasm'],
    ['rnnoise.wasm', 'rnnoise.wasm'],
  ];
  for (const [rel, nome] of arquivos) {
    fs.copyFileSync(path.join(origem, rel), path.join(destino, nome));
  }
  console.log('Assets do RNNoise copiados para renderer/assets/rnnoise.');
}

copiarAssetsRuido();

/**
 * O renderer roda sem Node.js (contextIsolation ligado), então tudo que ele usa
 * - inclusive a mediasoup-client - precisa virar um bundle único de browser.
 */
const options = {
  entryPoints: [path.join(clientDir, 'renderer', 'src', 'app.js')],
  outfile: path.join(clientDir, 'renderer', 'dist', 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome128'],
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('esbuild em modo watch. Ctrl+C para sair.');
} else {
  await esbuild.build(options);
  console.log(`Bundle do renderer gerado (${production ? 'produção' : 'desenvolvimento'}).`);
}
