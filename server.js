const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const FPS = 60;
const W = 960;
const H = 540;
const FLOOR = 430;
const LEFT = 24;
const RIGHT = 936;
const GRAVITY = 0.9;
const ROUND_TIME = 99 * FPS;
const ROUNDS_TO_WIN = 3;

const PROMOTION_MAX = 140;
const QUEEN_TIME = 6 * FPS;
const BISHOP_SWORD_TIME = QUEEN_TIME;
const ULTIMATE_MAX = 100;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Simple Bruiser",
    hp: 780,
    speed: 7.0,
    jump: 15,
    w: 72,
    h: 124
  },
  rook: {
    name: "Rook",
    title: "Tanky Zoner",
    hp: 820,
    speed: 6.0,
    jump: 14.8,
    w: 82,
    h: 128
  },
  bishop: {
    name: "Bishop",
    title: "Diagonal Zoner",
    hp: 650,
    speed: 7.8,
    jump: 18.2,
    w: 64,
    h: 122
  },
  knight: {
    name: "Knight",
    title: "Swift Evader",
    hp: 660,
    speed: 8.6,
    jump: 20.5,
    w: 66,
    h: 116
  },
  pawn: {
    name: "Pawn",
    title: "Promotable Underdog",
    hp: 540,
    speed: 7.2,
    jump: 17,
    w: 56,
    h: 106
  }
};

const players = {};
const lobbies = {};
const leaderboard = {};
let nextLobbyId = 1;

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function cleanName(v) {
  return String(v || "Nameless").trim().slice(0, 18) || "Nameless";
}

function room(id) {
  return `lobby:${id}`;
}

function charData(key) {
  return CHARACTERS[key] || CHARACTERS.king;
}

function pieceOf(f) {
  if (f.characterKey === "pawn" && f.promoted) return "queen";
  return f.characterKey;
}

function isBishopSword(f) {
  return !!(
    f &&
    f.characterKey === "bishop" &&
    f.ultimateState &&
    f.ultimateState.type === "bishopSword" &&
    f.ultimateState.phase === "active"
  );
}

function makeFighter(id, side, key) {
  const c = charData(key);

  return {
    id,
    side,
    name: players[id]?.name || side,
    characterKey: key,
    characterName: c.name,

    x: side === "white" ? 220 : 690,
    y: FLOOR - c.h,
    vx: 0,
    vy: 0,
    w: c.w,
    h: c.h,
    standH: c.h,
    crouchH: Math.floor(c.h * 0.72),

    hp: c.hp,
    maxHp: c.hp,
    speed: c.speed,
    baseSpeed: c.speed,
    jump: c.jump,

    facing: side === "white" ? 1 : -1,
    attackFacing: side === "white" ? 1 : -1,
    grounded: true,
    crouching: false,

    attack: null,
    attackTimer: 0,
    attackDuration: 0,
    attackAim: "forward",
    attackId: 0,
    hitDone: false,
    hitList: [],
    multiHitWait: 0,

    lightCd: 0,
    heavyCd: 0,
    specialCd: 0,
    counterCd: 0,
    ultimateCd: 0,

    stamina: 100,
    maxStamina: 100,
    staminaDelay: 0,

    ultimate: 0,
    ultimateMax: ULTIMATE_MAX,
    ultimateState: null,

    hurt: 0,
    armor: 0,
    invuln: 0,
    stun: 0,

    dashCd: 0,
    airDashUsed: false,

    coyote: 0,
    jumpBuffer: 0,

    wallBounceTimer: 0,
    wallBouncePower: 0,

    promoted: false,
    promotion: 0,
    queenTimer: 0,
    savedPawnStats: null,

    script: null,

    lastSeq: {
      light: 0,
      heavy: 0,
      special: 0,
      counter: 0,
      ultimate: 0,
      jump: 0
    }
  };
}

function publicLobbies() {
  return Object.values(lobbies).map((l) => ({
    id: l.id,
    name: l.name,
    status: l.status,
    whiteName: players[l.whiteId]?.name || null,
    blackName: players[l.blackId]?.name || null,
    spectatorCount: l.spectators.size
  }));
}

