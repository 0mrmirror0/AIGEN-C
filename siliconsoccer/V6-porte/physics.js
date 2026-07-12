// Silicon Soccer — motore fisico condiviso (partita live + rollout dell'AI)
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PHY = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const W = 1000, H = 1000;
const HOLE_R = 62;
const WALL_Y = 80;        // muri di gioco sup/inf: le porte sono incassate oltre
const MOUTH_HALF = 62;    // semiapertura della bocca
const HOLES = [
  { x: W / 2, y: WALL_Y,     scorer: 0 }, // porta in alto: palla dentro = punto ROSSO
  { x: W / 2, y: H - WALL_Y, scorer: 1 }, // porta in basso: punto BLU
];
const GLOB_R = 27, BALL_R = 17;
const GLOB_M = 1.0, BALL_M = 0.5;
const DT = 1 / 60;
const DAMP = 0.988;
const REST_WALL = 0.78;
const REST_BODY = 0.92;
const STOP_V = 6;
const MAX_SIM_S = 9;
const MAX_ARROW = 240;
const POWER = 3.4;

// Telaio delle porte: piloni + barra posteriore, SOLIDI (capsule statiche)
const GOAL_POSTS = (() => {
  const caps = [];
  for (const h of HOLES) {
    const out = h.y < H / 2 ? -1 : 1;                    // direzione fuori campo
    const px = HOLE_R * 1.30;
    for (const s of [-1, 1])
      caps.push({ ax: h.x + s * px, ay: h.y + out * 18, bx: h.x + s * px, by: h.y - out * 52, r: 9, scorer: h.scorer, kind: 'post' });
  }
  return caps;
})();

function startEnts() {
  return [
    { id: 'r1', team: 0, x: 370, y: 740, r: GLOB_R, m: GLOB_M },
    { id: 'r2', team: 0, x: 500, y: 680, r: GLOB_R, m: GLOB_M },
    { id: 'r3', team: 0, x: 630, y: 740, r: GLOB_R, m: GLOB_M },
    { id: 'b1', team: 1, x: 370, y: 260, r: GLOB_R, m: GLOB_M },
    { id: 'b2', team: 1, x: 500, y: 320, r: GLOB_R, m: GLOB_M },
    { id: 'b3', team: 1, x: 630, y: 260, r: GLOB_R, m: GLOB_M },
    { id: 'ball', team: -1, x: 500, y: 500, r: BALL_R, m: BALL_M },
  ].map(e => ({ ...e, vx: 0, vy: 0, dead: false }));
}

