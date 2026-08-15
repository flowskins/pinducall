/**
 * Split de loot do Party Hunt Analyser — o texto que o botão "Copy" do Tibia gera.
 *
 * Portado do bot (Vinicord, src/tibia/split.js) mantendo o mesmo algoritmo:
 * calcula as transferências MÍNIMAS para todo mundo terminar com o mesmo balance.
 */

function toNum(s) {
  return parseInt(String(s).replace(/[^-\d]/g, ''), 10) || 0;
}

/**
 * Lê o log colado.
 * @returns {{session:string, loot:number, supplies:number, balance:number,
 *            players:{name:string,loot:number,supplies:number,balance:number,leader:boolean}[]}|null}
 */
export function parsePartyHunt(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.some((l) => /^session data/i.test(l))) return null;

  const out = { session: '', loot: 0, supplies: 0, balance: 0, players: [] };
  let atual = null;

  for (const l of lines) {
    if (/^session:\s*/i.test(l) && !out.session) {
      out.session = l.replace(/^session:\s*/i, '');
      continue;
    }

    const m = l.match(/^(loot type|loot|supplies|balance|damage|healing|xp gain|xp\/h|raw xp gain)\s*:\s*(.+)$/i);
    if (m) {
      const chave = m[1].toLowerCase();
      const valor = m[2];
      const alvo = atual || out;
      if (chave === 'loot') alvo.loot = toNum(valor);
      else if (chave === 'supplies') alvo.supplies = toNum(valor);
      else if (chave === 'balance') alvo.balance = toNum(valor);
      continue;
    }

    // Linha sem ":" fora do cabeçalho = nome de jogador.
    if (!/^session data/i.test(l) && !l.includes(':')) {
      atual = {
        name: l.replace(/\s*\(leader\)\s*$/i, '').trim(),
        leader: /\(leader\)/i.test(l),
        loot: 0,
        supplies: 0,
        balance: 0,
      };
      out.players.push(atual);
    }
  }

  return out.players.length ? out : null;
}

/** Formata gold do jeito que o pessoal do Tibia lê: 1.2kk, 350k, 900. */
export function fmtGp(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}kk`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Quem ficou acima da média paga quem ficou abaixo, no menor número de transferências. */
export function computeTransfers(players) {
  const total = players.reduce((s, p) => s + p.balance, 0);
  const share = total / players.length;

  const devedores = [];
  const credores = [];

  for (const p of players) {
    const delta = p.balance - share;
    if (delta > 0.5) devedores.push({ name: p.name, sobra: delta });
    else if (delta < -0.5) credores.push({ name: p.name, falta: -delta });
  }

  devedores.sort((a, b) => b.sobra - a.sobra);
  credores.sort((a, b) => b.falta - a.falta);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < devedores.length && j < credores.length) {
    const valor = Math.min(devedores[i].sobra, credores[j].falta);
    transfers.push({ de: devedores[i].name, para: credores[j].name, valor: Math.round(valor) });

    devedores[i].sobra -= valor;
    credores[j].falta -= valor;
    if (devedores[i].sobra < 0.5) i += 1;
    if (credores[j].falta < 0.5) j += 1;
  }

  return { total, share: Math.round(share), transfers };
}

/** Texto pronto para mandar no chat da sala. */
export function formatSplit(parsed) {
  const { total, share, transfers } = computeTransfers(parsed.players);
  const linhas = [];

  linhas.push(`💰 Split da hunt${parsed.session ? ` (${parsed.session})` : ''}`);
  linhas.push(
    `Balance total: ${fmtGp(total)} · ${parsed.players.length} players · parte de cada um: ${fmtGp(share)}`,
  );

  if (!transfers.length) {
    linhas.push('Tudo equilibrado, ninguém paga ninguém 🤝');
  } else {
    linhas.push('');
    for (const t of transfers) {
      linhas.push(`➡️ ${t.de} paga ${fmtGp(t.valor)} para ${t.para}`);
    }
  }

  return { texto: linhas.join('\n'), total, share, transfers };
}

/** Comando de transferência pronto para colar no jogo. */
export function comandoTransfer(transfer) {
  return `transfer ${transfer.valor} to ${transfer.para}`;
}