function publicLeaderboard() {
  return Object.entries(leaderboard)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function sendLobbyData() {
  io.emit("lobbyData", {
    lobbies: publicLobbies(),
    leaderboard: publicLeaderboard(),
    characters: CHARACTERS
  });
}

function fx(game, type, x, y, extra = {}) {
  if (!game) return;

  if (!Number.isFinite(x)) x = W / 2;
  if (!Number.isFinite(y)) y = H / 2;

  game.effects.push({
    id: `${game.tick}:${type}:${game.effects.length}:${Math.random()}`,
    type,
    x: Math.round(x),
    y: Math.round(y),
    timer: extra.timer ?? 20,
    ...extra
  });

  if (game.effects.length > 320) {
    game.effects.splice(0, game.effects.length - 320);
  }
}

function tickEffects(game) {
  game.effects = game.effects.filter((e) => {
    e.timer--;
    return e.timer > 0;
  });
}

function initMatch(lobby) {
  lobby.match = {
    round: 1,
    whiteRounds: 0,
    blackRounds: 0,
    winner: null
  };
}

function startRound(lobby) {
  if (!lobby.match) initMatch(lobby);

  lobby.status = "playing";
  lobby.message = `Round ${lobby.match.round}. Fight.`;

  lobby.game = {
    tick: 0,
    roundTime: ROUND_TIME,
    effects: [],
    shake: 0,
    hitstop: 0,
    roundOver: false,
    roundWinner: null,
    roundOverTimer: 0,
    floorY: FLOOR,
    fighters: {
      white: makeFighter(lobby.whiteId, "white", players[lobby.whiteId].characterKey),
      black: makeFighter(lobby.blackId, "black", players[lobby.blackId].characterKey)
    }
  };
}

function sendGame(lobby) {
  io.to(room(lobby.id)).emit("gameState", {
    lobby: {
      id: lobby.id,
      name: lobby.name,
      status: lobby.status,
      whiteName: players[lobby.whiteId]?.name || null,
      blackName: players[lobby.blackId]?.name || null,
      message: lobby.message,
      winner: lobby.winner || null
    },
    match: lobby.match || null,
    game: lobby.game || null
  });
}

function leaveLobby(id) {
  const p = players[id];
  if (!p || !p.lobbyId) return;

  const lobby = lobbies[p.lobbyId];
  const socket = io.sockets.sockets.get(id);

  if (socket) socket.leave(room(p.lobbyId));

  if (!lobby) {
    p.lobbyId = null;
    p.role = "menu";
    return;
  }

  lobby.spectators.delete(id);

  if (lobby.whiteId === id) lobby.whiteId = null;
  if (lobby.blackId === id) lobby.blackId = null;

  if (lobby.status === "playing") {
    const remaining = lobby.whiteId || lobby.blackId;
    if (remaining && players[remaining]) {
      const winner = players[remaining].name;
      leaderboard[winner] = (leaderboard[winner] || 0) + 1;
      lobby.winner = winner;
      lobby.message = `${winner} wins by disconnect.`;
    }
    lobby.status = "finished";
    lobby.game = null;
  }

  if (!lobby.whiteId && !lobby.blackId && lobby.spectators.size === 0) {
    delete lobbies[lobby.id];
  }

  p.lobbyId = null;
  p.role = "menu";
}

function rect(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function aimFromInput(input) {
  if (input.up) return "up";
  if (input.down) return "down";
  return "forward";
}

function moveName(base, f) {
  if (base === "counter") return "counter";
  if (base === "ultimate") return "ultimate";

  if (!f.grounded) {
    if (base === "light") return "airLight";
    if (base === "heavy") return "airHeavy";
    if (base === "special") return "airSpecial";
  }

  if (f.crouching) {
    if (base === "light") return "crouchLight";
    if (base === "heavy") return "crouchHeavy";
  }

  return base;
}

function meta(f, attack = f.attack, aim = f.attackAim) {
  const p = pieceOf(f);
  const sword = isBishopSword(f);

  const m = {
    duration: 18,
    activeA: 5,
    activeB: 10,
    dmg: 5,
    kb: 12,
    lift: -2,
    stamina: 4,
    cd: 15,
    armor: 0,
    breakArmor: false,
    multi: false,
    interval: 9,
    wall: 15,
    grab: false,
    throwPower: 0,
    counterWindow: 0,
    ultimate: false,
    pierceOnce: false
  };

  if (attack === "counter") {
    Object.assign(m, {
      duration: 38,
      activeA: 15,
      activeB: 25,
      stamina: 18,
      cd: 115,
      dmg: 8,
      kb: 24,
      lift: -10,
      armor: 14,
      counterWindow: 14,
      wall: 30
    });

    if (p === "king") Object.assign(m, { dmg: 13, kb: 34, grab: true, throwPower: 34, cd: 140 });
    if (p === "rook") Object.assign(m, { dmg: 12, kb: 40, armor: 24, wall: 48, cd: 150 });
    if (p === "bishop") Object.assign(m, { dmg: sword ? 14 : 10, kb: sword ? 38 : 28, lift: sword ? -30 : -25, cd: sword ? 72 : 118, breakArmor: sword });
    if (p === "knight") Object.assign(m, { dmg: 10, kb: 31, lift: -18, cd: 110 });
    if (p === "pawn") Object.assign(m, { dmg: 8, kb: 24, cd: 92 });
    if (p === "queen") Object.assign(m, { dmg: 16, kb: 24, lift: -20, cd: 92, breakArmor: true });

    return m;
  }

  if (attack === "ultimate") {
    Object.assign(m, {
      ultimate: true,
      duration: 1,
      activeA: 0,
      activeB: 0,
      dmg: 0,
      kb: 0,
      lift: 0,
      stamina: 0,
      cd: 360,
      armor: 0,
      breakArmor: true,
      multi: false,
      interval: 0,
      wall: 0
    });

    return m;
  }

  if (p === "king") {
    if (attack === "light") Object.assign(m, { duration: 19, activeA: 5, activeB: 11, dmg: 9, kb: 14, cd: 16 });
    if (attack === "heavy") Object.assign(m, { duration: 36, activeA: 11, activeB: 20, dmg: 19, kb: 30, stamina: 13, cd: 50, armor: 22, breakArmor: true, wall: 38 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 34, activeA: 10, activeB: 18, dmg: 19, kb: 27, lift: -14, stamina: 11, cd: 48, armor: 14, wall: 32 });
    if (attack === "airHeavy") Object.assign(m, { duration: 31, activeA: 8, activeB: 17, dmg: 19, kb: 23, lift: 13, stamina: 10, cd: 44 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "down") Object.assign(m, { duration: 48, activeA: 11, activeB: 23, dmg: 30, stamina: 24, cd: 165, armor: 28, grab: true, throwPower: 60, wall: 52 });
      else if (aim === "up") Object.assign(m, { duration: 48, activeA: 12, activeB: 24, dmg: 24, kb: 20, lift: -36, stamina: 21, cd: 150, armor: 22, breakArmor: true });
      else Object.assign(m, { duration: 52, activeA: 14, activeB: 27, dmg: 24, kb: 36, stamina: 24, cd: 160, armor: 30, breakArmor: true, wall: 48 });
    }
  }

  if (p === "rook") {
    if (attack === "light") Object.assign(m, { duration: 20, activeA: 6, activeB: 12, dmg: 5, kb: 17, cd: 18 });
    if (attack === "heavy") Object.assign(m, { duration: 36, activeA: 11, activeB: 21, dmg: 12, kb: 32, stamina: 13, cd: 56, armor: 26, breakArmor: true, wall: 44 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 34, activeA: 10, activeB: 18, dmg: 10, kb: 30, stamina: 11, cd: 54, wall: 38 });
    if (attack === "airHeavy") Object.assign(m, { duration: 32, activeA: 8, activeB: 18, dmg: 10, kb: 26, lift: 12, stamina: 10, cd: 52 });

    if (attack === "special") {
      if (aim === "forward") Object.assign(m, { duration: 96, activeA: 44, activeB: 65, dmg: 8, kb: 46, stamina: 36, cd: 250, armor: 50, breakArmor: true, multi: true, interval: 9, wall: 62 });
      else if (aim === "up") Object.assign(m, { duration: 62, activeA: 16, activeB: 34, dmg: 8, kb: 20, lift: -33, stamina: 24, cd: 180, multi: true, interval: 10 });
      else Object.assign(m, { duration: 58, activeA: 14, activeB: 27, dmg: 8, kb: 38, stamina: 25, cd: 185, armor: 36, breakArmor: true, wall: 46 });
    }
  }

  if (p === "bishop") {
    if (attack === "light") {
      Object.assign(m, sword
        ? { duration: 18, activeA: 4, activeB: 12, dmg: 9, kb: 24, lift: -12, cd: 7, wall: 34 }
        : { duration: 17, activeA: 4, activeB: 10, dmg: 5, kb: 14, lift: -8, cd: 14 }
      );
    }

    if (attack === "heavy") {
      Object.assign(m, sword
        ? { duration: 29, activeA: 5, activeB: 19, dmg: 16, kb: 38, lift: -26, stamina: 8, cd: 24, breakArmor: true, wall: 54 }
        : { duration: 30, activeA: 6, activeB: 17, dmg: 10, kb: 26, lift: -21, stamina: 9, cd: 38 }
      );
    }

    if (attack === "crouchLight") {
      Object.assign(m, sword
        ? { duration: 14, activeA: 3, activeB: 10, dmg: 7, kb: 20, lift: -8, cd: 7 }
        : { duration: 15, activeA: 4, activeB: 9, dmg: 4, kb: 11, cd: 14 }
      );
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, sword
        ? { duration: 25, activeA: 6, activeB: 16, dmg: 13, kb: 32, lift: -18, stamina: 7, cd: 23, breakArmor: true, wall: 42 }
        : { duration: 28, activeA: 8, activeB: 16, dmg: 8, kb: 21, lift: -12, stamina: 8, cd: 38 }
      );
    }

    if (attack === "airHeavy") {
      Object.assign(m, sword
        ? { duration: 28, activeA: 4, activeB: 18, dmg: 15, kb: 34, lift: 22, stamina: 8, cd: 23, breakArmor: true, wall: 48 }
        : { duration: 30, activeA: 5, activeB: 17, dmg: 10, kb: 25, lift: 18, stamina: 9, cd: 38 }
      );
    }

    if (attack === "airSpecial") {
      Object.assign(m, sword
        ? { duration: 48, activeA: 4, activeB: 38, dmg: 10, kb: 28, lift: -10, stamina: 18, cd: 82, multi: true, interval: 10, wall: 48, breakArmor: true }
        : { duration: 58, activeA: 5, activeB: 46, dmg: 7, kb: 22, stamina: 23, cd: 170, multi: true, interval: 12, wall: 30 }
      );
    } else if (attack === "special") {
      if (aim === "up") {
        Object.assign(m, sword
          ? { duration: 36, activeA: 7, activeB: 21, dmg: 14, kb: 26, lift: -44, stamina: 14, cd: 62, breakArmor: true, wall: 44 }
          : { duration: 40, activeA: 9, activeB: 20, dmg: 10, kb: 20, lift: -34, stamina: 17, cd: 140 }
        );
      } else if (aim === "down") {
        Object.assign(m, sword
          ? { duration: 36, activeA: 7, activeB: 21, dmg: 15, kb: 42, lift: 18, stamina: 14, cd: 62, breakArmor: true, wall: 58 }
          : { duration: 40, activeA: 9, activeB: 20, dmg: 10, kb: 29, lift: 13, stamina: 17, cd: 140, breakArmor: true }
        );
      } else {
        Object.assign(m, sword
          ? { duration: 36, activeA: 7, activeB: 22, dmg: 15, kb: 40, lift: -16, stamina: 14, cd: 62, breakArmor: true, wall: 54 }
          : { duration: 40, activeA: 9, activeB: 20, dmg: 10, kb: 28, lift: -12, stamina: 17, cd: 140 }
        );
      }
    }
  }

  if (p === "knight") {
    if (attack === "light") Object.assign(m, { duration: 17, activeA: 4, activeB: 11, dmg: 5, kb: 14, lift: -5, cd: 13 });
    if (attack === "heavy") Object.assign(m, { duration: 27, activeA: 8, activeB: 15, dmg: 8, kb: 22, lift: -23, stamina: 8, cd: 34 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 24, activeA: 7, activeB: 13, dmg: 8, kb: 20, lift: -17, stamina: 8, cd: 34 });
    if (attack === "airHeavy") Object.assign(m, { duration: 32, activeA: 4, activeB: 22, dmg: 10, kb: 25, stamina: 10, cd: 40 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") Object.assign(m, { duration: 36, activeA: 8, activeB: 17, dmg: 9, kb: 20, lift: -38, stamina: 17, cd: 140 });
      else if (aim === "down") Object.assign(m, { duration: 36, activeA: 8, activeB: 17, dmg: 11, kb: 34, lift: 18, stamina: 18, cd: 145, breakArmor: true });
      else Object.assign(m, { duration: 36, activeA: 8, activeB: 17, dmg: 10, kb: 31, lift: -18, stamina: 17, cd: 140 });
    }
  }

  if (p === "pawn") {
    if (attack === "light") Object.assign(m, { duration: 16, activeA: 5, activeB: 10, dmg: 4, kb: 10, cd: 14 });
    if (attack === "heavy") Object.assign(m, { duration: 27, activeA: 8, activeB: 15, dmg: 7, kb: 17, stamina: 8, cd: 34 });
    if (attack === "crouchLight") Object.assign(m, { duration: 16, activeA: 5, activeB: 10, dmg: 3, kb: 9, cd: 14 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 27, activeA: 8, activeB: 15, dmg: 7, kb: 18, lift: -11, stamina: 8, cd: 36 });
    if (attack === "airHeavy") Object.assign(m, { duration: 27, activeA: 8, activeB: 15, dmg: 7, kb: 17, lift: 10, stamina: 8, cd: 34 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") Object.assign(m, { duration: 36, activeA: 8, activeB: 17, dmg: 7, kb: 15, lift: -25, stamina: 17, cd: 135 });
      else if (aim === "down") Object.assign(m, { duration: 36, activeA: 8, activeB: 16, dmg: 8, kb: 22, stamina: 17, cd: 135, breakArmor: true });
      else Object.assign(m, { duration: 36, activeA: 8, activeB: 16, dmg: 8, kb: 22, stamina: 17, cd: 135 });
    }
  }

  if (p === "queen") {
    if (attack === "light") Object.assign(m, { duration: 16, activeA: 4, activeB: 11, dmg: 12, kb: 18, cd: 13 });
    if (attack === "heavy") Object.assign(m, { duration: 30, activeA: 8, activeB: 17, dmg: 16, kb: 32, stamina: 10, cd: 42, breakArmor: true });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 30, activeA: 8, activeB: 17, dmg: 16, kb: 28, lift: -18, stamina: 10, cd: 42 });
    if (attack === "airHeavy") Object.assign(m, { duration: 30, activeA: 8, activeB: 16, dmg: 16, kb: 26, lift: 16, stamina: 10, cd: 42 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") Object.assign(m, { duration: 54, activeA: 13, activeB: 26, dmg: 18, kb: 23, lift: -40, stamina: 22, cd: 185, breakArmor: true });
      else if (aim === "down") Object.assign(m, { duration: 54, activeA: 13, activeB: 26, dmg: 18, kb: 36, lift: 14, stamina: 22, cd: 185, breakArmor: true });
      else Object.assign(m, { duration: 56, activeA: 13, activeB: 28, dmg: 18, kb: 40, stamina: 22, cd: 190, breakArmor: true });
    }
  }

  return m;
}

function active(f) {
  if (!f.attack) return false;
  const e = f.attackDuration - f.attackTimer;
  const m = meta(f);
  return e >= m.activeA && e <= m.activeB;
}

function counterWindow(f) {
  if (f.attack !== "counter") return false;
  const e = f.attackDuration - f.attackTimer;
  return e >= 0 && e <= meta(f).counterWindow;
}

function box(f) {
  const p = pieceOf(f);
  const a = f.attack;
  const aim = f.attackAim;
  const d = f.attackFacing || f.facing || 1;
  const sword = isBishopSword(f);

  function forward(w, h, y = 0, gap = 0) {
    return {
      x: d === 1 ? f.x + f.w + gap : f.x - w - gap,
      y: f.y + y,
      w,
      h
    };
  }

  function body(w, h, y = 0, off = 0) {
    const cx = f.x + f.w / 2 + d * off;
    return {
      x: cx - w / 2,
      y: f.y + y,
      w,
      h
    };
  }

  function up(w, h, off = 0) {
    return {
      x: f.x + f.w / 2 - w / 2 + d * off,
      y: f.y - h + 20,
      w,
      h
    };
  }

  function diag(w, h, y = 0, off = 0) {
    return {
      x: d === 1 ? f.x + f.w * 0.45 + off : f.x + f.w * 0.55 - w - off,
      y: f.y + y,
      w,
      h
    };
  }

  if (a === "counter") {
    if (p === "king") return forward(120, 96, 18);
    if (p === "rook") return body(200, 120, 4, 0);
    if (p === "bishop") return sword ? body(275, 180, -54, d * 40) : diag(190, 140, -54);
    if (p === "knight") return body(160, 112, -10, 36);
    if (p === "pawn") return forward(126, 54, 34);
    return body(260, 156, -14, 26);
  }

  if (p === "king") {
    if (a === "light") return forward(104, 56, 28);
    if (a === "heavy") return forward(150, 92, 12);
    if (a === "crouchHeavy") return forward(138, 60, f.h * 0.52);
    if (a === "airHeavy") return body(132, 108, 22, 22);
    if (a === "special" || a === "airSpecial") {
      if (aim === "up") return up(130, 240);
      if (aim === "down") return forward(92, 94, 20);
      return body(236, 136, -4, 54);
    }
  }

  if (p === "rook") {
    if (a === "light") return forward(150, 50, 40);
    if (a === "heavy") return forward(210, 94, 20);
    if (a === "crouchHeavy") return forward(180, 54, f.h * 0.55);
    if (a === "airHeavy") return forward(134, 102, 18);
    if (a === "special") {
      if (aim === "up") return up(110, 310);
      if (aim === "down") return forward(270, 66, f.h * 0.62);
      return d === 1
        ? { x: f.x + f.w, y: f.y + 18, w: RIGHT - (f.x + f.w), h: 112 }
        : { x: LEFT, y: f.y + 18, w: f.x - LEFT, h: 112 };
    }
  }

  if (p === "bishop") {
    if (a === "light") return sword ? forward(205, 104, -2) : forward(132, 82, 16);
    if (a === "heavy") return sword ? diag(285, 210, -125, 20) : diag(170, 140, -88, 16);
    if (a === "crouchLight") return sword ? forward(180, 56, f.h * 0.56) : forward(120, 36, f.h * 0.65);
    if (a === "crouchHeavy") return sword ? forward(240, 92, f.h * 0.38) : forward(150, 64, f.h * 0.45);
    if (a === "airHeavy") return sword ? diag(280, 220, -4, 20) : diag(170, 150, 18, 16);
    if (a === "airSpecial") return sword
      ? { x: f.x - 110, y: f.y - 95, w: f.w + 220, h: f.h + 190 }
      : { x: f.x - 48, y: f.y - 42, w: f.w + 96, h: f.h + 84 };
    if (a === "special") {
      if (aim === "up") return sword ? diag(310, 260, -210, 30) : diag(198, 180, -145, 30);
      if (aim === "down") return sword ? diag(320, 235, 26, 30) : diag(198, 180, 42, 30);
      return sword ? diag(350, 190, -42, 24) : diag(235, 145, -12, 28);
    }
  }

  if (p === "knight") {
    if (a === "light") return forward(104, 60, 28);
    if (a === "heavy") return body(112, 104, -12, 30);
    if (a === "crouchHeavy") return forward(102, 74, f.h * 0.43);
    if (a === "airHeavy") return { x: f.x - 32, y: f.y - 28, w: f.w + 64, h: f.h + 56 };
    if (a === "special" || a === "airSpecial") {
      if (aim === "up") return up(120, 154, 10);
      if (aim === "down") return body(142, 112, f.h * 0.3, 42);
      return body(140, 110, 0, 50);
    }
  }

  if (p === "pawn") {
    if (a === "light") return forward(94, 30, 40);
    if (a === "heavy") return forward(122, 58, 26);
    if (a === "crouchLight") return forward(88, 24, f.h * 0.66);
    if (a === "crouchHeavy") return forward(106, 56, f.h * 0.46);
    if (a === "airHeavy") return forward(100, 80, 16);
    if (a === "special" || a === "airSpecial") {
      if (aim === "up") return up(86, 136, 8);
      if (aim === "down") return forward(122, 54, f.h * 0.58);
      return forward(140, 48, 30);
    }
  }

  if (p === "queen") {
    if (a === "light") return forward(160, 80, 18);
    if (a === "heavy") return forward(224, 128, -6);
    if (a === "crouchHeavy") return forward(180, 66, f.h * 0.46);
    if (a === "airHeavy") return forward(160, 126, 8);
    if (a === "special" || a === "airSpecial") {
      if (aim === "up") return up(180, 280);
      if (aim === "down") return forward(300, 108, f.h * 0.34);
      return body(345, 180, -18, 50);
    }
  }

  return forward(80, 50, 20);
}

function promote(f) {
  if (f.characterKey !== "pawn" || f.promoted) return;

  f.savedPawnStats = {
    maxHp: f.maxHp,
    hpRatio: f.hp / f.maxHp,
    speed: f.speed,
    jump: f.jump,
    w: f.w,
    standH: f.standH,
    crouchH: f.crouchH,
    characterName: f.characterName
  };

  f.promoted = true;
  f.queenTimer = QUEEN_TIME;
  f.characterName = "Queen";
  f.promotion = PROMOTION_MAX;

  f.maxHp = Math.round(f.maxHp * 1.45);
  f.hp = Math.max(1, Math.ceil(f.maxHp * f.savedPawnStats.hpRatio));
  f.speed *= 1.12;
  f.jump *= 1.08;
  f.w += 8;
  f.standH += 16;
  f.crouchH = Math.floor(f.standH * 0.72);
  f.h = f.standH;
  f.armor = 24;
}

function unpromote(f) {
  if (!f.promoted || !f.savedPawnStats) return;

  const ratio = f.hp / f.maxHp;
  const s = f.savedPawnStats;

  f.promoted = false;
  f.characterName = "Pawn";
  f.maxHp = s.maxHp;
  f.hp = Math.max(1, Math.ceil(f.maxHp * ratio));
  f.speed = s.speed;
  f.jump = s.jump;
  f.w = s.w;
  f.standH = s.standH;
  f.crouchH = s.crouchH;
  f.h = f.crouching ? f.crouchH : f.standH;
  f.savedPawnStats = null;
  f.promotion = 0;
}

function charge(f, n) {
  if (f.characterKey !== "pawn" || f.promoted) return;
  f.promotion = clamp(f.promotion + n, 0, PROMOTION_MAX);
  if (f.promotion >= PROMOTION_MAX) promote(f);
}

function chargeUltimate(f, n) {
  if (!f || f.ultimateState) return;
  f.ultimate = clamp((f.ultimate || 0) + n, 0, f.ultimateMax || ULTIMATE_MAX);
}

function spendUltimate(f) {
  if ((f.ultimate || 0) < (f.ultimateMax || ULTIMATE_MAX)) return false;
  f.ultimate = 0;
  return true;
}

function fighterRect(f) {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

function makeHitbox(owner, x, y, w, h, data = {}) {
  return {
    ownerSide: owner.side,
    ownerId: owner.id,
    x,
    y,
    w,
    h,
    dmg: data.dmg ?? 8,
    kb: data.kb ?? 15,
    lift: data.lift ?? -5,
    wall: data.wall ?? 20,
    duration: data.duration ?? 1,
    hitstop: data.hitstop ?? 4,
    breakArmor: !!data.breakArmor,
    ultimate: !!data.ultimate,
    once: data.once !== false,
    hitKey: data.hitKey || `${owner.attackId}:${Math.random()}`,
    dir: data.dir ?? owner.attackFacing ?? owner.facing ?? 1,
    grab: !!data.grab,
    throwPower: data.throwPower ?? 0,
    label: data.label || "hitbox"
  };
}

function applyHitbox(attacker, defender, hb, game) {
  if (!attacker || !defender || defender.hp <= 0) return false;

  if (defender.invuln > 0 && !hb.ultimate) return false;

  if (counterWindow(defender) && !hb.ultimate) {
    triggerCounter(defender, attacker, game);
    return true;
  }

  if (!rect(hb, fighterRect(defender))) return false;

  if (!attacker.hitList) attacker.hitList = [];

  const unique = `${hb.hitKey}:${defender.side}`;
  if (hb.once && attacker.hitList.includes(unique)) return false;

  attacker.hitList.push(unique);

  if (hb.grab) {
    const d = hb.dir || attacker.attackFacing || attacker.facing || 1;

    defender.invuln = 0;
    defender.hurt = 36;
    defender.stun = Math.max(defender.stun, 18);
    defender.x = attacker.x + attacker.w / 2 + d * 55 - defender.w / 2;
    defender.y = Math.min(defender.y, attacker.y + attacker.h * 0.12);
    defender.vx = d * hb.throwPower * 1.52;
    defender.vy = -14;
    defender.hp = Math.max(0, defender.hp - hb.dmg);
    defender.wallBounceTimer = 50;
    defender.wallBouncePower = hb.wall;

    game.hitstop = Math.max(game.hitstop, hb.hitstop + 8);
    game.shake = Math.max(game.shake, 14);

    fx(game, "grab", defender.x + defender.w / 2, defender.y + defender.h / 2, {
      dir: d,
      piece: pieceOf(attacker),
      timer: 24
    });

    fx(game, "hit", defender.x + defender.w / 2, defender.y + defender.h / 2, {
      piece: pieceOf(attacker),
      attack: attacker.attack,
      dir: d,
      ultimate: hb.ultimate,
      timer: 18
    });

    return true;
  }

  let damage = hb.dmg;
  let knock = hb.kb * 1.52;
  let lift = hb.lift * 1.2;

  if (defender.armor > 0 && !hb.breakArmor) {
    damage = Math.ceil(damage * 0.5);
    knock *= 0.4;
    fx(game, "armor", defender.x + defender.w / 2, defender.y + defender.h / 2, { timer: 12 });
  } else {
    defender.hurt = hb.ultimate ? 16 : 12;
  }

  defender.hp = Math.max(0, defender.hp - damage);
  defender.vx += hb.dir * knock;
  defender.vy += lift;
  defender.wallBounceTimer = 46;
  defender.wallBouncePower = hb.wall;

  chargeUltimate(attacker, hb.ultimate ? 0 : damage * 1.15 + 2);
  chargeUltimate(defender, damage * 0.38 + 1);

  if (attacker.characterKey === "pawn" && !attacker.promoted) charge(attacker, 4.5 + damage * 0.28);
  if (defender.characterKey === "pawn" && !defender.promoted) charge(defender, 1.8 + damage * 0.08);

  if (attacker.ultimateState?.type === "pawnUprising") {
    attacker.ultimateState.hitsLanded++;
  }

  if (attacker.ultimateState?.type === "queenDominion") {
    attacker.ultimateState.hits++;
    const cx = attacker.x + attacker.w / 2;
    const dcx = defender.x + defender.w / 2;
    defender.vx += dcx < cx ? 3.2 : -3.2;
  }

  game.hitstop = Math.max(game.hitstop, hb.hitstop);
  game.shake = Math.max(game.shake, hb.ultimate ? 16 : damage >= 12 ? 10 : 6);

  fx(game, "hit", clamp(hb.x + hb.w / 2, defender.x, defender.x + defender.w), clamp(hb.y + hb.h / 2, defender.y, defender.y + defender.h), {
    piece: pieceOf(attacker),
    attack: attacker.attack,
    dir: hb.dir,
    damage,
    ultimate: hb.ultimate,
    timer: hb.ultimate ? 20 : 14
  });

  return true;
}

function knightPattern(f, input) {
  let primary;

  if (input.left && !input.right) primary = { x: -1, y: 0 };
  else if (input.right && !input.left) primary = { x: 1, y: 0 };
  else if (input.up && !input.down) primary = { x: 0, y: -1 };
  else if (input.down && !input.up) primary = { x: 0, y: 1 };
  else primary = { x: f.facing, y: 0 };

  let secondary;

  if (primary.x !== 0) {
    secondary = input.down && !input.up ? { x: 0, y: 1 } : { x: 0, y: -1 };
  } else {
    secondary = input.left && !input.right ? { x: -1, y: 0 } : input.right && !input.left ? { x: 1, y: 0 } : { x: f.facing, y: 0 };
  }

  return {
    type: "knightL",
    phase: 1,
    t: 7,
    t2: 6,
    primary,
    secondary,
    s1: 17,
    s2: 12,
    trail: []
  };
}

function bishopZigzag(f, input) {
  const dir = f.facing || 1;
  const yDir = input.down && !input.up ? 1 : -1;

  return {
    type: "bishopZigzag",
    dir,
    yDir,
    phase: 0,
    t: 8,
    sx: 10.8,
    sy: 9.4,
    trail: []
  };
}

function fixed(vx, vy, t) {
  return { type: "fixed", vx, vy, t, trail: [] };
}

function makeUltimateState(f, input) {
  const p = pieceOf(f);
  const d = f.facing || 1;

  if (p === "king") {
    return {
      type: "kingVerdict",
      phase: "hunt",
      timer: 0,
      duration: 155,
      grabRange: 96,
      dir: d,
      grabbed: false,
      shockwaveDone: false
    };
  }

  if (p === "rook") {
    return {
      type: "rookSiege",
      phase: "windup",
      timer: 0,
      dir: d,
      aimY: 0,
      fireEvery: 7,
      shots: 0,
      maxShots: 9
    };
  }

  if (p === "bishop") {
    return {
      type: "bishopSword",
      phase: "awakening",
      timer: 0,
      duration: BISHOP_SWORD_TIME,
      speedBonus: 1.16,
      pulse: 0
    };
  }

  if (p === "knight") {
    let firstDir = { x: d, y: 0 };

    if (input.up && !input.down) firstDir = { x: 0, y: -1 };
    else if (input.down && !input.up) firstDir = { x: 0, y: 1 };
    else if (input.left && !input.right) firstDir = { x: -1, y: 0 };
    else if (input.right && !input.left) firstDir = { x: 1, y: 0 };

    return {
      type: "knightCharge",
      phase: "windup",
      timer: 0,

      currentDir: firstDir,
      previousDir: null,
      segment: 0,
      maxSegments: 24,
      segmentTimer: 0,
      segmentLength: 6,

      queuedDir: null,
      lastTurnTick: 0,

      hits: 0,
      slamDone: false,

      trail: []
    };
  }

  if (p === "pawn") {
    return {
      type: "pawnUprising",
      phase: "buff",
      timer: 0,
      duration: 300,
      hitsNeeded: 4,
      hitsLanded: 0,
      promotedBurst: false
    };
  }

  return {
    type: "queenDominion",
    phase: "hyper",
    timer: 0,
    duration: 360,
    hits: 0,
    finisherDone: false
  };
}

function startUltimate(f, input, game) {
  if (f.ultimateCd > 0) return false;
  if (f.ultimateState) return false;
  if (!spendUltimate(f)) return false;

  f.attack = null;
  f.attackTimer = 0;
  f.attackDuration = 0;
  f.hitDone = false;
  f.hitList = [];
  f.script = null;

  f.ultimateCd = 360;
  f.ultimateState = makeUltimateState(f, input);
  f.invuln = Math.max(f.invuln, 24);
  f.armor = Math.max(f.armor, 36);

  if (f.ultimateState.type === "bishopSword") {
    f.ultimateCd = 300;
    f.invuln = Math.max(f.invuln, 36);
    f.armor = Math.max(f.armor, 28);
  }

  fx(game, "ultimateStart", f.x + f.w / 2, f.y + f.h / 2, {
    piece: pieceOf(f),
    dir: f.facing,
    ultType: f.ultimateState.type,
    timer: 80
  });

  if (f.ultimateState.type === "bishopSword") {
    fx(game, "bishopSwordAwaken", f.x + f.w / 2, f.y + f.h / 2, {
      piece: "bishop",
      dir: f.facing,
      timer: 80
    });
  }

  game.shake = Math.max(game.shake, 14);
  return true;
}

function endUltimate(f) {
  if (f.ultimateState?.type === "bishopSword") {
    f.speed = f.baseSpeed || charData("bishop").speed;
  }

  f.ultimateState = null;
}

function updateKingUltimate(f, enemy, game, input, u) {
  u.timer++;

  f.armor = Math.max(f.armor, 22);
  f.invuln = Math.max(f.invuln, 2);

  const d = enemy.x + enemy.w / 2 > f.x + f.w / 2 ? 1 : -1;
  f.facing = d;
  f.attackFacing = d;

  const dist = Math.abs((enemy.x + enemy.w / 2) - (f.x + f.w / 2));
  const closeY = Math.abs((enemy.y + enemy.h / 2) - (f.y + f.h / 2)) < 115;

  if (u.phase === "hunt") {
    f.vx = d * Math.max(3.2, f.speed * 0.78);

    if (dist <= u.grabRange && closeY) {
      u.phase = "grab";
      u.timer = 0;
      u.grabbed = true;
      enemy.stun = Math.max(enemy.stun, 34);
      enemy.hurt = Math.max(enemy.hurt, 34);

      fx(game, "ultimateLock", enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, {
        piece: "king",
        dir: d,
        timer: 34
      });
    } else if (u.timer >= u.duration) {
      u.phase = "shockwave";
      u.timer = 0;
    }
  } else if (u.phase === "grab") {
    f.vx *= 0.2;
    enemy.x = f.x + f.w / 2 + d * 50 - enemy.w / 2;
    enemy.y = f.y + f.h * 0.05;
    enemy.vx = 0;
    enemy.vy = 0;

    if (u.timer === 22) {
      const hb = makeHitbox(f, f.x + f.w / 2 - 155, f.y - 25, 310, 190, {
        dmg: 36,
        kb: 62,
        lift: -22,
        wall: 92,
        hitstop: 16,
        ultimate: true,
        breakArmor: true,
        grab: true,
        throwPower: 52,
        dir: d,
        hitKey: `kingUlt:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);
    }

    if (u.timer > 44) endUltimate(f);
  } else if (u.phase === "shockwave") {
    f.vx *= 0.25;

    if (!u.shockwaveDone) {
      u.shockwaveDone = true;

      const hb = makeHitbox(f, f.x + f.w / 2 - 170, f.y + 4, 340, 116, {
        dmg: 18,
        kb: 42,
        lift: -16,
        wall: 58,
        hitstop: 10,
        ultimate: true,
        breakArmor: true,
        dir: d,
        hitKey: `kingShock:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);

      fx(game, "ultimateBurst", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "king",
        dir: d,
        timer: 34
      });
    }

    if (u.timer > 28) endUltimate(f);
  }
}

function updateRookUltimate(f, enemy, game, input, u) {
  u.timer++;
  f.vx *= 0.04;
  f.vy = Math.min(f.vy, 1);
  f.armor = Math.max(f.armor, 80);

  if (input.left && !input.right) u.dir = -1;
  if (input.right && !input.left) u.dir = 1;

  f.facing = u.dir;
  f.attackFacing = u.dir;

  if (input.up) u.aimY = clamp(u.aimY - 2.5, -45, 18);
  if (input.down) u.aimY = clamp(u.aimY + 2.5, -45, 28);

  if (u.phase === "windup" && u.timer >= 46) {
    u.phase = "fire";
    u.timer = 0;
    game.shake = Math.max(game.shake, 12);
  }

  if (u.phase === "fire") {
    if (u.timer % u.fireEvery === 1 && u.shots < u.maxShots) {
      u.shots++;

      const x = u.dir === 1 ? f.x + f.w : LEFT;
      const w = u.dir === 1 ? RIGHT - (f.x + f.w) : f.x - LEFT;
      const y = f.y + 34 + u.aimY;

      const hb = makeHitbox(f, Math.min(x, x + w), y, Math.abs(w), 58, {
        dmg: 8,
        kb: 19 + u.shots * 1.2,
        lift: -5,
        wall: 72,
        hitstop: 5,
        ultimate: true,
        breakArmor: true,
        once: false,
        dir: u.dir,
        hitKey: `rookUlt:${f.attackId}:${u.shots}`
      });

      applyHitbox(f, enemy, hb, game);

      fx(game, "rookShell", u.dir === 1 ? f.x + f.w + 30 : f.x - 30, y + 29, {
        piece: "rook",
        dir: u.dir,
        timer: 20
      });
    }

    if (u.shots >= u.maxShots && u.timer > u.maxShots * u.fireEvery + 16) {
      u.phase = "recover";
      u.timer = 0;
    }
  }

  if (u.phase === "recover" && u.timer > 30) {
    endUltimate(f);
  }
}

function updateBishopUltimate(f, enemy, game, input, u) {
  u.timer++;
  u.pulse++;

  if (u.phase === "awakening") {
    f.vx *= 0.38;
    f.vy *= 0.38;
    f.invuln = Math.max(f.invuln, 3);
    f.armor = Math.max(f.armor, 34);

    if (u.timer >= 34) {
      u.phase = "active";
      u.timer = 0;
      f.speed = (f.baseSpeed || charData("bishop").speed) * u.speedBonus;

      fx(game, "bishopSwordReady", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "bishop",
        dir: f.facing,
        timer: 46
      });
    }

    return true;
  }

  if (u.phase === "active") {
    f.speed = (f.baseSpeed || charData("bishop").speed) * u.speedBonus;
    f.stamina = Math.min(f.maxStamina, f.stamina + 0.35);

    if (u.timer % 32 === 0) {
      fx(game, "bishopSwordPulse", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "bishop",
        dir: f.facing,
        timer: 18
      });
    }

    if (u.timer >= u.duration) {
      fx(game, "bishopSwordEnd", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "bishop",
        dir: f.facing,
        timer: 34
      });

      endUltimate(f);
    }

    return false;
  }

  return false;
}

