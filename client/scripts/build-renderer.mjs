import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');

const watch = process.argv.includes('--watch');
const production = !watch && process.env.NODE_ENV !== 'development';

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
