import { createLogger } from './logger.js';

const log = createLogger('rpc');

/**
 * Protocolo de sinalização (JSON sobre WebSocket):
 *
 *   requisição   -> { t: 'req',    id, method, data }
 *   resposta     <- { t: 'res',    id, ok: true,  data }
 *                <- { t: 'res',    id, ok: false, error: { message } }
 *   notificação  <> { t: 'notify', method, data }
 *
 * Notificações são unidirecionais e podem ir nos dois sentidos.
 */
export function wrapSocket(ws, { onRequest, onNotify, onClose } = {}) {
  const connection = {
    ws,
    closed: false,

    notify(method, data) {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify({ t: 'notify', method, data }));
      } catch (error) {
        log.warn('Falha ao notificar:', error.message);
      }
    },

    close(code = 1000, reason = '') {
      try {
        ws.close(code, reason);
      } catch {
        /* já fechado */
      }
    },
  };

  function respond(id, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ t: 'res', id, ...payload }));
    } catch (error) {
      log.warn('Falha ao responder:', error.message);
    }
  }

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      log.warn('Mensagem que não e JSON valido foi descartada');
      return;
    }

    if (message.t === 'notify') {
      try {
        await onNotify?.(message.method, message.data, connection);
      } catch (error) {
        log.warn(`Erro na notificação "${message.method}":`, error.message);
      }
      return;
    }

    if (message.t !== 'req' || typeof message.id !== 'string') return;

    try {
      const data = await onRequest?.(message.method, message.data ?? {}, connection);
      respond(message.id, { ok: true, data: data ?? null });
    } catch (error) {
      log.warn(`Erro em "${message.method}":`, error.message);
      respond(message.id, { ok: false, error: { message: error.message } });
    }
  });

  ws.on('close', () => {
    connection.closed = true;
    onClose?.(connection);
  });

  ws.on('error', (error) => {
    log.warn('Erro no socket:', error.message);
  });

  return connection;
}