function updateKnightUltimate(f, enemy, game, input, u) {
  u.timer++;
  u.segmentTimer++;

  if (!Array.isArray(u.trail)) u.trail = [];

  u.trail.push({
    x: f.x + f.w / 2,
    y: f.y + f.h / 2
  });

  if (u.trail.length > 46) u.trail.shift();

  f.grounded = false;
  f.armor = Math.max(f.armor, 48);
  f.invuln = Math.max(f.invuln, 2);

  function inputDir() {
    if (input.up && !input.down) return { x: 0, y: -1 };
    if (input.down && !input.up) return { x: 0, y: 1 };
    if (input.left && !input.right) return { x: -1, y: 0 };
    if (input.right && !input.left) return { x: 1, y: 0 };
    return null;
  }

  function perpendicularize(wanted, current) {
    if (!wanted) {
      if (current.x !== 0) return { x: 0, y: -1 };
      return { x: f.facing || 1, y: 0 };
    }

    if (current.x !== 0) {
      if (wanted.y !== 0) return wanted;
      return { x: 0, y: -1 };
    }

    if (wanted.x !== 0) return wanted;
    return { x: f.facing || 1, y: 0 };
  }

  function bodyHit(key, dmg, kb, lift, extraW = 86, extraH = 82) {
    const hb = makeHitbox(f, f.x - extraW / 2, f.y - extraH / 2, f.w + extraW, f.h + extraH, {
      dmg,
      kb,
      lift,
      wall: 78,
      hitstop: 6,
      ultimate: true,
      breakArmor: true,
      once: true,
      dir: f.attackFacing,
      hitKey: key
    });

    if (applyHitbox(f, enemy, hb, game)) {
      u.hits++;
    }
  }

  if (u.phase === "windup") {
    f.vx *= 0.5;
    f.vy *= 0.5;

    if (u.timer === 1) {
      fx(game, "knightWindup", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "knight",
        dir: f.facing,
        timer: 20
      });
    }

    if (u.timer >= 14) {
      u.phase = "rush";
      u.timer = 0;
      u.segmentTimer = 0;

      if (u.currentDir.x) {
        f.attackFacing = u.currentDir.x;
        f.facing = u.currentDir.x;
      }

      fx(game, "knightBurst", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "knight",
        dir: f.attackFacing,
        timer: 16
      });
    }

    return true;
  }

  if (u.phase === "rush") {
    const wanted = inputDir();

    if (wanted) {
      u.queuedDir = wanted;
    }

    const speed = 18.8;

    f.vx = u.currentDir.x * speed;
    f.vy = u.currentDir.y * speed;

    if (u.currentDir.x) {
      f.attackFacing = u.currentDir.x;
      f.facing = u.currentDir.x;
    }

    bodyHit(`knightUlt:segment:${f.attackId}:${u.segment}`, 8 + Math.min(u.segment, 3), 25 + u.segment * 3, -12 - u.segment);

    if (u.segmentTimer >= u.segmentLength) {
      u.previousDir = u.currentDir;
      u.currentDir = perpendicularize(u.queuedDir, u.currentDir);
      u.queuedDir = null;

      u.segment++;
      u.segmentTimer = 0;

      if (u.currentDir.x) {
        f.attackFacing = u.currentDir.x;
        f.facing = u.currentDir.x;
      }

      fx(game, "knightBurst", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "knight",
        dir: f.attackFacing,
        timer: 14
      });

      if (u.segment >= u.maxSegments) {
        u.phase = u.hits >= 2 ? "slam" : "recover";
        u.timer = 0;
      }
    }

    return true;
  }

  if (u.phase === "slam") {
    f.vx *= 0.52;
    f.vy = 13;

    if (!u.slamDone) {
      u.slamDone = true;

      const hb = makeHitbox(f, f.x - 105, f.y + f.h - 38, f.w + 210, 128, {
        dmg: 1 + Math.min(u.hits * 2, 12),
        kb: 52,
        lift: -25,
        wall: 90,
        hitstop: 13,
        ultimate: true,
        breakArmor: true,
        once: true,
        dir: f.attackFacing || f.facing || 1,
        hitKey: `knightUlt:slam:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);

      fx(game, "knightSlam", f.x + f.w / 2, f.y + f.h, {
        piece: "knight",
        dir: f.attackFacing,
        timer: 36
      });
    }

    if (u.timer > 30) endUltimate(f);
    return true;
  }

  if (u.phase === "recover") {
    f.vx *= 0.78;
    f.vy *= 0.82;

    if (u.timer > 20) endUltimate(f);
    return true;
  }

  return true;
}

function updatePawnUltimate(f, enemy, game, input, u) {
  u.timer++;

  f.armor = Math.max(f.armor, 10);
  f.stamina = Math.min(f.maxStamina, f.stamina + 0.9);

  if (u.phase === "buff") {
    f.speed = Math.max(f.speed, charData("pawn").speed * 1.08);

    if (u.hitsLanded >= u.hitsNeeded && !u.promotedBurst) {
      u.promotedBurst = true;
      u.phase = "burst";
      u.timer = 0;

      promote(f);
      f.queenTimer = Math.max(f.queenTimer, 180);
      f.armor = Math.max(f.armor, 52);
      f.invuln = Math.max(f.invuln, 12);

      fx(game, "pawnPromoteBurst", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "pawn",
        dir: f.facing,
        timer: 46
      });
    }

    if (u.timer >= u.duration) {
      endUltimate(f);
    }
  } else if (u.phase === "burst") {
    const d = f.facing || 1;
    f.attackFacing = d;

    if (u.timer < 22) {
      f.vx = d * 10.5;
      f.vy = Math.min(f.vy, -3);
    }

    if (u.timer === 8 || u.timer === 18 || u.timer === 28) {
      const hb = makeHitbox(f, d === 1 ? f.x + f.w : f.x - 180, f.y + 5, 180, 90, {
        dmg: 9,
        kb: 22,
        lift: -12,
        wall: 55,
        hitstop: 5,
        ultimate: true,
        breakArmor: true,
        once: true,
        dir: d,
        hitKey: `pawnBurst:${f.attackId}:${u.timer}`
      });

      applyHitbox(f, enemy, hb, game);
    }

    if (u.timer > 52) {
      endUltimate(f);
    }
  }

  return false;
}

function updateQueenUltimate(f, enemy, game, input, u) {
  u.timer++;

  f.armor = Math.max(f.armor, 14);
  f.stamina = Math.min(f.maxStamina, f.stamina + 1.5);

  if (u.phase === "hyper") {
    if (f.lightCd > 0) f.lightCd--;
    if (f.heavyCd > 0) f.heavyCd--;
    if (f.specialCd > 0) f.specialCd--;

    if (u.timer >= u.duration) {
      u.phase = "finisher";
      u.timer = 0;
      f.attack = null;
      f.attackTimer = 0;
      f.script = null;
      f.vx *= 0.2;
      f.vy = Math.min(f.vy, -5);

      fx(game, "queenFinisherStart", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "queen",
        dir: f.facing,
        hits: u.hits,
        timer: 42
      });
    }
  } else if (u.phase === "finisher") {
    f.vx *= 0.7;
    f.vy *= 0.85;
    f.invuln = Math.max(f.invuln, 3);

    if (!u.finisherDone && u.timer === 24) {
      u.finisherDone = true;
      const damage = clamp(16 + u.hits * 2, 16, 42);

      const hb = makeHitbox(f, f.x + f.w / 2 - 330, f.y - 110, 660, 300, {
        dmg: damage,
        kb: 52,
        lift: -26,
        wall: 90,
        hitstop: 14,
        ultimate: true,
        breakArmor: true,
        once: true,
        dir: f.facing || 1,
        hitKey: `queenFinisher:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);

      fx(game, "queenFinisher", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "queen",
        dir: f.facing,
        hits: u.hits,
        timer: 55
      });
    }

    if (u.timer > 58) endUltimate(f);
  }

  return u.phase === "finisher";
}