// Un passo di fisica. Muta `ents`. Ritorna { goal, fell } dove goal è la squadra
// che segna se la palla cade in buca in questo passo (altrimenti null).
function stepOnce(ents, dt, damp) {
  let goal = null;
  const fell = [];

  for (const e of ents) {
    if (e.dead) continue;
    e.x += e.vx * dt; e.y += e.vy * dt;
    e.vx *= damp; e.vy *= damp;
    // pareti
    if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx) * REST_WALL; }
    if (e.x > W - e.r) { e.x = W - e.r; e.vx = -Math.abs(e.vx) * REST_WALL; }
    const inMouth = Math.abs(e.x - W / 2) < MOUTH_HALF;
    if (!inMouth) {
      if (e.y < WALL_Y + e.r) { e.y = WALL_Y + e.r; e.vy = Math.abs(e.vy) * REST_WALL; }
      if (e.y > H - WALL_Y - e.r) { e.y = H - WALL_Y - e.r; e.vy = -Math.abs(e.vy) * REST_WALL; }
    } else {
      // dentro la tasca: parete curva del semicerchio
      for (const h of HOLES) {
        const out = h.y < H / 2 ? -1 : 1;
        const beyond = out < 0 ? e.y < h.y : e.y > h.y;
        if (!beyond) continue;
        const dx = e.x - h.x, dy = e.y - h.y, d = Math.hypot(dx, dy);
        if (d > HOLE_R - e.r) {
          const nx = dx / (d || 1), ny = dy / (d || 1);
          e.x = h.x + nx * (HOLE_R - e.r); e.y = h.y + ny * (HOLE_R - e.r);
          const vn = e.vx * nx + e.vy * ny;
          if (vn > 0) { e.vx -= (1 + REST_WALL) * vn * nx; e.vy -= (1 + REST_WALL) * vn * ny; }
        }
      }
    }
    // telaio porte: rimbalzo su piloni e barra posteriore
    for (const c of GOAL_POSTS) {
      const abx = c.bx - c.ax, aby = c.by - c.ay;
      const t = Math.max(0, Math.min(1, ((e.x - c.ax) * abx + (e.y - c.ay) * aby) / ((abx * abx + aby * aby) || 1)));
      const qx = c.ax + abx * t, qy = c.ay + aby * t;
      const dx2 = e.x - qx, dy2 = e.y - qy, d2 = Math.hypot(dx2, dy2), min2 = e.r + c.r;
      if (d2 > 0 && d2 < min2) {
        const nx = dx2 / d2, ny = dy2 / d2;
        e.x = qx + nx * min2; e.y = qy + ny * min2;
        const vn = e.vx * nx + e.vy * ny;
        if (vn < 0) { e.vx -= (1 + REST_WALL) * vn * nx; e.vy -= (1 + REST_WALL) * vn * ny; }
      }
    }
    // buche: risucchio + cattura
    for (const h of HOLES) {
      const dx = h.x - e.x, dy = h.y - e.y, d = Math.hypot(dx, dy);
      if (d < HOLE_R + e.r * 0.4) {
        const pull = 3120 * (1 - d / (HOLE_R + e.r));  // +20% di risucchio
        e.vx += (dx / (d || 1)) * pull * dt;
        e.vy += (dy / (d || 1)) * pull * dt;
        const speed = Math.hypot(e.vx, e.vy);
        const out2 = h.y < H / 2 ? -1 : 1;
        const beyond2 = out2 < 0 ? e.y < h.y : e.y > h.y;
        if ((beyond2 && speed < 1400) || (d < HOLE_R * 0.5 && speed < 1100)) {
          e.dead = true; e.x = h.x; e.y = h.y + out2 * HOLE_R * 0.3; e.vx = 0; e.vy = 0;
          fell.push({ id: e.id, team: e.team, hole: { x: h.x, y: h.y } });
          if (e.id === 'ball' && goal === null) goal = h.scorer;
          break;
        }
      }
    }
    if (e.dead) continue;
    if (Math.hypot(e.vx, e.vy) < STOP_V) { e.vx = 0; e.vy = 0; }
  }

  // collisioni corpo-corpo
  const live = ents.filter(e => !e.dead);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy), min = a.r + b.r;
    if (d > 0 && d < min) {
      const nx = dx / d, ny = dy / d;
      const overlap = min - d, tm = a.m + b.m;
      a.x -= nx * overlap * (b.m / tm); a.y -= ny * overlap * (b.m / tm);
      b.x += nx * overlap * (a.m / tm); b.y += ny * overlap * (a.m / tm);
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        const jimp = -(1 + REST_BODY) * vn / (1 / a.m + 1 / b.m);
        a.vx -= (jimp * nx) / a.m; a.vy -= (jimp * ny) / a.m;
        b.vx += (jimp * nx) / b.m; b.vy += (jimp * ny) / b.m;
      }
    }
  }
  return { goal, fell };
}

// Se una squadra è rimasta senza blob, ritorna chi segna (l'avversaria), altrimenti null.
function checkWipe(ents) {
  for (const t of [0, 1])
    if (!ents.some(e => e.team === t && !e.dead)) return 1 - t;
  return null;
}

function allStopped(ents) {
  return ents.every(e => e.dead || (e.vx === 0 && e.vy === 0));
}

// Simulazione completa e sincrona di un'azione (per i rollout dell'AI).
// movesByTeam: { 0: {id:[dx,dy]}, 1: {id:[dx,dy]} }
function rollout(entsInput, movesByTeam, maxS = 6) {
  const ents = entsInput.map(e => ({ ...e }));
  for (const t of [0, 1]) {
    for (const [id, v] of Object.entries(movesByTeam[t] || {})) {
      const e = ents.find(x => x.id === id);
      if (e && !e.dead && e.team === t) { e.vx = v[0] * POWER; e.vy = v[1] * POWER; }
    }
  }
  let goal = null, time = 0;
  const fell = [];
  while (time < maxS) {
    const ev = stepOnce(ents, DT, DAMP);
    time += DT;
    fell.push(...ev.fell);
    if (ev.goal !== null) { goal = ev.goal; break; }
    const w = checkWipe(ents);
    if (w !== null) { goal = w; break; }
    if (allStopped(ents)) break;
  }
  return { goal, fell, ents, time };
}

return {
  W, H, HOLES, HOLE_R, GLOB_R, BALL_R, DT, DAMP, REST_WALL, REST_BODY,
  STOP_V, MAX_SIM_S, MAX_ARROW, POWER, GOAL_POSTS, WALL_Y, MOUTH_HALF,
  startEnts, stepOnce, checkWipe, allStopped, rollout,
};
});
