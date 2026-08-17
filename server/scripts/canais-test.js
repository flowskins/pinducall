/**
 * Teste focado das sub-salas (canais de voz): criar canal, entrar, e o
 * recorte/costura de mídia (quem recebe newProducer / consumerClosed).
 * Usa uma Room real (router mediasoup) com peers e mídia falsos, o suficiente
 * para validar o roteamento por canal sem subir WebRTC de verdade.
 */
import assert from 'node:assert';
import { Room } from '../src/room.js';
import { Peer } from '../src/peer.js';
import { startWorkers, closeWorkers } from '../src/sfu/workers.js';

let passaram = 0;
function ok(desc, cond) {
  assert.ok(cond, desc);
  passaram += 1;
  console.log(`  ok    ${desc}`);
}

/** Socket falso: guarda as notificações que o servidor mandaria para o cliente. */
function fakeSocket() {
  const eventos = [];
  return {
    eventos,
    notify(method, data) {
      eventos.push({ method, data });
    },
  };
}

/** Adiciona um producer falso a um peer (sem mediasoup real). */
function addFakeProducer(peer, id, source, kind = 'audio') {
  peer.producers.set(id, { id, kind, appData: { source, peerId: peer.id } });
}

/** Adiciona um consumer falso (que o peer `holder` tem, puxando de `producerPeerId`). */
function addFakeConsumer(holder, id, producerPeerId) {
  holder.consumers.set(id, { id, appData: { peerId: producerPeerId }, close() {} });
}

function eventosDe(peer, method) {
  return peer.socket.eventos.filter((e) => e.method === method);
}

async function main() {
  await startWorkers();
  const room = await Room.getOrCreate('teste-canais');

  // Três pessoas, todas começam no 'principal'.
  const alice = new Peer({ socket: fakeSocket(), displayName: 'Alice' });
  const bob = new Peer({ socket: fakeSocket(), displayName: 'Bob' });
  const caio = new Peer({ socket: fakeSocket(), displayName: 'Caio' });
  room.addPeer(alice);
  room.addPeer(bob);
  room.addPeer(caio);

  // Cada um tem um mic; Bob consome Alice e Caio; Caio consome Alice e Bob; etc.
  addFakeProducer(alice, 'p-alice-mic', 'mic');
  addFakeProducer(bob, 'p-bob-mic', 'mic');
  addFakeProducer(caio, 'p-caio-mic', 'mic');
  // Consumers "no principal": todo mundo ouve todo mundo.
  addFakeConsumer(bob, 'c-bob<-alice', alice.id);
  addFakeConsumer(caio, 'c-caio<-alice', alice.id);
  addFakeConsumer(alice, 'c-alice<-bob', bob.id);

  ok('todos começam no canal principal', alice.state.channel === 'principal');
  ok('summary conta 3 no principal', room.channelsSummary()[0].count === 3);

  // Alice cria uma sub-sala e entra nela.
  const canal = room.criarCanal(alice, 'Hunt da madruga');
  ok('criarCanal devolve id e nome', Boolean(canal.id) && canal.nome === 'Hunt da madruga');
  ok('agora existem 2 canais', room.channelsSummary().length === 2);

  const res = room.entrarCanal(alice, canal.id);
  ok('entrarCanal move a Alice', alice.state.channel === canal.id);

  // Alice larga tudo o que consumia (consumerClosed pra ela).
  ok('Alice recebe consumerClosed do que consumia', eventosDe(alice, 'consumerClosed').length >= 1);

  // Bob e Caio (que ficaram no principal) param de puxar a mídia da Alice.
  const bobFechou = eventosDe(bob, 'consumerClosed').some((e) => e.data.consumerId === 'c-bob<-alice');
  const caioFechou = eventosDe(caio, 'consumerClosed').some((e) => e.data.consumerId === 'c-caio<-alice');
  ok('Bob para de consumir a Alice', bobFechou);
  ok('Caio para de consumir a Alice', caioFechou);

  // Ninguém no canal novo ainda, então a Alice não recebe newProducer de ninguém.
  ok('sub-sala nova entrou vazia (sem producers pra Alice)', res.producers.length === 0);

  // Bob também entra na sub-sala da Alice: agora eles se ouvem.
  const resBob = room.entrarCanal(bob, canal.id);
  ok('Bob agora está na sub-sala', bob.state.channel === canal.id);
  ok('ao entrar, Bob recebe o producer da Alice', resBob.producers.some((p) => p.producerId === 'p-alice-mic'));
  // Alice (já lá dentro) recebe um newProducer avisando do Bob.
  ok('Alice recebe newProducer do Bob', eventosDe(alice, 'newProducer').some((e) => e.data.producerId === 'p-bob-mic'));

  // Contagem: principal com 1 (Caio), sub-sala com 2 (Alice, Bob).
  const resumo = room.channelsSummary();
  const principal = resumo.find((c) => c.id === 'principal');
  const sub = resumo.find((c) => c.id === canal.id);
  ok('principal ficou com 1 (Caio)', principal.count === 1);
  ok('sub-sala ficou com 2', sub.count === 2);

  // Isolamento de consumo: Caio (principal) não pode consumir producer da Alice (sub).
  await assert.rejects(
    room.createConsumer(caio, { producerId: 'p-alice-mic', transportId: 'x' }),
    /outra sub-sala|rtpCapabilities/i,
    'consumo entre canais diferentes é barrado',
  );
  ok('consumo entre canais diferentes é barrado', true);

  // Alice e Bob voltam ao principal; a sub-sala vazia deve sumir.
  room.entrarCanal(alice, 'principal');
  room.entrarCanal(bob, 'principal');
  ok('sub-sala vazia é removida', room.channelsSummary().length === 1);

  room.close();
  await closeWorkers();

  console.log(`\n${passaram}/${passaram} verificações de canais passaram.`);
}

main().then(
  () => process.exit(0),
  (erro) => {
    console.error('\nFALHOU:', erro?.message ?? erro);
    process.exit(1);
  },
);