function updateUltimate(f, enemy, game, input) {
  const u = f.ultimateState;
  if (!u) return false;

  if (u.type === "kingVerdict") return updateKingUltimate(f, enemy, game, input, u);
  if (u.type === "rookSiege") return updateRookUltimate(f, enemy, game, input, u);
  if (u.type === "bishopSword") return updateBishopUltimate(f, enemy, game, input, u);
  if (u.type === "knightCharge") return updateKnightUltimate(f, enemy, game, input, u);
  if (u.type === "pawnUprising") return updatePawnUltimate(f, enemy, game, input, u);
  if (u.type === "queenDominion") return updateQueenUltimate(f, enemy, game, input, u);

  endUltimate(f);
  return false;
}

function scriptMove(f) {
  const s = f.script;
  if (!s || typeof s !== "object") return;

  if (!Number.isFinite(f.vx)) f.vx = 0;
  if (!Number.isFinite(f.vy)) f.vy = 0;

  if (s.trail) {
    if (!Array.isArray(s.trail)) s.trail = [];

    s.trail.push({
      x: Number.isFinite(f.x) ? f.x + f.w / 2 : 0,
      y: Number.isFinite(f.y) ? f.y + f.h / 2 : 0
    });

    if (s.trail.length > 22) s.trail.shift();
  }

  if (s.type === "fixed") {
    f.vx = Number.isFinite(s.vx) ? s.vx : 0;
    f.vy = Number.isFinite(s.vy) ? s.vy : 0;
    s.t = (Number.isFinite(s.t) ? s.t : 0) - 1;

    if (s.t <= 0) f.script = null;
    return;
  }

  if (s.type === "knightL") {
    if (!s.primary || !s.secondary) {
      f.script = null;
      return;
    }

    if (s.phase === 1) {
      f.vx = (s.primary.x || 0) * (s.s1 || 0);
      f.vy = (s.primary.y || 0) * (s.s1 || 0);
      s.t = (Number.isFinite(s.t) ? s.t : 0) - 1;

      if (s.t <= 0) {
        s.phase = 2;
        s.t = s.t2 || 6;
      }
    } else {
      f.vx = (s.secondary.x || 0) * (s.s2 || 0);
      f.vy = (s.secondary.y || 0) * (s.s2 || 0);
      s.t = (Number.isFinite(s.t) ? s.t : 0) - 1;

      if (s.t <= 0) f.script = null;
    }

    return;
  }

  if (s.type === "bishopZigzag") {
    f.vx = (s.dir || f.facing || 1) * (s.sx || 0);
    f.vy = (s.yDir || -1) * (s.sy || 0);

    s.t = (Number.isFinite(s.t) ? s.t : 0) - 1;

    if (s.t <= 0) {
      s.phase = (s.phase || 0) + 1;
      s.t = 8;
      s.yDir = -(s.yDir || -1);
    }

    if (s.phase >= 4) f.script = null;
    return;
  }

  f.script = null;
}

