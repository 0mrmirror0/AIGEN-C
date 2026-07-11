// Silicon Soccer — AI avversaria v2
// Miglioramenti rispetto alla v1:
//  - il jitter (imprecisione) si applica PRIMA della valutazione: l'AI valuta
//    esattamente il colpo che eseguirà, niente più tiri buoni rovinati dopo
//  - candidata "fermo": a volte la mossa migliore è non muovere un blob
//  - consapevolezza delle minacce: dopo ogni azione simulata controlla se
//    l'avversario può segnare IN UN COLPO dalla posizione risultante, e
//    penalizza pesantemente le mosse che lasciano la porta scoperta
//  - finte più furbe: solo quando conviene, mai buttando via la mossa chiave
//  - selezione più affilata (temperature più basse), rollout più lunghi
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./physics'));
  else root.AI = factory(root.PHY);
})(typeof self !== 'undefined' ? self : this, function (PHY) {

const { HOLES, MAX_ARROW, rollout } = PHY;

const LEVELS = {
  facile:  { jitterAng: 0.20, jitterPow: 0.15, temp: 350, predictW: 0.0,  threatW: 0.0, candPerGlob: 4, decoyP: 0.20, lazyP: 0.30 },
  normale: { jitterAng: 0.06, jitterPow: 0.06, temp: 90,  predictW: 0.40, threatW: 0.7, candPerGlob: 7, decoyP: 0.08, lazyP: 0.0  },
  pro:     { jitterAng: 0.02, jitterPow: 0.03, temp: 15,  predictW: 0.60, threatW: 1.0, candPerGlob: 9, decoyP: 0.04, lazyP: 0.0  },
};

const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const clampArrow = (dx, dy) => {
  const l = Math.hypot(dx, dy);
  return l > MAX_ARROW ? [dx * MAX_ARROW / l, dy * MAX_ARROW / l] : [dx, dy];
};

class Bot {
  constructor(team = 1, level = 'normale') {
    this.team = team;
    this.cfg = LEVELS[level] || LEVELS.normale;
    this.enemyHole = HOLES.find(h => h.scorer === team);   // dove segno io
    this.ownHole = HOLES.find(h => h.scorer !== team);     // la mia porta
  }

  // Colpo "ghost ball": colpisci `obj` in modo che prosegua verso `target`.
  aimThrough(glob, obj, target, power = 1) {
    const [dx, dy] = norm(target.x - obj.x, target.y - obj.y);
    const contactX = obj.x - dx * (obj.r + glob.r) * 0.98;
    const contactY = obj.y - dy * (obj.r + glob.r) * 0.98;
    return clampArrow((contactX - glob.x) * 3 * power + dx * 40 * power,
                      (contactY - glob.y) * 3 * power + dy * 40 * power);
  }

  jitter([dx, dy]) {
    const a = (Math.random() * 2 - 1) * this.cfg.jitterAng;
    const p = 1 + (Math.random() * 2 - 1) * this.cfg.jitterPow;
    const c = Math.cos(a), s = Math.sin(a);
    return clampArrow((dx * c - dy * s) * p, (dx * s + dy * c) * p);
  }

  // Candidate per un singolo blob. Il jitter è applicato QUI, così la
  // valutazione riguarda il colpo che verrà davvero eseguito.
  candidates(glob, ents) {
    const ball = ents.find(e => e.id === 'ball');
    const enemies = ents.filter(e => e.team === 1 - this.team && !e.dead);
    const out = [{ name: 'fermo', v: null }];             // non muoversi è una mossa
    if (ball && !ball.dead) {
      for (const pw of [1, 0.75, 0.5])
        out.push({ name: 'tiro' + pw, v: this.jitter(this.aimThrough(glob, ball, this.enemyHole, pw)) });
      const side = Math.random() < 0.5 ? -1 : 1;
      out.push({ name: 'tiro_angolo', v: this.jitter(this.aimThrough(glob, ball, { x: this.enemyHole.x + side * 260, y: this.enemyHole.y + (this.team === 1 ? 120 : -120) }, 0.9)) });
      const dOwn = Math.hypot(ball.x - this.ownHole.x, ball.y - this.ownHole.y);
      if (dOwn < 420) out.push({ name: 'spazzata', v: this.jitter(this.aimThrough(glob, ball, { x: ball.x < 500 ? 850 : 150, y: 500 }, 1)) });
      const bx = ball.x + (this.ownHole.x - ball.x) * 0.45;
      const by = ball.y + (this.ownHole.y - ball.y) * 0.45;
      out.push({ name: 'blocco', v: this.jitter(clampArrow((bx - glob.x) * 0.9, (by - glob.y) * 0.9)) });
    }
    if (enemies.length) {
      const tgt = enemies.reduce((a, b) => (Math.hypot(b.x - glob.x, b.y - glob.y) < Math.hypot(a.x - glob.x, a.y - glob.y) ? b : a));
      const hole = HOLES.reduce((a, b) => (Math.hypot(b.x - tgt.x, b.y - tgt.y) < Math.hypot(a.x - tgt.x, a.y - tgt.y) ? b : a));
      out.push({ name: 'attacco', v: this.jitter(this.aimThrough(glob, tgt, hole, 1)) });
    }
    return out.slice(0, this.cfg.candPerGlob + 1);
  }

  // Il tiro umano più probabile: il blob avversario più vicino alla palla
  // la spara verso la mia porta.
  predictOpponent(ents) {
    const ball = ents.find(e => e.id === 'ball');
    const opp = ents.filter(e => e.team === 1 - this.team && !e.dead);
    if (!ball || ball.dead || !opp.length) return [];
    const byDist = [...opp].sort((a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
    return byDist.slice(0, 2).map(sh => ({ [sh.id]: this.aimThrough(sh, ball, this.ownHole, 1) }));
  }

  // Dalla posizione risultante, quanti blob avversari hanno un GOL in un colpo?
  countThreats(ents) {
    const ball = ents.find(e => e.id === 'ball');
    if (!ball || ball.dead) return 0;
    const opp = ents.filter(e => e.team === 1 - this.team && !e.dead);
    let threats = 0;
    for (const g of opp) {
      const shot = this.aimThrough(g, ball, this.ownHole, 1);
      const res = rollout(ents, { [1 - this.team]: { [g.id]: shot }, [this.team]: {} }, 5);
      if (res.goal === 1 - this.team) threats++;
    }
    return threats;
  }

  evalOutcome(res) {
    const t = this.team, opp = 1 - t;
    let s = 0;
    if (res.goal === t) s += 10000 + (6 - res.time) * 300;
    if (res.goal === opp) s -= 13000;
    for (const f of res.fell) {
      if (f.team === opp) s += 900;
      if (f.team === t) s -= 1100;
    }
    const ball = res.ents.find(e => e.id === 'ball');
    if (ball && !ball.dead) {
      s -= Math.hypot(ball.x - this.enemyHole.x, ball.y - this.enemyHole.y) * 1.1;
      s += Math.hypot(ball.x - this.ownHole.x, ball.y - this.ownHole.y) * 0.6;
      const mine = res.ents.filter(e => e.team === t && !e.dead);
      let best = 1e9;
      for (const g of mine) {
        const mx = (ball.x + this.ownHole.x) / 2, my = (ball.y + this.ownHole.y) / 2;
        best = Math.min(best, Math.hypot(g.x - mx, g.y - my));
      }
      if (best < 200) s += 200 - best;
    }
    // posizioni pericolose: miei blob a bordo buca = male, avversari = bene
    for (const e of res.ents) {
      if (e.dead || e.team < 0) continue;
      const dh = Math.min(...HOLES.map(h => Math.hypot(e.x - h.x, e.y - h.y)));
      if (dh < 140) s += (e.team === t ? -1 : 1) * (140 - dh) * 2.5;
    }
    return s + (Math.random() * 2 - 1) * 30;
  }

  compute(entsInput) {
    const ents = entsInput.map(e => ({ ...e }));
    const mine = ents.filter(e => e.team === this.team && !e.dead);
    if (!mine.length) return {};
    const predicted = this.predictOpponent(ents);
    const oppKey = 1 - this.team;

    // 1) screening: ogni candidata da sola, tieni le migliori 2 per blob
    const topPerGlob = {};
    for (const g of mine) {
      const scored = this.candidates(g, ents).map(c => {
        const mv = c.v ? { [g.id]: c.v } : {};
        const res = rollout(ents, { [this.team]: mv, [oppKey]: {} }, 8);
        return { ...c, score: this.evalOutcome(res) };
      }).sort((a, b) => b.score - a.score);
      topPerGlob[g.id] = scored.slice(0, 2);
    }

    // 2) combo delle migliori (max 8), rollout congiunto + risposta prevista
    const ids = Object.keys(topPerGlob);
    const combos = [];
    const build = (i, acc) => {
      if (i === ids.length) { combos.push({ ...acc }); return; }
      for (const c of topPerGlob[ids[i]]) {
        const next = { ...acc };
        if (c.v) next[ids[i]] = c.v;
        build(i + 1, next);
      }
    };
    build(0, {});

    let scored = combos.map(moves => {
      const resIdle = rollout(ents, { [this.team]: moves, [oppKey]: {} }, 8);
      let sc = this.evalOutcome(resIdle);
      if (this.cfg.predictW > 0 && predicted.length) {
        let worst = Infinity;                            // difesa robusta: lo scenario peggiore
        for (const p of predicted)
          worst = Math.min(worst, this.evalOutcome(rollout(ents, { [this.team]: moves, [oppKey]: p }, 8)));
        sc = sc * (1 - this.cfg.predictW) + worst * this.cfg.predictW;
      }
      return { moves, sc, resIdle };
    }).sort((a, b) => b.sc - a.sc);

    // 3) minacce: sulle 4 migliori, controlla se lascio all'avversario un
    //    gol in un colpo, e penalizza. È qui che l'AI smette di essere ingenua.
    if (this.cfg.threatW > 0) {
      const top = scored.slice(0, 6);
      for (const c of top) {
        if (c.resIdle.goal === this.team) continue;      // se segno io, l'azione si chiude lì
        const th = this.countThreats(c.resIdle.ents);
        if (th > 0) c.sc -= this.cfg.threatW * (3000 + 900 * (th - 1));
      }
      scored = [...top, ...scored.slice(6)].sort((a, b) => b.sc - a.sc);
    }

    // 4) softmax: imprevedibile ma sensato
    const T = this.cfg.temp;
    const ws = scored.map(c => Math.exp((c.sc - scored[0].sc) / T));
    const tot = ws.reduce((a, b) => a + b, 0);
    let r = Math.random() * tot, pick = scored[0];
    for (let i = 0; i < scored.length; i++) { r -= ws[i]; if (r <= 0) { pick = scored[i]; break; } }
    const moves = { ...pick.moves };

    // 5) finta: solo se la posizione è già buona, sacrificando il blob
    //    meno prezioso — mai la mossa decisiva
    if (Math.random() < this.cfg.decoyP && Object.keys(moves).length > 1 && pick.sc > 0) {
      const sorted = Object.keys(moves).sort((a, b) => {
        const va = topPerGlob[a] ? topPerGlob[a][0].score : 0;
        const vb = topPerGlob[b] ? topPerGlob[b][0].score : 0;
        return va - vb;
      });
      const id = sorted[0];
      const g = mine.find(e => e.id === id);
      if (g) moves[id] = clampArrow((Math.random() < 0.5 ? -1 : 1) * (140 + Math.random() * 100), (Math.random() * 2 - 1) * 120);
    }
    // 6) pigrizia: solo a livello facile
    if (Math.random() < this.cfg.lazyP && Object.keys(moves).length > 1)
      delete moves[Object.keys(moves)[0]];

    return moves;
  }
}

return { Bot, LEVELS };
});
