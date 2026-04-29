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
      dmg: 5,
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
    if (p === "pawn") Object.assign(m, { dmg: 5, kb: 24, cd: 92 });
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
    if (attack === "light") Object.assign(m, { duration: 17, activeA: 4, activeB: 9, dmg: 7, kb: 12, lift: -3, cd: 12 });
    if (attack === "airLight") Object.assign(m, { duration: 18, activeA: 4, activeB: 11, dmg: 7, kb: 13, lift: 6, cd: 13 });
    if (attack === "crouchLight") Object.assign(m, { duration: 18, activeA: 5, activeB: 11, dmg: 6, kb: 10, lift: -16, cd: 13 });
    if (attack === "heavy") Object.assign(m, { duration: 38, activeA: 12, activeB: 21, dmg: 21, kb: 34, stamina: 14, cd: 54, armor: 28, breakArmor: true, wall: 46 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 34, activeA: 9, activeB: 18, dmg: 17, kb: 25, lift: -24, stamina: 11, cd: 46, armor: 16, wall: 34 });
    if (attack === "airHeavy") Object.assign(m, { duration: 35, activeA: 7, activeB: 20, dmg: 20, kb: 21, lift: 22, stamina: 12, cd: 50, breakArmor: true, wall: 30 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "down") Object.assign(m, { duration: 46, activeA: 9, activeB: 18, dmg: 20, kb: 16, lift: -8, stamina: 22, cd: 150, armor: 32, grab: true, throwPower: 68, wall: 58 });
      else if (aim === "up") Object.assign(m, { duration: 44, activeA: 9, activeB: 22, dmg: 18, kb: 16, lift: -44, stamina: 20, cd: 135, armor: 20, breakArmor: true, wall: 24 });
      else Object.assign(m, { duration: 50, activeA: 13, activeB: 25, dmg: 22, kb: 42, lift: -10, stamina: 24, cd: 155, armor: 34, breakArmor: true, wall: 62 });
    }
  }

  if (p === "rook") {
    if (attack === "light") Object.assign(m, { duration: 20, activeA: 6, activeB: 12, dmg: 5, kb: 17, cd: 18 });
    if (attack === "heavy") Object.assign(m, { duration: 36, activeA: 11, activeB: 21, dmg: 12, kb: 32, stamina: 13, cd: 56, armor: 26, breakArmor: true, wall: 44 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 34, activeA: 10, activeB: 18, dmg: 10, kb: 30, stamina: 11, cd: 54, wall: 38 });
    if (attack === "airHeavy") Object.assign(m, { duration: 32, activeA: 8, activeB: 18, dmg: 10, kb: 26, lift: 12, stamina: 10, cd: 52 });

    if (attack === "special") {
      if (aim === "forward") Object.assign(m, { duration: 96, activeA: 44, activeB: 65, dmg: 5, kb: 46, stamina: 36, cd: 300, armor: 50, breakArmor: true, multi: true, interval: 9, wall: 62 });
      else if (aim === "up") Object.assign(m, { duration: 62, activeA: 16, activeB: 34, dmg: 5, kb: 20, lift: -33, stamina: 24, cd: 300, multi: true, interval: 10 });
      else Object.assign(m, { duration: 58, activeA: 14, activeB: 27, dmg: 5, kb: 38, stamina: 25, cd: 300, armor: 36, breakArmor: true, wall: 46 });
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
        : { duration: 28, activeA: 8, activeB: 16, dmg: 5, kb: 21, lift: -12, stamina: 8, cd: 38 }
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
          : { duration: 58, activeA: 7, activeB: 42, dmg: 6, kb: 18, lift: -30, stamina: 17, cd: 140, multi: true, interval: 13 }
        );
      } else if (aim === "down") {
        Object.assign(m, sword
          ? { duration: 36, activeA: 7, activeB: 21, dmg: 15, kb: 42, lift: 18, stamina: 14, cd: 62, breakArmor: true, wall: 58 }
          : { duration: 58, activeA: 7, activeB: 42, dmg: 6, kb: 24, lift: 11, stamina: 17, cd: 140, breakArmor: true, multi: true, interval: 13 }
        );
      } else {
        Object.assign(m, sword
          ? { duration: 36, activeA: 7, activeB: 22, dmg: 15, kb: 40, lift: -16, stamina: 14, cd: 62, breakArmor: true, wall: 54 }
          : { duration: 58, activeA: 7, activeB: 42, dmg: 6, kb: 23, lift: -10, stamina: 17, cd: 140, multi: true, interval: 13 }
        );
      }
    }
  }

  if (p === "knight") {
    if (attack === "light") Object.assign(m, { duration: 17, activeA: 4, activeB: 11, dmg: 5, kb: 14, lift: -3, cd: 13 });
    if (attack === "heavy") Object.assign(m, { duration: 27, activeA: 8, activeB: 15, dmg: 5, kb: 22, lift: -23, stamina: 8, cd: 34 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 24, activeA: 7, activeB: 13, dmg: 5, kb: 20, lift: -17, stamina: 8, cd: 34 });
    if (attack === "airHeavy") Object.assign(m, { duration: 32, activeA: 4, activeB: 22, dmg: 10, kb: 25, stamina: 10, cd: 40 });
    if (attack === "airSpecial") {
      Object.assign(m, {
        duration: 34,
        activeA: 1,
        activeB: 31,
        dmg: 4,
        kb: 18,
        lift: -10,
        stamina: 20,
        cd: 155,
        multi: true,
        interval: 5,
        wall: 44
      });
    } else if (attack === "special") {
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
      else if (aim === "down") Object.assign(m, { duration: 36, activeA: 8, activeB: 16, dmg: 5, kb: 22, stamina: 17, cd: 135, breakArmor: true });
      else Object.assign(m, { duration: 36, activeA: 8, activeB: 16, dmg: 5, kb: 22, stamina: 17, cd: 135 });
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
    if (a === "airLight") return body(112, 84, 8, 26);
    if (a === "crouchLight") return forward(96, 42, f.h * 0.58);
    if (a === "heavy") return body(178, 126, -10, 48);
    if (a === "crouchHeavy") return forward(170, 58, f.h * 0.56);
    if (a === "airHeavy") return body(170, 146, 12, 18);
    if (a === "special" || a === "airSpecial") {
      if (aim === "up") return up(150, 280);
      if (aim === "down") return forward(106, 118, 10);
      return body(270, 150, -8, 70);
    }
  }

  if (p === "rook") {
    if (a === "light") return forward(150, 50, 40);
    if (a === "airLight") return body(142, 82, 10, 36);
    if (a === "crouchLight") return forward(132, 42, f.h * 0.6);
    if (a === "heavy") return forward(210, 94, 20);
    if (a === "crouchHeavy") return forward(180, 54, f.h * 0.55);
    if (a === "airHeavy") return forward(134, 102, 18);
    if (a === "airSpecial") return body(168, 118, 4, 42);
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
    if (a === "airLight") return sword ? body(210, 128, -6, 40) : body(130, 98, 0, 30);
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
    if (a === "airLight") return body(112, 90, 0, 32);
    if (a === "crouchLight") return forward(96, 42, f.h * 0.6);
    if (a === "heavy") return body(112, 104, -12, 30);
    if (a === "crouchHeavy") return forward(102, 74, f.h * 0.43);
    if (a === "airHeavy") return { x: f.x - 32, y: f.y - 28, w: f.w + 64, h: f.h + 56 };
    if (a === "airSpecial") return { x: f.x - 34, y: f.y - 34, w: f.w + 68, h: f.h + 68 };
    if (a === "special") {
      if (aim === "up") return up(120, 154, 10);
      if (aim === "down") return body(142, 112, f.h * 0.3, 42);
      return body(140, 110, 0, 50);
    }
  }

  if (p === "pawn") {
    if (a === "light") return forward(94, 30, 40);
    if (a === "airLight") return forward(94, 58, 20);
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
    if (a === "airLight") return body(164, 116, 2, 42);
    if (a === "crouchLight") return forward(142, 48, f.h * 0.58);
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
  f.speed *= 1.4;
  f.jump *= 1.4;
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
      sword: isBishopSword(attacker),
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
    sword: isBishopSword(attacker),
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

function knightAirPattern(f, input) {
  const d = f.facing || 1;
  let primary;

  if (input.up && !input.down) primary = { x: 0, y: -1 };
  else if (input.down && !input.up) primary = { x: 0, y: 1 };
  else primary = { x: d, y: 0 };

  const longDistance = Math.round(f.h * 2.18);
  const shortDistance = Math.round(f.h * 1.16);
  const longSpeed = 18.5;
  const shortSpeed = 15.5;

  return {
    type: "knightAirL",
    phase: 1,
    primary,
    secondary: null,
    longDistance,
    shortDistance,
    longSpeed,
    shortSpeed,
    traveled: 0,
    start: {
      x: f.x + f.w / 2,
      y: f.y + f.h / 2
    },
    pivot: null,
    end: null,
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
    t: 14,
    sx: 8.8,
    sy: 7.4,
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
      duration: 185,
      grabRange: 126,
      dir: d,
      grabbed: false,
      shockwaveDone: false,
      slamDone: false,
      auraPulse: 0
    };
  }

  if (p === "rook") {
    return {
      type: "rookSiege",
      phase: "windup",
      timer: 0,
      dir: d,
      aimY: 0,
      fireEvery: 13,
      shots: 0,
      maxShots: 4,
      beams: []
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

  if (f.ultimateState.type === "kingVerdict") {
    f.ultimateCd = 330;
    f.invuln = Math.max(f.invuln, 34);
    f.armor = Math.max(f.armor, 64);
  }

  if (f.ultimateState.type === "rookSiege") {
    f.ultimateCd = 390;
    f.invuln = Math.max(f.invuln, 20);
    f.armor = Math.max(f.armor, 34);
  }

  fx(game, "ultimateStart", f.x + f.w / 2, f.y + f.h / 2, {
    piece: pieceOf(f),
    dir: f.facing,
    ultType: f.ultimateState.type,
    timer: f.ultimateState.type === "kingVerdict" ? 105 : 80
  });

  if (f.ultimateState.type === "bishopSword") {
    fx(game, "bishopSwordAwaken", f.x + f.w / 2, f.y + f.h / 2, {
      piece: "bishop",
      dir: f.facing,
      timer: 80
    });
  }

  if (f.ultimateState.type === "kingVerdict") {
    fx(game, "kingCrownBurst", f.x + f.w / 2, f.y + f.h / 2, {
      piece: "king",
      dir: f.facing,
      timer: 90
    });
  }

  game.shake = Math.max(game.shake, f.ultimateState.type === "kingVerdict" ? 24 : 14);
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
  u.auraPulse = (u.auraPulse || 0) + 1;

  f.armor = Math.max(f.armor, 58);
  f.invuln = Math.max(f.invuln, 3);

  const d = enemy.x + enemy.w / 2 > f.x + f.w / 2 ? 1 : -1;
  f.facing = d;
  f.attackFacing = d;
  u.dir = d;

  const dist = Math.abs((enemy.x + enemy.w / 2) - (f.x + f.w / 2));
  const closeY = Math.abs((enemy.y + enemy.h / 2) - (f.y + f.h / 2)) < 145;

  if (u.timer % 9 === 0) {
    fx(game, "kingAura", f.x + f.w / 2, f.y + f.h / 2, {
      piece: "king",
      dir: d,
      timer: 18
    });
  }

  if (u.phase === "hunt") {
    f.vx = d * Math.max(4.9, f.speed * 1.08);

    if (u.timer % 13 === 0) {
      fx(game, "kingAfterimage", f.x + f.w / 2, f.y + f.h / 2, {
        piece: "king",
        dir: d,
        timer: 18
      });
    }

    if (dist <= u.grabRange && closeY) {
      u.phase = "grab";
      u.timer = 0;
      u.grabbed = true;
      enemy.stun = Math.max(enemy.stun, 48);
      enemy.hurt = Math.max(enemy.hurt, 48);
      enemy.invuln = 0;

      fx(game, "ultimateLock", enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, {
        piece: "king",
        dir: d,
        timer: 44
      });

      fx(game, "kingGrabFlash", enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, {
        piece: "king",
        dir: d,
        timer: 34
      });

      game.shake = Math.max(game.shake, 18);
      game.hitstop = Math.max(game.hitstop, 6);
    } else if (u.timer >= u.duration) {
      u.phase = "shockwave";
      u.timer = 0;
    }
  } else if (u.phase === "grab") {
    f.vx *= 0.16;
    enemy.x = f.x + f.w / 2 + d * 50 - enemy.w / 2;
    enemy.y = f.y + f.h * 0.04;
    enemy.vx = 0;
    enemy.vy = 0;
    enemy.stun = Math.max(enemy.stun, 3);

    if (u.timer === 16) {
      const hb = makeHitbox(f, f.x + f.w / 2 - 165, f.y - 32, 330, 205, {
        dmg: 16,
        kb: 38,
        lift: -18,
        wall: 62,
        hitstop: 10,
        ultimate: true,
        breakArmor: true,
        dir: d,
        hitKey: `kingUltHit1:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);
      fx(game, "kingSmash", enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, {
        piece: "king",
        dir: d,
        timer: 32
      });
      game.shake = Math.max(game.shake, 20);
    }

    if (u.timer === 38) {
      const hb = makeHitbox(f, f.x + f.w / 2 - 210, f.y - 52, 420, 245, {
        dmg: 28,
        kb: 78,
        lift: -32,
        wall: 108,
        hitstop: 18,
        ultimate: true,
        breakArmor: true,
        dir: d,
        hitKey: `kingUltSlam:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);
      fx(game, "kingSlam", enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, {
        piece: "king",
        dir: d,
        timer: 52
      });
      game.shake = Math.max(game.shake, 30);
    }

    if (u.timer >= 58) {
      u.phase = "shockwave";
      u.timer = 0;
    }
  } else if (u.phase === "shockwave") {
    f.vx *= 0.15;

    if (!u.shockwaveDone) {
      u.shockwaveDone = true;

      const hb = makeHitbox(f, f.x + f.w / 2 - 255, f.y - 42, 510, 228, {
        dmg: u.grabbed ? 12 : 24,
        kb: u.grabbed ? 42 : 74,
        lift: -24,
        wall: 92,
        hitstop: 14,
        ultimate: true,
        breakArmor: true,
        dir: d,
        hitKey: `kingUltShock:${f.attackId}`
      });

      applyHitbox(f, enemy, hb, game);
      fx(game, "kingShockwave", f.x + f.w / 2, f.y + f.h * 0.58, {
        piece: "king",
        dir: d,
        timer: 60
      });
      game.shake = Math.max(game.shake, 28);
    }

    if (u.timer >= 32) {
      endUltimate(f);
    }
  }
}

function updateRookUltimate(f, enemy, game, input, u) {
  u.timer++;

  f.vx *= 0.05;
  f.vy = Math.min(f.vy, 1);
  f.armor = Math.max(f.armor, 34);

  u.dir = f.x < enemy.x ? 1 : -1;
  f.facing = u.dir;
  f.attackFacing = u.dir;

  if (input.up) u.aimY = clamp(u.aimY - 1.45, -34, 16);
  if (input.down) u.aimY = clamp(u.aimY + 1.45, -34, 24);

  if (u.phase === "windup" && u.timer >= 44) {
    u.phase = "fire";
    u.timer = 0;
    game.shake = Math.max(game.shake, 8);

    fx(game, "rookShell", f.x + f.w / 2, f.y + 62, {
      piece: "rook",
      dir: u.dir,
      timer: 26,
      charge: true
    });
  }

  if (u.phase === "fire") {
    if (u.timer % u.fireEvery === 1 && u.shots < u.maxShots) {
      u.shots++;

      const originX = u.dir === 1 ? f.x + f.w : f.x;
      const y = f.y + 34 + u.aimY;

      u.beams.push({
        id: u.shots,
        x: originX,
        y,
        dir: u.dir,
        length: 0,
        maxLength: u.dir === 1 ? RIGHT - originX : originX - LEFT,
        grow: 96,
        linger: 14,
        hitDone: false
      });

      fx(game, "rookShell", originX + u.dir * 24, y + 22, {
        piece: "rook",
        dir: u.dir,
        timer: 18,
        beamStart: true
      });
    }

    for (const beam of u.beams) {
      if (beam.length < beam.maxLength) {
        beam.length = Math.min(beam.maxLength, beam.length + beam.grow);
      } else {
        beam.linger--;
      }

      const beamX = beam.dir === 1 ? beam.x : beam.x - beam.length;
      const beamW = beam.length;
      const hb = makeHitbox(f, beamX, beam.y, beamW, 42, {
        dmg: 3,
        kb: 9 + u.shots * 0.4,
        lift: -2,
        wall: 25,
        hitstop: 2,
        ultimate: true,
        breakArmor: false,
        once: true,
        dir: beam.dir,
        hitKey: `rookUlt:${f.attackId}:${beam.id}`
      });

      applyHitbox(f, enemy, hb, game);
    }

    u.beams = u.beams.filter((beam) => beam.linger > 0);

    if (u.shots >= u.maxShots && u.beams.length === 0 && u.timer > u.maxShots * u.fireEvery + 18) {
      u.phase = "recover";
      u.timer = 0;
    }
  }

  if (u.phase === "recover" && u.timer > 24) {
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

function canActDuringUltimate(f) {
  const u = f.ultimateState;
  if (!u) return true;

  return (
    (u.type === "bishopSword" && u.phase === "active") ||
    (u.type === "pawnUprising" && u.phase === "buff") ||
    (u.type === "queenDominion" && u.phase === "hyper")
  );
}

function scriptMove(f, input = {}) {
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
        if (s.t <= 0) {
      f.script = null;
    }
  }

  if (s.type === "knightL") {
    if (s.phase === 1) {
      f.vx = s.primary.x * s.s1;
      f.vy = s.primary.y * s.s1;
      s.t--;

      if (s.primary.x) {
        f.facing = s.primary.x;
        f.attackFacing = s.primary.x;
      }

      if (s.t <= 0) {
        s.phase = 2;
      }
    } else {
      f.vx = s.secondary.x * s.s2;
      f.vy = s.secondary.y * s.s2;
      s.t2--;

      if (s.secondary.x) {
        f.facing = s.secondary.x;
        f.attackFacing = s.secondary.x;
      }

      if (s.t2 <= 0) {
        f.script = null;
      }
    }
  }

  if (s.type === "knightAirL") {
    if (s.done) {
      f.vx *= 0.75;
      f.vy *= 0.75;
      return;
    }

    function chooseSecondary() {
      if (s.primary.x !== 0) {
        if (input.down && !input.up) return { x: 0, y: 1 };
        return { x: 0, y: -1 };
      }

      if (input.left && !input.right) return { x: -1, y: 0 };
      if (input.right && !input.left) return { x: 1, y: 0 };
      return { x: f.facing || 1, y: 0 };
    }

    const dir = s.phase === 1 ? s.primary : s.secondary;
    const speed = s.phase === 1 ? s.longSpeed : s.shortSpeed;
    const limit = s.phase === 1 ? s.longDistance : s.shortDistance;
    const step = Math.min(speed, Math.max(0, limit - s.traveled));

    f.vx = dir.x * step;
    f.vy = dir.y * step;

    if (dir.x) {
      f.facing = dir.x;
      f.attackFacing = dir.x;
    }

    s.traveled += step;

    if (s.phase === 1 && s.traveled >= s.longDistance) {
      s.phase = 2;
      s.secondary = chooseSecondary();
      s.traveled = 0;
      s.pivot = {
        x: f.x + f.w / 2 + f.vx,
        y: f.y + f.h / 2 + f.vy
      };
    } else if (s.phase === 2 && s.traveled >= s.shortDistance) {
      s.end = {
        x: f.x + f.w / 2 + f.vx,
        y: f.y + f.h / 2 + f.vy
      };
      s.done = true;
    }
  }

  if (s.type === "bishopZigzag") {
    f.vx = s.dir * s.sx;
    f.vy = s.yDir * s.sy;
    s.t--;

    f.facing = s.dir;
    f.attackFacing = s.dir;

    if (s.t <= 0) {
      if (s.phase === 0) {
        s.phase = 1;
        s.t = 14;
        s.yDir *= -1;
      } else {
        f.script = null;
      }
    }
  }
}

function startAttack(f, base, input, game) {
  if (f.attack || f.stun > 0 || !canActDuringUltimate(f)) return false;

  const move = moveName(base, f);
  const aim = aimFromInput(input);
  const m = meta(f, move, aim);

  if (f.stamina < m.stamina) return false;

  const cdKey = base === "light"
    ? "lightCd"
    : base === "heavy"
      ? "heavyCd"
      : base === "special"
        ? "specialCd"
        : "counterCd";

  if (f[cdKey] > 0) return false;

  f.attack = move;
  f.attackAim = aim;
  f.attackTimer = m.duration;
  f.attackDuration = m.duration;
  f.attackFacing = f.facing || 1;
  f.hitDone = false;
  f.hitList = [];
  f.multiHitWait = 0;
  f[cdKey] = m.cd;
  f.attackId++;

  f.stamina = Math.max(0, f.stamina - m.stamina);
  f.staminaDelay = 24;

  const p = pieceOf(f);
  const d = f.attackFacing;

  if (base === "counter") {
    f.armor = Math.max(f.armor, m.armor);
    f.vx *= 0.15;
    f.vy *= 0.7;
    fx(game, "counterReady", f.x + f.w / 2, f.y + f.h / 2, {
      piece: p,
      dir: d,
      timer: 18
    });
  } else if (base === "special") {
    if (p === "king") {
      if (aim === "down") {
        f.vx *= 0.1;
        f.armor = Math.max(f.armor, 42);
      } else if (aim === "up") {
        f.vy = -12.5;
        f.vx += d * 2.6;
        f.armor = Math.max(f.armor, 20);
      } else {
        f.vx += d * 12;
        f.armor = Math.max(f.armor, 36);
      }
    }

    if (p === "rook") {
      if (aim === "forward") {
        f.vx *= 0.04;
        f.armor = Math.max(f.armor, 50);
      } else if (aim === "up") {
        f.vx *= 0.35;
        f.vy = -7.5;
      } else {
        f.vx += d * 4;
        f.armor = Math.max(f.armor, 32);
      }
    }

    if (p === "bishop") {
      if (isBishopSword(f)) {
        if (aim === "up") {
          f.vx += d * 3.5;
          f.vy = -11.2;
        } else if (aim === "down") {
          f.vx += d * 6.5;
          f.vy = Math.max(f.vy, 7.5);
        } else {
          f.vx += d * 10;
        }
      } else {
        f.script = bishopZigzag(f, input);
      }
    }

    if (p === "knight") {
      f.script = move === "airSpecial" ? knightAirPattern(f, input) : knightPattern(f, input);
    }

    if (p === "pawn") {
      if (aim === "up") {
        f.vy = -11;
        f.vx += d * 2.4;
      } else if (aim === "down") {
        f.vx += d * 5.8;
      } else {
        f.vx += d * 7.3;
      }
    }

    if (p === "queen") {
      if (aim === "up") {
        f.vy = -14;
        f.vx += d * 6;
      } else if (aim === "down") {
        f.vx += d * 12;
        f.vy = 8;
      } else {
        f.script = fixed(d * 15.5, -2.8, 12);
      }
    }
  } else {
    if (p === "king" && base === "heavy") {
      f.vx += d * 5.8;
      f.armor = Math.max(f.armor, m.armor);
    }

    if (p === "king" && move === "airHeavy") {
      f.vy = Math.max(f.vy, 9.5);
      f.vx += d * 2;
    }

    if (p === "rook" && base === "heavy") {
      f.vx += d * 2.5;
      f.armor = Math.max(f.armor, m.armor);
    }

    if (p === "bishop" && isBishopSword(f) && base === "heavy") {
      f.vx += d * 7.5;
    }

    if (p === "knight" && base === "heavy") {
      f.vx += d * 4;
    }

    if (p === "queen" && base === "heavy") {
      f.vx += d * 5.5;
    }
  }

  fx(game, "attack", f.x + f.w / 2, f.y + f.h / 2, {
    piece: p,
    attack: move,
    aim,
    dir: d,
    sword: isBishopSword(f),
    timer: m.duration
  });

  return true;
}

function triggerCounter(counterer, attacker, game) {
  counterer.attack = null;
  counterer.attackTimer = 0;
  counterer.attackDuration = 0;
  counterer.hitList = [];
  counterer.stun = 0;
  counterer.hurt = 0;
  counterer.invuln = 10;

  const d = counterer.x < attacker.x ? 1 : -1;
  counterer.facing = d;
  counterer.attackFacing = d;

  const p = pieceOf(counterer);
  const m = meta(counterer, "counter");

  const hb = makeHitbox(counterer, d === 1 ? counterer.x + counterer.w : counterer.x - 175, counterer.y - 12, 175, counterer.h + 30, {
    dmg: m.dmg,
    kb: m.kb,
    lift: m.lift,
    wall: m.wall,
    hitstop: 10,
    breakArmor: true,
    grab: m.grab,
    throwPower: m.throwPower,
    once: true,
    dir: d,
    hitKey: `counter:${counterer.attackId}:${attacker.side}`
  });

  applyHitbox(counterer, attacker, hb, game);

  fx(game, "counterFire", counterer.x + counterer.w / 2, counterer.y + counterer.h / 2, {
    piece: p,
    dir: d,
    timer: 24
  });

  game.shake = Math.max(game.shake, 10);
}

function physics(f, input, game, locked) {
  if (!Number.isFinite(f.x)) f.x = 0;
  if (!Number.isFinite(f.y)) f.y = FLOOR - f.h;
  if (!Number.isFinite(f.vx)) f.vx = 0;
  if (!Number.isFinite(f.vy)) f.vy = 0;

  const scriptedCharge = f.script?.type === "knightAirL" && !f.script.done;
  const disabled = locked || scriptedCharge || f.hurt > 5 || f.stun > 0;
  const move = (input.right ? 1 : 0) - (input.left ? 1 : 0);

  if (!disabled) {
    const accel = f.grounded ? 1.3 : 0.62;
    const maxSpeed = f.speed * (input.down && !f.grounded ? 0.85 : 1);

    if (move) f.vx += move * accel;
    else f.vx *= f.grounded ? 0.78 : 0.94;

    f.vx = clamp(f.vx, -maxSpeed, maxSpeed);

    if (move && (!f.attack || f.attackTimer <= 4)) {
      f.facing = move;
    }
  } else {
    f.vx *= f.grounded ? 0.86 : 0.98;
  }

  if (input.down && !f.grounded && !locked && !scriptedCharge) {
    f.vy += 0.85;
  }

  if (!scriptedCharge) f.vy += GRAVITY;
  f.x += f.vx;
  f.y += f.vy;

  if (f.x < LEFT) {
    f.x = LEFT;
    if (f.wallBounceTimer > 0) {
      f.vx = Math.abs(f.wallBouncePower || 20);
      f.vy = Math.min(f.vy, -6);
      fx(game, "wall", f.x, f.y + f.h / 2, { timer: 15 });
    } else {
      f.vx = 0;
    }
  }

  if (f.x + f.w > RIGHT) {
    f.x = RIGHT - f.w;
    if (f.wallBounceTimer > 0) {
      f.vx = -Math.abs(f.wallBouncePower || 20);
      f.vy = Math.min(f.vy, -6);
      fx(game, "wall", f.x + f.w, f.y + f.h / 2, { timer: 15 });
    } else {
      f.vx = 0;
    }
  }

  const floor = game.floorY ?? FLOOR;
  if (f.y + f.h >= floor) {
    if (!f.grounded && f.vy > 10) {
      fx(game, "land", f.x + f.w / 2, floor, {
        piece: pieceOf(f),
        timer: 14
      });
    }

    f.y = floor - f.h;
    f.vy = 0;
    f.grounded = true;
    f.airDashUsed = false;
    f.coyote = 7;
  } else {
    f.grounded = false;
    f.coyote = Math.max(0, f.coyote - 1);
  }
}

function handleJump(f, input) {
  if (f.jumpBuffer > 0) f.jumpBuffer--;

  if (input.seq.jump !== f.lastSeq.jump) {
    f.lastSeq.jump = input.seq.jump;
    f.jumpBuffer = 8;
  }

  if (f.jumpBuffer > 0 && f.coyote > 0 && f.stun <= 0 && f.hurt <= 4 && canActDuringUltimate(f)) {
    f.vy = -f.jump;
    f.grounded = false;
    f.coyote = 0;
    f.jumpBuffer = 0;
  }
}

function dash(f, input, game) {
  if (f.dashCd > 0 || f.stamina < 14 || f.hurt > 4 || f.stun > 0 || !canActDuringUltimate(f)) return;

  const d = input.left && !input.right ? -1 : input.right && !input.left ? 1 : f.facing || 1;

  if (!f.grounded && f.airDashUsed) return;

  f.vx = d * 15;
  f.vy *= 0.42;
  f.stamina -= 14;
  f.staminaDelay = 20;
  f.dashCd = 34;
  f.invuln = 7;

  if (!f.grounded) f.airDashUsed = true;

  f.facing = d;
  f.attackFacing = d;

  fx(game, "dash", f.x + f.w / 2, f.y + f.h / 2, {
    piece: pieceOf(f),
    dir: d,
    timer: 16
  });
}

function tickTimers(f) {
  for (const k of ["lightCd", "heavyCd", "specialCd", "counterCd", "ultimateCd", "hurt", "armor", "invuln", "stun", "dashCd", "wallBounceTimer"]) {
    if (f[k] > 0) f[k]--;
  }

  if (f.staminaDelay > 0) f.staminaDelay--;
  else f.stamina = Math.min(f.maxStamina, f.stamina + 0.82);

  if (f.promoted) {
    f.queenTimer--;
    if (f.queenTimer <= 0) unpromote(f);
  }
}

function updateFighter(f, enemy, input, game) {
  input = input || {};
  input.seq = input.seq || {};

  const faceEnemy = f.x + f.w / 2 < enemy.x + enemy.w / 2 ? 1 : -1;
  f.facing = faceEnemy;
  if (!f.attack || f.ultimateState) {
    f.attackFacing = faceEnemy;
  }

  tickTimers(f);

  let canAct = canActDuringUltimate(f);

  f.crouching = !!input.down && f.grounded && !f.attack && canAct && f.stun <= 0 && f.hurt <= 4;
  const oldBottom = f.y + f.h;
  f.h = f.crouching ? f.crouchH : f.standH;
  f.y = oldBottom - f.h;

  handleJump(f, input);

  if (input.seq.ultimate !== f.lastSeq.ultimate) {
    f.lastSeq.ultimate = input.seq.ultimate;
    startUltimate(f, input, game);
  }

  const ultLocksMovement = updateUltimate(f, enemy, game, input);
  canAct = canActDuringUltimate(f);

  if (input.seq.light !== f.lastSeq.light) {
    f.lastSeq.light = input.seq.light;
    if (canAct) {
      startAttack(f, "light", input, game);
    }
  }

  if (input.seq.heavy !== f.lastSeq.heavy) {
    f.lastSeq.heavy = input.seq.heavy;
    if (canAct) {
      startAttack(f, "heavy", input, game);
    }
  }

  if (input.seq.special !== f.lastSeq.special) {
    f.lastSeq.special = input.seq.special;
    if (canAct) {
      startAttack(f, "special", input, game);
    }
  }

  if (input.seq.counter !== f.lastSeq.counter) {
    f.lastSeq.counter = input.seq.counter;

    if (canAct) {
      if (input.left || input.right) {
        dash(f, input, game);
      } else {
        startAttack(f, "counter", input, game);
      }
    }
  }

  scriptMove(f, input);
  physics(f, input, game, ultLocksMovement);

  if (f.attack) {
    f.attackTimer--;

    if (active(f)) {
      const m = meta(f);

      if (m.multi) {
        f.multiHitWait--;
        if (f.multiHitWait <= 0) {
          const b = box(f);
          const hb = makeHitbox(f, b.x, b.y, b.w, b.h, {
            dmg: m.dmg,
            kb: m.kb,
            lift: m.lift,
            wall: m.wall,
            hitstop: 3,
            breakArmor: m.breakArmor,
            grab: m.grab,
            throwPower: m.throwPower,
            dir: f.attackFacing,
            hitKey: `${f.attackId}:${Math.floor((f.attackDuration - f.attackTimer) / m.interval)}`
          });

          applyHitbox(f, enemy, hb, game);
          f.multiHitWait = m.interval;
        }
      } else if (!f.hitDone) {
        const b = box(f);
        const hb = makeHitbox(f, b.x, b.y, b.w, b.h, {
          dmg: m.dmg,
          kb: m.kb,
          lift: m.lift,
          wall: m.wall,
          hitstop: 5,
          breakArmor: m.breakArmor,
          grab: m.grab,
          throwPower: m.throwPower,
          dir: f.attackFacing,
          hitKey: `${f.attackId}:single`
        });

        if (applyHitbox(f, enemy, hb, game)) {
          f.hitDone = true;
        }
      }
    }

    if (f.attackTimer <= 0) {
      f.attack = null;
      f.attackDuration = 0;
      f.hitDone = false;
      f.hitList = [];
      if (f.script?.type === "knightAirL") f.script = null;
    }
  }

  
  f.x = clamp(f.x, LEFT, RIGHT - f.w);
  f.y = clamp(f.y, -220, FLOOR - f.h);
}

function updateRound(lobby) {
  const game = lobby.game;
  if (!game || game.roundOver) return;

  const white = game.fighters.white;
  const black = game.fighters.black;

  game.tick++;
  game.roundTime = Math.max(0, game.roundTime - 1);

  if (game.hitstop > 0) {
    game.hitstop--;
    tickEffects(game);
    return;
  }

  const wp = players[white.id];
  const bp = players[black.id];

  updateFighter(white, black, wp?.input || {}, game);
  updateFighter(black, white, bp?.input || {}, game);

  if (white.hp <= 0 || black.hp <= 0 || game.roundTime <= 0) {
    game.roundOver = true;

    if (white.hp > black.hp) game.roundWinner = "white";
    else if (black.hp > white.hp) game.roundWinner = "black";
    else game.roundWinner = "draw";

    if (game.roundWinner === "white") lobby.match.whiteRounds++;
    if (game.roundWinner === "black") lobby.match.blackRounds++;

    if (game.roundWinner === "draw") {
      lobby.message = "Draw round.";
    } else {
      const name = game.roundWinner === "white"
        ? players[lobby.whiteId]?.name || "White"
        : players[lobby.blackId]?.name || "Black";

      lobby.message = `${name} wins the round.`;
    }

    game.roundOverTimer = 150;
    game.shake = Math.max(game.shake, 22);

    fx(game, "roundEnd", W / 2, H / 2, {
      timer: 90,
      winner: game.roundWinner
    });
  }

  tickEffects(game);

  game.shake = Math.max(0, game.shake - 0.55);
}

function finishMatch(lobby, winnerSide) {
  const winnerId = winnerSide === "white" ? lobby.whiteId : lobby.blackId;
  const winnerName = players[winnerId]?.name || winnerSide;

  leaderboard[winnerName] = (leaderboard[winnerName] || 0) + 1;

  lobby.status = "finished";
  lobby.winner = winnerName;
  lobby.message = `${winnerName} wins the match.`;
  lobby.game = null;

  sendLobbyData();
}

function afterRound(lobby) {
  if (!lobby.game || !lobby.game.roundOver) return;

  lobby.game.roundOverTimer--;

  if (lobby.game.roundOverTimer > 0) return;

  if (lobby.match.whiteRounds >= ROUNDS_TO_WIN) {
    finishMatch(lobby, "white");
    return;
  }

  if (lobby.match.blackRounds >= ROUNDS_TO_WIN) {
    finishMatch(lobby, "black");
    return;
  }

  lobby.match.round++;
  startRound(lobby);
}

function tick() {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.status !== "playing" || !lobby.game) continue;

    updateRound(lobby);
    afterRound(lobby);
    sendGame(lobby);
  }
}

setInterval(tick, 1000 / FPS);

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    name: "Nameless",
    characterKey: "king",
    lobbyId: null,
    role: "menu",
    input: {
      left: false,
      right: false,
      up: false,
      down: false,
      seq: {
        light: 0,
        heavy: 0,
        special: 0,
        counter: 0,
        ultimate: 0,
        jump: 0
      }
    }
  };

  socket.emit("welcome", {
    id: socket.id,
    characters: CHARACTERS
  });

  sendLobbyData();

  socket.on("setName", (name) => {
    players[socket.id].name = cleanName(name);
    sendLobbyData();
  });

  socket.on("setCharacter", (key) => {
    if (!CHARACTERS[key]) return;
    players[socket.id].characterKey = key;
    sendLobbyData();
  });

  socket.on("createLobby", (name) => {
    leaveLobby(socket.id);

    const id = nextLobbyId++;
    const lobby = {
      id,
      name: cleanName(name || `${players[socket.id].name}'s Board`),
      status: "waiting",
      whiteId: socket.id,
      blackId: null,
      spectators: new Set(),
      message: "Waiting for opponent.",
      winner: null,
      match: null,
      game: null
    };

    lobbies[id] = lobby;

    players[socket.id].lobbyId = id;
    players[socket.id].role = "white";

    socket.join(room(id));

    socket.emit("enteredLobby", {
      lobbyId: id,
      role: "white"
    });

    sendLobbyData();
    sendGame(lobby);
  });

  socket.on("joinLobby", (id) => {
    id = Number(id);
    const lobby = lobbies[id];
    if (!lobby) return;

    leaveLobby(socket.id);

    if (!lobby.whiteId) {
      lobby.whiteId = socket.id;
      players[socket.id].role = "white";
    } else if (!lobby.blackId) {
      lobby.blackId = socket.id;
      players[socket.id].role = "black";
    } else {
      lobby.spectators.add(socket.id);
      players[socket.id].role = "spectator";
    }

    players[socket.id].lobbyId = id;
    socket.join(room(id));

    socket.emit("enteredLobby", {
      lobbyId: id,
      role: players[socket.id].role
    });

    if (lobby.whiteId && lobby.blackId && lobby.status === "waiting") {
      initMatch(lobby);
      startRound(lobby);
    }

    sendLobbyData();
    sendGame(lobby);
  });

  socket.on("spectateLobby", (id) => {
    id = Number(id);
    const lobby = lobbies[id];
    if (!lobby) return;

    leaveLobby(socket.id);

    lobby.spectators.add(socket.id);
    players[socket.id].lobbyId = id;
    players[socket.id].role = "spectator";

    socket.join(room(id));

    socket.emit("enteredLobby", {
      lobbyId: id,
      role: "spectator"
    });

    sendLobbyData();
    sendGame(lobby);
  });

  socket.on("leaveLobby", () => {
    leaveLobby(socket.id);
    socket.emit("leftLobby");
    sendLobbyData();
  });

  socket.on("input", (input) => {
    const p = players[socket.id];
    if (!p) return;

    p.input = {
      left: !!input?.left,
      right: !!input?.right,
      up: !!input?.up,
      down: !!input?.down,
      seq: {
        light: Number(input?.seq?.light || 0),
        heavy: Number(input?.seq?.heavy || 0),
        special: Number(input?.seq?.special || 0),
        counter: Number(input?.seq?.counter || 0),
        ultimate: Number(input?.seq?.ultimate || 0),
        jump: Number(input?.seq?.jump || 0)
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
  console.log(`Chess Brawl server running on http://localhost:${PORT}`);
});