function startAttack(f, base, input, game) {
  if (base === "ultimate") {
    return startUltimate(f, input, game);
  }

  const swordModeOk = f.ultimateState?.type === "bishopSword" && f.ultimateState.phase === "active";
  const blockedByUlt = f.ultimateState && !swordModeOk && f.ultimateState.type !== "pawnUprising" && f.ultimateState.type !== "queenDominion";

  if (f.attack || blockedByUlt || f.hurt > 8 || f.stun > 0) return false;

  const attack = moveName(base, f);
  const aim = base === "special" ? aimFromInput(input) : "forward";
  const m = meta(f, attack, aim);

  if (base === "light" && f.lightCd > 0) return false;
  if (base === "heavy" && f.heavyCd > 0) return false;
  if (base === "special" && f.specialCd > 0) return false;
  if (base === "counter" && f.counterCd > 0) return false;
  if (f.stamina < m.stamina) return false;

  f.stamina -= m.stamina;
  f.staminaDelay =
    base === "special" ? 45 :
    base === "counter" ? 35 :
    base === "heavy" ? 24 :
    12;

  f.attack = attack;
  f.attackAim = aim;
  f.attackFacing = f.facing || 1;
  f.attackTimer = m.duration;
  f.attackDuration = m.duration;
  f.hitDone = false;
  f.hitList = [];
  f.multiHitWait = 0;
  f.attackId++;
  f.script = null;

  if (base === "light") f.lightCd = m.cd;
  if (base === "heavy") f.heavyCd = m.cd;
  if (base === "special") f.specialCd = m.cd;
  if (base === "counter") f.counterCd = m.cd;

  if (m.armor) f.armor = Math.max(f.armor, m.armor);
  if (base === "counter") f.invuln = Math.max(f.invuln, m.counterWindow);

  const p = pieceOf(f);
  const sword = isBishopSword(f);

  if (base === "counter") {
    if (p === "king") f.vx -= f.facing * 2;
    if (p === "rook") f.vx *= 0.1;
    if (p === "bishop") {
      f.vx -= f.facing * (sword ? 1.8 : 4);
      f.vy = Math.min(f.vy, sword ? -8 : -4);
    }
    if (p === "knight") {
      f.vx -= f.facing * 7;
      f.vy = Math.min(f.vy, -6);
    }
    if (p === "pawn") f.vx -= f.facing * 3;
    if (p === "queen") f.vx += f.facing * 2;

    fx(game, sword ? "bishopSwordParry" : "counterStart", f.x + f.w / 2, f.y + f.h / 2, {
      piece: p,
      dir: f.attackFacing,
      timer: 22
    });
    return true;
  }

  if (p === "king") {
    if (attack === "light") f.vx += f.facing * 1.5;
    if (attack === "heavy") f.vx += f.facing * 3.6;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.1;
    if (attack === "airHeavy") {
      f.vx += f.facing * 2;
      f.vy += 4.1;
    }
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") {
        f.vy = -8.5;
        f.grounded = false;
      } else if (aim === "down") f.vx += f.facing * 2.2;
      else f.vx += f.facing * 4.5;
    }
  }

  if (p === "rook") {
    if (attack === "light") f.vx += f.facing * 1.4;
    if (attack === "heavy") f.vx += f.facing * 4.2;
    if (attack === "crouchHeavy") f.vx += f.facing * 3;
    if (attack === "airHeavy") {
      f.vx += f.facing * 1.3;
      f.vy += 5;
    }
    if (attack === "special") {
      if (aim === "forward") {
        f.vx *= 0.05;
        f.armor = Math.max(f.armor, 54);
      } else if (aim === "up") {
        f.vx *= 0.05;
        f.vy = -2.2;
      } else {
        f.vx += f.facing * 7.4;
      }
    }
  }

  if (p === "bishop") {
    if (attack === "light") f.vx += f.facing * (sword ? 3.2 : 1.8);
    if (attack === "heavy") {
      f.script = fixed(f.facing * (sword ? 13.6 : 10), sword ? -7.8 : -8.4, sword ? 13 : 11);
      f.grounded = false;
    }
    if (attack === "airHeavy") {
      f.script = fixed(f.facing * (sword ? 12.8 : 9.8), sword ? 10.4 : 8.8, sword ? 13 : 11);
    }
    if (attack === "airSpecial") {
      f.script = bishopZigzag(f, input);
      if (sword) {
        f.script.sx = 14.5;
        f.script.sy = 11.8;
      }
      f.grounded = false;
    } else if (attack === "special") {
      if (aim === "up") {
        f.vx += f.facing * (sword ? 7.2 : 5.2);
        f.vy = sword ? -16 : -14;
        f.grounded = false;
      } else if (aim === "down") {
        f.vx += f.facing * (sword ? 9.4 : 7.2);
        f.vy += sword ? 10.5 : 8.5;
      } else {
        f.vx += f.facing * (sword ? 12.5 : 9.5);
        f.vy = sword ? -5.5 : -4.8;
        f.grounded = false;
      }
    }

    if (sword) {
      fx(game, "bishopSwordMove", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "bishop",
        attack,
        aim,
        dir: f.attackFacing,
        timer: 16
      });
    }
  }

  if (p === "knight") {
    if (attack === "light") f.vx += f.facing * 2.2;
    if (attack === "heavy") {
      f.vy = -11.2;
      f.vx += f.facing * 1.5;
      f.grounded = false;
    }
    if (attack === "crouchHeavy") {
      f.vx -= f.facing * 2;
      f.vy = -6.2;
      f.grounded = false;
    }
    if (attack === "airHeavy") {
      f.script = knightPattern(f, input);
      f.grounded = false;
    }
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") {
        f.vx -= f.facing * 3.8;
        f.vy = -18.8;
        f.grounded = false;
      } else if (aim === "down") {
        f.vx += f.facing * 12;
        f.vy += 11.4;
      } else {
        f.vx += f.facing * 12;
        f.vy = -12.8;
        f.grounded = false;
      }
    }
  }

  if (p === "pawn") {
    if (attack === "light") f.vx += f.facing * 1.4;
    if (attack === "heavy") f.vx += f.facing * 2.7;
    if (attack === "crouchHeavy") {
      f.vx += f.facing * 3.4;
      f.vy = -4.8;
      f.grounded = false;
    }
    if (attack === "airHeavy") f.vx += f.facing * 2;
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") {
        f.vx += f.facing * 1.8;
        f.vy = -11.4;
        f.grounded = false;
      } else if (aim === "down") {
        f.vx += f.facing * 5.2;
        f.vy = -2.3;
      } else f.vx += f.facing * 7.5;

      charge(f, 3.5);
    }
  }

  if (p === "queen") {
    if (attack === "light") f.vx += f.facing * 2.2;
    if (attack === "heavy") f.vx += f.facing * 4.4;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.2;
    if (attack === "airHeavy") f.vx += f.facing * 2.8;
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") {
        f.vy = -13.6;
        f.grounded = false;
      } else if (aim === "down") {
        f.vx += f.facing * 9.2;
        f.vy += 6.8;
      } else f.vx += f.facing * 7.4;
    }
  }

  fx(game, "moveStart", f.x + f.w / 2, f.y + f.h / 2, {
    piece: p,
    attack,
    aim,
    dir: f.attackFacing,
    sword,
    timer: 12
  });

  return true;
}

