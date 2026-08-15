import * as mediasoup from 'mediasoup';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('sfu');

/** @type {import('mediasoup/node/lib/types').Worker[]} */
const workers = [];
let nextWorkerIndex = 0;

/**
 * Sobe o pool de workers do mediasoup. Cada worker é um processo C++ separado
 * que cuida de RTP/SRTP/ICE; o Node só orquestra.
 */
export async function startWorkers() {
  if (workers.length > 0) return workers;

  const { numWorkers, workerSettings } = config.mediasoup;
  const { rtcMinPort, rtcMaxPort } = workerSettings;

  const totalPorts = rtcMaxPort - rtcMinPort + 1;
  if (totalPorts < numWorkers * 10) {
    log.warn(
      `Faixa de portas RTC pequena (${totalPorts} portas para ${numWorkers} workers).`,
      'Considere aumentar RTC_MAX_PORT.',
    );
  }

  // Divide a faixa de portas entre os workers para eles não brigarem pela mesma porta.
  const portsPerWorker = Math.floor(totalPorts / numWorkers);

  for (let i = 0; i < numWorkers; i += 1) {
    const workerMinPort = rtcMinPort + i * portsPerWorker;
    const workerMaxPort = i === numWorkers - 1 ? rtcMaxPort : workerMinPort + portsPerWorker - 1;

    const worker = await mediasoup.createWorker({
      logLevel: workerSettings.logLevel,
      logTags: workerSettings.logTags,
      rtcMinPort: workerMinPort,
      rtcMaxPort: workerMaxPort,
    });

    worker.on('died', (error) => {
      log.error(`Worker ${worker.pid} morreu:`, error?.message ?? error);
      log.error('O servidor vai encerrar em 2s para que o supervisor reinicie tudo.');
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
    log.info(`Worker ${i + 1}/${numWorkers} iniciado (pid ${worker.pid}, portas ${workerMinPort}-${workerMaxPort})`);
  }

  return workers;
}

/** Round-robin simples: cada sala nova cai em um worker diferente. */
export function pickWorker() {
  if (workers.length === 0) {
    throw new Error('Os workers do mediasoup ainda não foram iniciados');
  }
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

export async function closeWorkers() {
  for (const worker of workers) {
    try {
      worker.close();
    } catch {
      /* já fechado */
    }
  }
  workers.length = 0;
}

export function getWorkerStats() {
  return workers.map((worker) => ({ pid: worker.pid, closed: worker.closed }));
}
