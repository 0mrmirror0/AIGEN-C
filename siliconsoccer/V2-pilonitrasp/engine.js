// Silicon Soccer — macchina di stato della partita, condivisa tra
// server LAN (Node) e single player nel browser. UMD.
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports)
    module.exports = factory(require('./physics'), require('./ai'));
  else root.ENGINE = factory(root.PHY, root.AI);
})(typeof self !== 'undefined' ? self : this, function (PHY, AI) {

  const { HOLES, HOLE_R, W, H, DT, DAMP, MAX_SIM_S, MAX_ARROW, POWER, startEnts } = PHY;

  class GameEngine {
    // opts: { planSeconds, simSpeed, winScore, emit(msg) }
    constructor(opts = {}) {
      this.planSeconds = opts.planSeconds ?? 20;
      this.simSpeed = opts.simSpeed ?? 0.65;
      this.winScore = opts.winScore ?? 3;
      this.emit = opts.emit || (() => {});
      this.SDT = DT * this.simSpeed;
      this.SDAMP = Math.pow(DAMP, this.simSpeed);
      this.connected = [false, false];
      this.bot = null;
      this.simTimer = null; this.planTimer = null; this.tick = 0;
      this.g = {
        phase: 'waiting', ents: startEnts(), score: [0, 0], planDeadline: 0,
        moves: [{}, {}], ready: [false, false], simTime: 0,
        lastGoalBy: null, goalReason: null, winner: null, round: 0,
        startReady: [false, false], recording: [], lastReplay: [],
      };
    }

    cfg() { return { W, H, HOLES, HOLE_R, MAX_ARROW, WIN_SCORE: this.winScore, PLAN_SECONDS: this.planSeconds }; }

    publicState() {
      const g = this.g;
      return {
        t: 'state', phase: g.phase, score: g.score, round: g.round,
        ents: g.ents.map(e => ({ id: e.id, team: e.team, x: +e.x.toFixed(1), y: +e.y.toFixed(1), vx: +e.vx.toFixed(1), vy: +e.vy.toFixed(1), r: e.r, dead: e.dead })),
        planLeft: g.phase === 'plan' ? Math.max(0, (g.planDeadline - Date.now()) / 1000) : 0,
        ready: g.ready, startReady: g.startReady,
        lastGoalBy: g.lastGoalBy, goalReason: g.goalReason, winner: g.winner,
        connected: [...this.connected],
        bot: this.bot ? this.bot.levelName : null,
      };
    }
    push() { this.emit(this.publicState()); }

    // ---- ingressi dall'esterno ----
    setConnected(slot, val) {
      this.connected[slot] = val;
      if (!val) {
        if (slot === 0 && this.bot) { this.bot = null; this.connected[1] = false; }
        this.stopTimers();
        this.g.phase = 'waiting'; this.g.ready = [false, false];
        this.push();
      } else if (this.connected[0] && this.connected[1] && this.g.phase === 'waiting') {
        this.enterLobby();
      } else this.push();
    }

    addBot(level = 'normale') {
      if (this.g.phase !== 'waiting' || this.connected[1]) return;
      const lv = ['facile', 'normale', 'pro'].includes(level) ? level : 'normale';
      this.bot = new AI.Bot(1, lv); this.bot.levelName = lv;
      this.connected[1] = true;
      this.enterLobby();
    }

    setMoves(slot, moves) {
      if (this.g.phase !== 'plan') return;
      const clean = {};
      for (const [id, v] of Object.entries(moves || {})) {
        const e = this.g.ents.find(x => x.id === id);
        if (!e || e.team !== slot || e.dead) continue;
        let dx = +v[0] || 0, dy = +v[1] || 0;
        const len = Math.hypot(dx, dy);
        if (len > MAX_ARROW) { dx *= MAX_ARROW / len; dy *= MAX_ARROW / len; }
        clean[id] = [dx, dy];
      }
      this.g.moves[slot] = clean;
    }

    ready(slot) {
      if (this.g.phase !== 'plan') return;
      this.g.ready[slot] = true;
      this.push();
      if (this.g.ready[0] && this.g.ready[1]) this.startSim();
    }

    start(slot) {
      if (this.g.phase !== 'lobby') return;
      this.g.startReady[slot] = true;
      this.push();
      if (this.g.startReady[0] && this.g.startReady[1]) this.startPlan();
    }

    rematch() {
      if (this.g.phase !== 'over') return;
      this.resetMatch(); this.enterLobby();
    }

    destroy() { this.stopTimers(); this.emit = () => {}; }

    // ---- fasi ----
    stopTimers() {
      clearInterval(this.simTimer); this.simTimer = null;
      clearTimeout(this.planTimer); this.planTimer = null;
      clearTimeout(this.botTimer); this.botTimer = null;
    }

    enterLobby() {
      this.stopTimers();
      this.g.phase = 'lobby'; this.g.startReady = [false, false];
      if (this.bot) this.g.startReady[1] = true;
      this.push();
    }

    startPlan() {
      this.stopTimers();
      const g = this.g;
      g.phase = 'plan'; g.round++;
      g.moves = [{}, {}]; g.ready = [false, false];
      g.planDeadline = Date.now() + this.planSeconds * 1000;
      this.planTimer = setTimeout(() => { if (g.phase === 'plan') this.startSim(); }, this.planSeconds * 1000);
      this.push();
      if (this.bot) {
        const thinking = 900 + Math.random() * 2600;
        const myRound = g.round;
        this.botTimer = setTimeout(() => {
          if (g.phase !== 'plan' || g.round !== myRound || !this.bot) return;
          g.moves[1] = this.bot.compute(g.ents);
          g.ready[1] = true;
          this.push();
          if (g.ready[0] && g.ready[1]) this.startSim();
        }, thinking);
      }
    }

    startSim() {
      this.stopTimers();
      const g = this.g;
      g.phase = 'sim'; g.simTime = 0;
      for (const s of [0, 1]) {
        for (const [id, v] of Object.entries(g.moves[s])) {
          const e = g.ents.find(x => x.id === id);
          if (e && !e.dead) { e.vx = v[0] * POWER; e.vy = v[1] * POWER; }
        }
      }
      this.emit({ t: 'launch' });
      g.recording = [];
      this.simTimer = setInterval(() => this.stepSim(), DT * 1000);
    }

    stepSim() {
      const g = this.g;
      g.simTime += this.SDT;
      const ev = PHY.stepOnce(g.ents, this.SDT, this.SDAMP);
      for (const f of ev.fell) this.emit({ t: 'fall', id: f.id, hole: f.hole });

      let goalBy = null, goalReason = null;
      if (ev.goal !== null) { goalBy = ev.goal; goalReason = 'goal'; }
      else if (ev.fell.some(f => f.team >= 0)) {
        const w = PHY.checkWipe(g.ents);
        if (w !== null) { goalBy = w; goalReason = 'wipe'; }
      }

      if (++this.tick % 2 === 0) {
        this.push();
        g.recording.push(g.ents.map(e => [e.id, +e.x.toFixed(1), +e.y.toFixed(1), +e.vx.toFixed(0), +e.vy.toFixed(0), e.dead ? 1 : 0]));
      }

      if (goalBy !== null) { this.finishReplay(); this.onGoal(goalBy, goalReason); return; }
      if (PHY.allStopped(g.ents) || g.simTime > MAX_SIM_S) {
        this.stopTimers();
        this.finishReplay();
        this.push();
        this.startPlan();
      }
    }

    finishReplay() {
      const g = this.g;
      if (g.recording.length > 5) {
        g.lastReplay = g.recording;
        this.emit({ t: 'replay', frames: g.lastReplay });
      }
      g.recording = [];
    }

    onGoal(by, reason) {
      this.stopTimers();
      const g = this.g;
      g.score[by]++; g.lastGoalBy = by; g.goalReason = reason || 'goal'; g.phase = 'goal';
      this.push();
      setTimeout(() => {
        if (g.phase !== 'goal') return;
        if (g.score[by] >= this.winScore) {
          g.phase = 'over'; g.winner = by;
          this.push();
        } else {
          this.resetPositions();
          this.startPlan();
        }
      }, 2600);
    }

    resetPositions() {
      const fresh = startEnts();
      for (const e of this.g.ents) Object.assign(e, fresh.find(x => x.id === e.id));
    }
    resetMatch() {
      const g = this.g;
      g.score = [0, 0]; g.winner = null; g.lastGoalBy = null; g.goalReason = null; g.round = 0;
      this.resetPositions();
    }
  }

  return { GameEngine };
});