function triggerCounter(defender, attacker, game) {
  const p = pieceOf(defender);
  const d = defender.facing || -attacker.facing || 1;
  const m = meta(defender, "counter");

  defender.attackFacing = d;
  defender.invuln = 12;
  defender.hurt = 0;
  defender.hitDone = false;
  defender.attackTimer = Math.min(defender.attackTimer, defender.attackDuration - m.activeA);

  attacker.attack = null;
  attacker.attackTimer = 0;
  attacker.script = null;
  attacker.hurt = Math.max(attacker.hurt, 22);

  if (p === "king") {
    attacker.vx = d * 34;
    attacker.vy = -12;
  } else if (p === "rook") {
    attacker.vx = d * 40;
    attacker.vy = -8;
  } else if (p === "bishop") {
    const sword = isBishopSword(defender);
    defender.vx = d * (sword ? 13 : 10);
    defender.vy = sword ? -16 : -12;
    attacker.vx = d * (sword ? 38 : 25);
    attacker.vy = sword ? -30 : -25;
  } else if (p === "knight") {
    defender.vx = d * 12;
    defender.vy = -9;
    attacker.vx = d * 27;
    attacker.vy = -18;
  } else if (p === "pawn") {
    attacker.vx = d * 23;
    attacker.vy = -10;
  } else {
    attacker.vx = d * 40;
    attacker.vy = -22;
  }

  game.hitstop = Math.max(game.hitstop, isBishopSword(defender) ? 14 : 10);
  game.shake = Math.max(game.shake, isBishopSword(defender) ? 16 : 12);

  fx(game, isBishopSword(defender) ? "bishopSwordParry" : "counterSuccess", defender.x + defender.w / 2, defender.y + defender.h / 2, {
    piece: p,
    dir: d,
    timer: 34
  });
}

