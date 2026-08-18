// =============================================================================
// Efeitos de clima
//
// Neve na tela de entrada (sobre o mascote) e chuva com relâmpagos dentro do
// app (por cima do cenário de fundo, atrás dos painéis).
//
// Cada efeito desenha no seu próprio <canvas> em tela cheia, com
// pointer-events: none, e SÓ desenha quando a tela alvo está visível e a aba
// está ativa. Fora disso ele limpa o canvas e não gasta nada — para não roubar
// CPU do compartilhamento de tela.
// =============================================================================

function ajustarCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}

// ---------------------------------------------------------------------------
// Neve — flocos em camadas (longe = pequeno e lento, perto = grande e rápido),
// com balanço lateral suave.
// ---------------------------------------------------------------------------
export function iniciarNeve(canvas, opts = {}) {
  if (!canvas) return { destroy() {} };
  const visivel = opts.visivel || (() => true);
  const quantidade = opts.quantidade || 260;

  let dims = ajustarCanvas(canvas);
  const flocos = [];
  const novoFloco = (inicial) => {
    const camada = Math.random(); // 0 = fundo, 1 = frente
    return {
      x: Math.random() * dims.w,
      y: inicial ? Math.random() * dims.h : -10,
      r: 0.8 + camada * 3.2,
      vel: 18 + camada * 46,
      swing: 8 + camada * 26,
      fase: Math.random() * Math.PI * 2,
      giro: 0.6 + Math.random() * 1.2,
      alpha: 0.35 + camada * 0.5,
    };
  };
  for (let i = 0; i < quantidade; i++) flocos.push(novoFloco(true));

  let raf = 0;
  let ultimo = performance.now();
  const onResize = () => {
    dims = ajustarCanvas(canvas);
  };
  window.addEventListener('resize', onResize);

  function tick(agora) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((agora - ultimo) / 1000, 0.05);
    ultimo = agora;
    const { w, h, ctx } = dims;
    if (document.hidden || !visivel()) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#eef2ff';
    for (const f of flocos) {
      f.y += f.vel * dt;
      f.fase += dt * f.giro;
      const x = f.x + Math.sin(f.fase) * f.swing;
      if (f.y > h + 6) {
        f.y = -6;
        f.x = Math.random() * w;
      }
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };
}

// ---------------------------------------------------------------------------
// Chuva + relâmpagos — gotas inclinadas rápidas e, de vez em quando, um clarão
// com um raio irregular.
// ---------------------------------------------------------------------------
export function iniciarChuva(canvas, opts = {}) {
  if (!canvas) return { destroy() {} };
  const visivel = opts.visivel || (() => true);
  const quantidade = opts.quantidade || 150;
  const angulo = 0.28; // inclinação (dx por unidade de comprimento)
  const intervaloRaio = opts.intervaloRaio || [7, 15]; // segundos entre relâmpagos
  const primeiroRaio = opts.primeiroRaio || [2, 6]; // segundos até o primeiro

  let dims = ajustarCanvas(canvas);
  const gotas = [];
  const novaGota = (inicial) => {
    const camada = Math.random();
    return {
      x: Math.random() * (dims.w + 160) - 80,
      y: inicial ? Math.random() * dims.h : -20,
      len: 10 + camada * 14,
      vel: 900 + camada * 700,
      alpha: 0.1 + camada * 0.22,
    };
  };
  for (let i = 0; i < quantidade; i++) gotas.push(novaGota(true));

  // Relâmpago
  let flashAlpha = 0;
  let proximoRaio = primeiroRaio[0] + Math.random() * (primeiroRaio[1] - primeiroRaio[0]);
  let bolt = null;
  let boltVida = 0;

  function gerarBolt() {
    const w = dims.w;
    const h = dims.h;
    const x0 = w * (0.18 + Math.random() * 0.64);
    const pts = [{ x: x0, y: -20 }];
    let x = x0;
    let y = -20;
    const alvo = h * (0.45 + Math.random() * 0.4);
    while (y < alvo) {
      y += 22 + Math.random() * 42;
      x += (Math.random() - 0.5) * 66;
      pts.push({ x, y });
      // galho ocasional
      if (Math.random() < 0.12) {
        pts.push({ x: x + (Math.random() - 0.5) * 50, y: y + 18 + Math.random() * 26 });
        pts.push({ x, y });
      }
    }
    return pts;
  }

  let raf = 0;
  let ultimo = performance.now();
  const onResize = () => {
    dims = ajustarCanvas(canvas);
  };
  window.addEventListener('resize', onResize);

  function tick(agora) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((agora - ultimo) / 1000, 0.05);
    ultimo = agora;
    const { w, h, ctx } = dims;
    if (document.hidden || !visivel()) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    ctx.clearRect(0, 0, w, h);

    // Gotas
    ctx.strokeStyle = '#a9b8ff';
    ctx.lineWidth = 1.1;
    for (const g of gotas) {
      g.y += g.vel * dt;
      g.x += g.vel * dt * angulo;
      if (g.y > h + 20) {
        g.y = -20;
        g.x = Math.random() * (w + 160) - 80;
      }
      ctx.globalAlpha = g.alpha;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x - g.len * angulo, g.y - g.len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Relâmpago
    proximoRaio -= dt;
    if (proximoRaio <= 0) {
      proximoRaio = intervaloRaio[0] + Math.random() * (intervaloRaio[1] - intervaloRaio[0]);
      flashAlpha = 0.45 + Math.random() * 0.25;
      bolt = gerarBolt();
      boltVida = 0.2;
    }
    if (flashAlpha > 0) {
      ctx.globalAlpha = flashAlpha;
      ctx.fillStyle = 'rgba(150, 170, 255, 1)';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      flashAlpha -= dt * 2.2; // some em ~0.2s
    }
    if (bolt && boltVida > 0) {
      boltVida -= dt;
      ctx.globalAlpha = Math.max(0, Math.min(1, boltVida / 0.2));
      ctx.strokeStyle = '#e3e9ff';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = '#93a6ff';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.moveTo(bolt[0].x, bolt[0].y);
      for (let i = 1; i < bolt.length; i++) ctx.lineTo(bolt[i].x, bolt[i].y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      if (boltVida <= 0) bolt = null;
    }
  }
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };
}
