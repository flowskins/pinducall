import { Signaling } from './signaling.js';

/**
 * Conversas curtas com o servidor ANTES de entrar na sala: listar o que existe
 * e criar sala nova. Cada chamada abre e fecha a própria conexão, então nada
 * disso interfere na conexão da chamada em si.
 */
async function comConexao(url, acao) {
  const signaling = new Signaling();
  await signaling.connect(url);
  try {
    return await acao(signaling);
  } finally {
    signaling.close();
  }
}

/** @returns {Promise<{salas: Array, maxRooms: number, maxPeers: number}>} */
export function listarSalas(url) {
  return comConexao(url, (signaling) => signaling.request('listarSalas'));
}

/** @returns {Promise<{id: string, nome: string}>} */
export function criarSala(url, { nome, senha, displayName }) {
  return comConexao(url, (signaling) =>
    signaling.request('criarSala', { nome, senha, displayName }),
  );
}

/**
 * Descobre para qual sala um convite aponta, antes de entrar.
 * @returns {Promise<{roomId: string, nome: string, pessoas: number, expiraEm: number}>}
 */
export function verConvite(url, token) {
  return comConexao(url, (signaling) => signaling.request('verConvite', { token }));
}