function applyGrab(attacker, defender, m, game, b) {
  const d = attacker.attackFacing || attacker.facing || 1;

  defender.invuln = 0;
  defender.hurt = 36;
  defender.stun = Math.max(defender.stun, 18);
  defender.x = attacker.x + attacker.w / 2 + d * 55 - defender.w / 2;
  defender.y = Math.min(defender.y, attacker.y + attacker.h * 0.12);
  defender.vx = d * m.throwPower * 1.52;
  defender.vy = -14;
  defender.hp = Math.max(0, defender.hp - m.dmg);
  defender.wallBounceTimer = 50;
  defender.wallBouncePower = m.wall;

  attacker.hitDone = true;
  attacker.hitList.push(`${attacker.attackId}:${defender.side}`);

  game.hitstop = Math.max(game.hitstop, 12);
  game.shake = Math.max(game.shake, 13);

  fx(game, "grab", defender.x + defender.w / 2, defender.y + defender.h / 2, {
    dir: d,
    piece: pieceOf(attacker),
    timer: 24
  });

  fx(game, "hit", b.x + b.w / 2, b.y + b.h / 2, {
    piece: pieceOf(attacker),
    attack: attacker.attack,
    dir: d,
    timer: 18
  });
}

function handleHit(attacker, defender, game) {
  if (!attacker.attack || !active(attacker)) return;

  const m = meta(attacker);

  if (m.multi) {
    if (attacker.multiHitWait > 0) return;
  } else if (attacker.hitDone) {
    return;
  }

  const b = box(attacker);
  const defRect = { x: defender.x, y: defender.y, w: defender.w, h: defender.h };

  if (!rect(b, defRect)) return;

  if (counterWindow(defender)) {
    triggerCounter(defender, attacker, game);
    return;
  }

  if (defender.invuln > 0) return;

  if (m.grab) {
    applyGrab(attacker, defender, m, game, b);
    return;
  }

  let damage = m.dmg;
  let knock = m.kb * 1.52;
  let lift = m.lift * 1.2;

  if (m.multi) {
    damage = Math.max(2, Math.ceil(damage * 0.55));
    knock *= 0.64;
  }

  if (defender.armor > 0 && !m.breakArmor) {
    damage = Math.ceil(damage * 0.5);
    knock *= 0.4;
    fx(game, "armor", defender.x + defender.w / 2, defender.y + defender.h / 2, { timer: 12 });
  } else {
    defender.hurt = m.multi ? 8 : 20;
  }

  defender.hp = Math.max(0, defender.hp - damage);
  defender.vx += attacker.attackFacing * knock;
  defender.vy += lift;
  defender.wallBounceTimer = 42;
  defender.wallBouncePower = m.wall;

  chargeUltimate(attacker, damage * 1.15 + 2);
  chargeUltimate(defender, damage * 0.38 + 1);

  if (attacker.characterKey === "pawn" && !attacker.promoted) charge(attacker, 4.5 + damage * 0.28);
  if (defender.characterKey === "pawn" && !defender.promoted) charge(defender, 1.8 + damage * 0.08);

  if (attacker.ultimateState?.type === "pawnUprising") {
    attacker.ultimateState.hitsLanded++;
  }

  if (attacker.ultimateState?.type === "queenDominion") {
    attacker.ultimateState.hits++;
    const cx = attacker.x + attacker.w / 2;
    const dcx = defender.x + defender.w / 2;
    defender.vx += dcx < cx ? 3.2 : -3.2;
  }

  game.hitstop = Math.max(game.hitstop, m.multi ? 3 : damage >= 12 ? 9 : damage >= 8 ? 6 : 4);
  game.shake = Math.max(game.shake, isBishopSword(attacker) ? 14 : damage >= 12 ? 10 : damage >= 8 ? 7 : 4);

  fx(game, "hit", clamp(b.x + b.w / 2, defender.x, defender.x + defender.w), clamp(b.y + b.h / 2, defender.y, defender.y + defender.h), {
    piece: pieceOf(attacker),
    attack: attacker.attack,
    dir: attacker.attackFacing,
    damage,
    sword: isBishopSword(attacker),
    timer: m.multi ? 8 : 18
  });

  if (m.multi) attacker.multiHitWait = m.interval;
  else attacker.hitDone = true;
}

function updateFighter(f, enemy, input, game) {
  if (f.lightCd > 0) f.lightCd--;
  if (f.heavyCd > 0) f.heavyCd--;
  if (f.specialCd > 0) f.specialCd--;
  if (f.counterCd > 0) f.counterCd--;
  if (f.ultimateCd > 0) f.ultimateCd--;
  if (f.hurt > 0) f.hurt--;
  if (f.armor > 0) f.armor--;
  if (f.invuln > 0) f.invuln--;
  if (f.stun > 0) f.stun--;
  if (f.dashCd > 0) f.dashCd--;
  if (f.staminaDelay > 0) f.staminaDelay--;
  if (f.multiHitWait > 0) f.multiHitWait--;

  if (!Number.isFinite(f.x)) f.x = f.side === "white" ? 220 : 690;
  if (!Number.isFinite(f.y)) f.y = FLOOR - f.standH;
  if (!Number.isFinite(f.vx)) f.vx = 0;
  if (!Number.isFinite(f.vy)) f.vy = 0;
  if (!Number.isFinite(f.hp)) f.hp = Math.max(1, f.maxHp || 500);
  if (!Number.isFinite(f.stamina)) f.stamina = 50;
  if (!Number.isFinite(f.ultimate)) f.ultimate = 0;

  if (!isBishopSword(f) && f.characterKey === "bishop" && f.speed !== (f.baseSpeed || charData("bishop").speed)) {
    f.speed = f.baseSpeed || charData("bishop").speed;
  }

  if (f.promoted) {
    f.queenTimer--;
    if (f.queenTimer <= 0 && f.ultimateState?.type !== "pawnUprising") {
      unpromote(f);
      fx(game, "queenEnd", f.x + f.w / 2, f.y + f.h / 2, { timer: 34 });
    }
  } else if (f.characterKey === "pawn") {
    charge(f, f.hp < f.maxHp * 0.3 ? 0.018 : 0.008);
  }

  chargeUltimate(f, 0.006);

  if (input.jumpPressed) f.jumpBuffer = 8;
  else if (f.jumpBuffer > 0) f.jumpBuffer--;

  if (f.grounded) {
    f.coyote = 8;
    f.airDashUsed = false;
  } else if (f.coyote > 0) {
    f.coyote--;
  }

  const oldH = f.h;
  f.crouching = !!input.down && f.grounded && !f.attack && !f.ultimateState && f.hurt <= 8;
  if (isBishopSword(f)) {
    f.crouching = !!input.down && f.grounded && !f.attack && f.hurt <= 8;
  }

  f.h = f.crouching ? f.crouchH : f.standH;
  f.y += oldH - f.h;

  if (f.staminaDelay <= 0) {
    f.stamina = Math.min(f.maxStamina, f.stamina + (f.grounded ? 0.85 : 0.48));
  }

  const stunned = f.hurt > 8 || f.stun > 0;

  if (!stunned && input.ultimatePressed) {
    startAttack(f, "ultimate", input, game);
  }

  const ultTakingOver = updateUltimate(f, enemy, game, input);
  const bishopSwordActive = isBishopSword(f);

  const wantsDash =
    !ultTakingOver &&
    input.counterPressed &&
    input.left !== input.right &&
    f.dashCd <= 0 &&
    !f.attack &&
    !stunned &&
    f.stamina >= 15;

  if (wantsDash) {
    const d = input.left ? -1 : 1;
    f.vx = d * f.speed * 2.25;
    f.facing = d;
    f.attackFacing = d;
    f.dashCd = 28;
    f.invuln = 5;
    f.stamina -= 15;
    f.staminaDelay = 28;
    fx(game, "dash", f.x + f.w / 2, f.y + f.h / 2, { dir: d, timer: 14 });
  } else if (!ultTakingOver && input.counterPressed) {
    startAttack(f, "counter", input, game);
  }

  const airCtrl =
    pieceOf(f) === "bishop" ? (bishopSwordActive ? 1.33 : 1.18) :
    pieceOf(f) === "knight" ? 1.22 :
    pieceOf(f) === "queen" ? 1.12 :
    1;

  const queenHyper = f.ultimateState?.type === "queenDominion" && f.ultimateState.phase === "hyper";
  const movementAllowed = !ultTakingOver || queenHyper || f.ultimateState?.type === "pawnUprising" || bishopSwordActive;

  if (movementAllowed && !f.attack && !stunned) {
    if (input.left && !input.right) {
      f.vx = f.grounded ? -f.speed : Math.max(f.vx - f.speed * 0.16 * airCtrl, -f.speed * airCtrl);
    } else if (input.right && !input.left) {
      f.vx = f.grounded ? f.speed : Math.min(f.vx + f.speed * 0.16 * airCtrl, f.speed * airCtrl);
    } else {
      f.vx *= f.grounded ? 0.72 : 0.96;
    }
  } else {
    f.vx *= f.grounded ? 0.84 : 0.96;
  }

  if (movementAllowed && f.jumpBuffer > 0 && f.coyote > 0 && !f.attack && !f.crouching && !stunned) {
    f.vy = -f.jump;
    f.grounded = false;
    f.jumpBuffer = 0;
    f.coyote = 0;
  }

  if (movementAllowed && !f.grounded && input.down && f.vy > -2 && !f.attack) {
    f.vy += 0.55;
  }

  if (movementAllowed && !stunned) {
    if (input.lightPressed) startAttack(f, "light", input, game);
    if (input.heavyPressed) startAttack(f, "heavy", input, game);
    if (input.specialPressed) startAttack(f, "special", input, game);
  }

  scriptMove(f);

  f.x += f.vx;
  f.y += f.vy;
  f.vy += GRAVITY;

  if (!Number.isFinite(f.x)) f.x = f.side === "white" ? 220 : 690;
  if (!Number.isFinite(f.y)) f.y = FLOOR - f.standH;
  if (!Number.isFinite(f.vx)) f.vx = 0;
  if (!Number.isFinite(f.vy)) f.vy = 0;

  if (f.y + f.h >= FLOOR) {
    f.y = FLOOR - f.h;
    f.vy = 0;
    f.grounded = true;

    if (f.script && f.script.type === "fixed" && f.script.vy > 0) f.script = null;
  } else {
    f.grounded = false;
  }

  if (f.x < LEFT) f.x = LEFT;
  if (f.x + f.w > RIGHT) f.x = RIGHT - f.w;

  if (!f.attack && !f.ultimateState) {
    f.facing = f.x < enemy.x ? 1 : -1;
    f.attackFacing = f.facing;
  }

  if (!f.attack && bishopSwordActive) {
    f.facing = f.x < enemy.x ? 1 : -1;
    f.attackFacing = f.facing;
  }

  if (f.attack) {
    f.attackTimer--;
    if (f.attackTimer <= 0) {
      f.attack = null;
      f.attackAim = "forward";
      f.hitDone = false;
      f.hitList = [];
      f.multiHitWait = 0;
      f.script = null;
    }
  }

  if (f.wallBounceTimer > 0) {
    f.wallBounceTimer--;

    const hitL = f.x <= LEFT + 1;
    const hitR = f.x + f.w >= RIGHT - 1;

    if ((hitL || hitR) && Math.abs(f.vx) > 4.2) {
      const side = hitL ? -1 : 1;
      f.x = hitL ? LEFT : RIGHT - f.w;
      f.vx = -side * Math.max(7, Math.abs(f.vx) * 0.52);
      f.vy = Math.min(f.vy, -7);

      const damage = Math.ceil(f.wallBouncePower * 0.76);
      f.hp = Math.max(0, f.hp - damage);
      f.hurt = Math.max(f.hurt, 18);
      f.wallBounceTimer = 0;

      fx(game, "wallBounce", f.x + f.w / 2, f.y + f.h / 2, { timer: 18 });
    }
  }
}

function prepInput(player) {
  const input = player.input || {};
  const seq = input.seq || {};

  const out = {
    left: !!input.left,
    right: !!input.right,
    up: !!input.up,
    down: !!input.down,
    lightPressed: seq.light > (player.lastSeq?.light || 0),
    heavyPressed: seq.heavy > (player.lastSeq?.heavy || 0),
    specialPressed: seq.special > (player.lastSeq?.special || 0),
    counterPressed: seq.counter > (player.lastSeq?.counter || 0),
    ultimatePressed: seq.ultimate > (player.lastSeq?.ultimate || 0),
    jumpPressed: seq.jump > (player.lastSeq?.jump || 0)
  };

  player.lastSeq = {
    light: seq.light || 0,
    heavy: seq.heavy || 0,
    special: seq.special || 0,
    counter: seq.counter || 0,
    ultimate: seq.ultimate || 0,
    jump: seq.jump || 0
  };

  return out;
}

function winnerOfRound(w, b, game) {
  if (w.hp <= 0 && b.hp <= 0) return w.hp >= b.hp ? "white" : "black";
  if (w.hp <= 0) return "black";
  if (b.hp <= 0) return "white";
  if (game.roundTime <= 0) return w.hp >= b.hp ? "white" : "black";
  return null;
}

function updateGame(lobby) {
  const game = lobby.game;
  if (!game || lobby.status !== "playing") return;

  game.tick++;
  if (game.shake > 0) game.shake--;
  tickEffects(game);

  if (game.roundOver) {
    game.roundOverTimer--;

    if (game.roundOverTimer <= 0) {
      if (lobby.match.winner) {
        lobby.status = "finished";
        lobby.game = null;
        sendGame(lobby);
        sendLobbyData();
      } else {
        lobby.match.round++;
        startRound(lobby);
      }
    }

    return;
  }

  if (game.hitstop > 0) {
    game.hitstop--;
    return;
  }

  game.roundTime--;

  const white = game.fighters.white;
  const black = game.fighters.black;

  const wi = prepInput(players[white.id] || {});
  const bi = prepInput(players[black.id] || {});

  updateFighter(white, black, wi, game);
  updateFighter(black, white, bi, game);

  handleHit(white, black, game);
  handleHit(black, white, game);

  const win = winnerOfRound(white, black, game);

  if (win) {
    game.roundOver = true;
    game.roundWinner = win;
    game.roundOverTimer = 150;

    if (win === "white") lobby.match.whiteRounds++;
    else lobby.match.blackRounds++;

    const wf = game.fighters[win];
    fx(game, "roundWin", wf.x + wf.w / 2, wf.y + wf.h / 2, { side: win, timer: 80 });

    if (lobby.match.whiteRounds >= ROUNDS_TO_WIN || lobby.match.blackRounds >= ROUNDS_TO_WIN) {
      lobby.match.winner = win;
      lobby.winner = wf.name;
      lobby.message = `${wf.name} wins the match ${lobby.match.whiteRounds}-${lobby.match.blackRounds}.`;
      leaderboard[wf.name] = (leaderboard[wf.name] || 0) + 1;
      game.roundOverTimer = 220;
    } else {
      lobby.message = `${wf.name} wins round ${lobby.match.round}.`;
    }
  }
}

setInterval(() => {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.status === "playing" && lobby.game) {
      updateGame(lobby);
      sendGame(lobby);
    }
  }
}, 1000 / FPS);

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    name: `Player ${Object.keys(players).length + 1}`,
    characterKey: "king",
    lobbyId: null,
    role: "menu",
    input: {
      seq: {
        light: 0,
        heavy: 0,
        special: 0,
        counter: 0,
        ultimate: 0,
        jump: 0
      }
    },
    lastSeq: {
      light: 0,
      heavy: 0,
      special: 0,
      counter: 0,
      ultimate: 0,
      jump: 0
    }
  };

  socket.emit("welcome", {
    id: socket.id,
    characters: CHARACTERS
  });

  sendLobbyData();

  socket.on("setName", (name) => {
    players[socket.id].name = cleanName(name);
    if (!leaderboard[players[socket.id].name]) leaderboard[players[socket.id].name] = 0;
    sendLobbyData();
  });

  socket.on("setCharacter", (key) => {
    if (!CHARACTERS[key]) return;
    players[socket.id].characterKey = key;
    sendLobbyData();
  });

  socket.on("createLobby", (name) => {
    leaveLobby(socket.id);

    const id = String(nextLobbyId++);

    lobbies[id] = {
      id,
      name: String(name || `${players[socket.id].name}'s Board`).trim().slice(0, 28),
      hostId: socket.id,
      whiteId: socket.id,
      blackId: null,
      spectators: new Set(),
      status: "waiting",
      game: null,
      match: null,
      winner: null,
      message: "Waiting for black..."
    };

    players[socket.id].lobbyId = id;
    players[socket.id].role = "white";

    socket.join(room(id));
    socket.emit("enteredLobby", { lobbyId: id, role: "white" });
    sendGame(lobbies[id]);
    sendLobbyData();
  });

  socket.on("joinLobby", (id) => {
    const lobby = lobbies[id];
    if (!lobby || lobby.status !== "waiting" || lobby.blackId) return;

    leaveLobby(socket.id);

    lobby.blackId = socket.id;
    players[socket.id].lobbyId = id;
    players[socket.id].role = "black";

    socket.join(room(id));
    socket.emit("enteredLobby", { lobbyId: id, role: "black" });

    initMatch(lobby);
    startRound(lobby);

    sendGame(lobby);
    sendLobbyData();
  });

  socket.on("watchLobby", (id) => {
    const lobby = lobbies[id];
    if (!lobby) return;

    leaveLobby(socket.id);

    lobby.spectators.add(socket.id);
    players[socket.id].lobbyId = id;
    players[socket.id].role = "spectator";

    socket.join(room(id));
    socket.emit("enteredLobby", { lobbyId: id, role: "spectator" });
    sendGame(lobby);
    sendLobbyData();
  });

  socket.on("leaveLobby", () => {
    leaveLobby(socket.id);
    socket.emit("leftLobby");
    sendLobbyData();
  });

  socket.on("input", (input) => {
    const p = players[socket.id];
    if (!p || !input) return;

    p.input = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      down: !!input.down,
      seq: {
        light: Number(input.seq?.light || 0),
        heavy: Number(input.seq?.heavy || 0),
        special: Number(input.seq?.special || 0),
        counter: Number(input.seq?.counter || 0),
        ultimate: Number(input.seq?.ultimate || 0),
        jump: Number(input.seq?.jump || 0)
      }
    };
  });

  socket.on("disconnect", () => {
    leaveLobby(socket.id);
    delete players[socket.id];
    sendLobbyData();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});