const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const TICK_RATE = 60;
const WIDTH = 960;
const HEIGHT = 540;
const FLOOR_Y = 430;
const LEFT_WALL = 22;
const RIGHT_WALL = WIDTH - 22;

const GRAVITY = 0.92;
const ROUND_TIME = 99 * 60;
const ROUNDS_TO_WIN = 3;

const PROMOTION_MAX = 180;
const QUEEN_DURATION = 6 * 60;

const MOVE_SPEED_MULT = 1.55;
const JUMP_MULT = 1.14;
const GLOBAL_KNOCKBACK_MULT = 1.58;
const GLOBAL_LIFT_MULT = 1.2;
const WALL_BOUNCE_DAMAGE_MULT = 0.76;

const MAX_EFFECTS = 180;
const MAX_LOBBIES = 80;

const players = {};
const lobbies = {};
const leaderboard = {};
let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Heavy bruiser. Huge sword swings, royal grabs, and a crushing counter.",
    maxHp: 760,
    speed: 4.15,
    jump: 12.4,
    width: 72,
    height: 124
  },
  rook: {
    name: "Rook",
    title: "Fortress artillery. Screen-wide castle beam with real windup and brutal wall pressure.",
    maxHp: 735,
    speed: 3.9,
    jump: 11.4,
    width: 84,
    height: 132
  },
  bishop: {
    name: "Bishop",
    title: "Diagonal duelist. Rushes through angles, and air special zigzags through the sky.",
    maxHp: 635,
    speed: 5.45,
    jump: 16.4,
    width: 64,
    height: 122
  },
  knight: {
    name: "Knight",
    title: "Fast disruptor. L-shaped aerial heavy, lance movement, and evasive counter slash.",
    maxHp: 640,
    speed: 5.35,
    jump: 19.1,
    width: 66,
    height: 116
  },
  pawn: {
    name: "Pawn",
    title: "Stubborn lancer. More health now, but still needs time to earn queen form.",
    maxHp: 560,
    speed: 5.0,
    jump: 13.6,
    width: 56,
    height: 106
  }
};

function cleanName(name) {
  return String(name || "Nameless").trim().slice(0, 18) || "Nameless";
}

function roomName(id) {
  return `lobby:${id}`;
}

function getSocket(id) {
  return io.sockets.sockets.get(id);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function makeId() {
  return String(nextLobbyId++);
}

function getCharacter(key) {
  return CHARACTERS[key] || CHARACTERS.king;
}

function publicLobbyList() {
  return Object.values(lobbies).map((lobby) => ({
    id: lobby.id,
    name: lobby.name,
    status: lobby.status,
    hostName: players[lobby.hostId]?.name || "Unknown",
    whiteName: players[lobby.whiteId]?.name || null,
    blackName: players[lobby.blackId]?.name || null,
    spectatorCount: lobby.spectators.size
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
    lobbies: publicLobbyList(),
    leaderboard: publicLeaderboard(),
    characters: CHARACTERS
  });
}

function pushEffect(game, type, x, y, extra = {}) {
  if (!game) return;

  game.effects.push({
    id: `${game.tick}:${type}:${game.effects.length}:${Math.random()}`,
    type,
    x: Math.round(x),
    y: Math.round(y),
    timer: extra.timer ?? 18,
    ...extra
  });

  if (game.effects.length > MAX_EFFECTS) {
    game.effects.splice(0, game.effects.length - MAX_EFFECTS);
  }
}

function decayEffects(game) {
  if (!game) return;

  game.effects = game.effects.filter((fx) => {
    fx.timer -= 1;
    return fx.timer > 0;
  });
}

function effectivePiece(f) {
  if (f.characterKey === "pawn" && f.promoted) return "queen";
  return f.characterKey;
}

function createFighter(socketId, side, characterKey) {
  const ch = getCharacter(characterKey);

  return {
    id: socketId,
    name: players[socketId]?.name || "Unknown",
    side,
    characterKey,
    characterName: ch.name,

    x: side === "white" ? 220 : 700,
    y: FLOOR_Y - ch.height,
    vx: 0,
    vy: 0,

    width: ch.width,
    standingHeight: ch.height,
    crouchHeight: Math.floor(ch.height * 0.72),
    height: ch.height,

    maxHp: ch.maxHp,
    hp: ch.maxHp,
    speed: ch.speed * MOVE_SPEED_MULT,
    jump: ch.jump * JUMP_MULT,

    facing: side === "white" ? 1 : -1,
    attackFacing: side === "white" ? 1 : -1,

    grounded: true,
    crouching: false,

    attack: null,
    attackTimer: 0,
    attackDuration: 0,
    attackAim: "forward",
    hitThisAttack: false,
    multiHitCooldown: 0,

    counterTimer: 0,
    counterDuration: 0,
    counterCooldown: 0,
    counterUsed: false,

    lightCooldown: 0,
    heavyCooldown: 0,
    specialCooldown: 0,

    stamina: 100,
    maxStamina: 100,
    staminaRegenDelay: 0,

    hurtTimer: 0,
    armorTimer: 0,
    invulnTimer: 0,
    guardBrokenTimer: 0,

    dashTimer: 0,
    dashCooldown: 0,
    airDodged: false,

    jumpBuffer: 0,
    coyoteTimer: 0,

    wallSide: 0,
    wallJumpLock: 0,
    wallBounceWindow: 0,
    wallBouncePower: 0,

    comboCount: 0,
    comboTimer: 0,
    lastHitBy: null,

    promoted: false,
    promotionMeter: 0,
    queenTimer: 0,
    preQueenStats: null,

    scriptedMove: null,

    jumpWasDown: false,
    counterWasDown: false
  };
}

function initMatch(lobby) {
  lobby.match = {
    currentRound: 1,
    whiteRounds: 0,
    blackRounds: 0,
    roundsToWin: ROUNDS_TO_WIN,
    matchWinner: null
  };
}

function startRound(lobby) {
  if (!lobby.match) initMatch(lobby);

  lobby.status = "playing";
  lobby.winner = null;
  lobby.message = `Round ${lobby.match.currentRound}. Fight.`;

  lobby.game = {
    width: WIDTH,
    height: HEIGHT,
    floorY: FLOOR_Y,
    tick: 0,
    roundTime: ROUND_TIME,
    hitstop: 0,
    shake: 0,
    effects: [],
    roundOver: false,
    roundWinner: null,
    roundOverTimer: 0,
    fighters: {
      white: createFighter(lobby.whiteId, "white", players[lobby.whiteId].characterKey),
      black: createFighter(lobby.blackId, "black", players[lobby.blackId].characterKey)
    }
  };
}

function finishMatch(lobby) {
  lobby.status = "finished";
  lobby.game = null;
}

function sendGameState(lobby) {
  if (!lobby) return;

  io.to(roomName(lobby.id)).emit("gameState", {
    lobby: {
      id: lobby.id,
      name: lobby.name,
      status: lobby.status,
      whiteName: players[lobby.whiteId]?.name || null,
      blackName: players[lobby.blackId]?.name || null,
      winner: lobby.winner,
      message: lobby.message
    },
    match: lobby.match || null,
    game: lobby.game,
    leaderboard: publicLeaderboard()
  });
}

function joinSocketRoom(socket, lobbyId) {
  socket.join(roomName(lobbyId));
}

function leaveCurrentLobby(socketId) {
  const player = players[socketId];
  if (!player || !player.lobbyId) return;

  const lobbyId = player.lobbyId;
  const lobby = lobbies[lobbyId];
  const sock = getSocket(socketId);

  if (sock) sock.leave(roomName(lobbyId));

  if (!lobby) {
    player.lobbyId = null;
    player.role = "menu";
    return;
  }

  lobby.spectators.delete(socketId);

  if (lobby.whiteId === socketId) lobby.whiteId = null;
  if (lobby.blackId === socketId) lobby.blackId = null;

  if (lobby.status === "playing" && lobby.match && !lobby.match.matchWinner) {
    const remainingId = lobby.whiteId || lobby.blackId;

    if (remainingId && players[remainingId]) {
      const winnerName = players[remainingId].name;
      leaderboard[winnerName] = (leaderboard[winnerName] || 0) + 1;
      lobby.match.matchWinner = lobby.whiteId ? "white" : "black";
      lobby.winner = winnerName;
      lobby.message = `${winnerName} wins because the opponent disconnected.`;
    }

    finishMatch(lobby);
  }

  if (!lobby.whiteId && !lobby.blackId && lobby.spectators.size === 0) {
    delete lobbies[lobby.id];
  }

  player.lobbyId = null;
  player.role = "menu";
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function getSpecialAim(input) {
  if (input.jump) return "up";
  if (input.crouch) return "down";
  return "forward";
}

function moveKey(baseType, f) {
  if (!f.grounded) {
    if (baseType === "light") return "airLight";
    if (baseType === "heavy") return "airHeavy";
    if (baseType === "special") return "airSpecial";
  }

  if (f.crouching) {
    if (baseType === "light") return "crouchLight";
    if (baseType === "heavy") return "crouchHeavy";
  }

  return baseType;
}

function attackDir(f) {
  return f.attack ? (f.attackFacing || f.facing || 1) : (f.facing || 1);
}

function getMoveMeta(f, attack = f.attack, aim = f.attackAim || "forward") {
  const piece = effectivePiece(f);

  const m = {
    duration: 18,
    activeStart: 4,
    activeEnd: 10,
    damage: 4,
    kb: 9,
    lift: -2,
    cooldown: 16,
    stamina: 3,
    armorBreak: false,
    continuous: false,
    hitInterval: 8,
    wallBounce: 10,
    blockDrain: 12,
    armorOnStart: 0,
    grab: false,
    throwPower: 0
  };

  if (piece === "king") {
    if (attack === "light") Object.assign(m, { duration: 18, activeStart: 5, activeEnd: 12, damage: 6, kb: 14, lift: -3, cooldown: 16, stamina: 4, wallBounce: 14 });
    if (attack === "heavy") Object.assign(m, { duration: 34, activeStart: 12, activeEnd: 22, damage: 13, kb: 28, lift: -8, cooldown: 46, stamina: 12, armorOnStart: 19, armorBreak: true, wallBounce: 36, blockDrain: 34 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 34, activeStart: 11, activeEnd: 20, damage: 12, kb: 26, lift: -15, cooldown: 46, stamina: 11, armorOnStart: 12, wallBounce: 32, blockDrain: 26 });
    if (attack === "airHeavy") Object.assign(m, { duration: 31, activeStart: 9, activeEnd: 19, damage: 11, kb: 23, lift: 13, cooldown: 44, stamina: 10, wallBounce: 30 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 48, activeStart: 14, activeEnd: 28, damage: 15, kb: 36, lift: -8, cooldown: 150, stamina: 22, armorOnStart: 30, armorBreak: true, wallBounce: 48, blockDrain: 44 });
      if (aim === "up") Object.assign(m, { duration: 45, activeStart: 12, activeEnd: 26, damage: 13, kb: 20, lift: -36, cooldown: 145, stamina: 20, armorOnStart: 18, armorBreak: true, wallBounce: 30, blockDrain: 32 });
      if (aim === "down") Object.assign(m, { duration: 46, activeStart: 10, activeEnd: 24, damage: 8, kb: 0, lift: 0, cooldown: 155, stamina: 23, armorOnStart: 24, armorBreak: true, wallBounce: 52, blockDrain: 44, grab: true, throwPower: 38 });
    }
  }

  if (piece === "rook") {
    if (attack === "light") Object.assign(m, { duration: 19, activeStart: 6, activeEnd: 13, damage: 6, kb: 17, lift: -2, cooldown: 18, stamina: 4, wallBounce: 18 });
    if (attack === "heavy") Object.assign(m, { duration: 34, activeStart: 11, activeEnd: 22, damage: 12, kb: 33, lift: -6, cooldown: 54, stamina: 12, armorBreak: true, armorOnStart: 23, wallBounce: 42, blockDrain: 36 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 33, activeStart: 10, activeEnd: 20, damage: 11, kb: 30, lift: -10, cooldown: 52, stamina: 10, wallBounce: 40 });
    if (attack === "airHeavy") Object.assign(m, { duration: 31, activeStart: 9, activeEnd: 19, damage: 10, kb: 25, lift: 12, cooldown: 50, stamina: 10, wallBounce: 32 });

    if (attack === "special") {
      if (aim === "forward") Object.assign(m, { duration: 86, activeStart: 38, activeEnd: 58, damage: 18, kb: 44, lift: -3, cooldown: 230, stamina: 30, armorBreak: true, armorOnStart: 58, wallBounce: 58, blockDrain: 50, continuous: true, hitInterval: 11 });
      if (aim === "up") Object.assign(m, { duration: 62, activeStart: 20, activeEnd: 40, damage: 9, kb: 20, lift: -33, cooldown: 175, stamina: 22, continuous: true, hitInterval: 10, armorOnStart: 40, wallBounce: 30 });
      if (aim === "down") Object.assign(m, { duration: 56, activeStart: 18, activeEnd: 34, damage: 13, kb: 38, lift: -4, cooldown: 175, stamina: 24, armorBreak: true, armorOnStart: 38, wallBounce: 48, blockDrain: 42 });
    }
  }

  if (piece === "bishop") {
    if (attack === "light") Object.assign(m, { duration: 16, activeStart: 4, activeEnd: 11, damage: 5, kb: 13, lift: -7, cooldown: 14, stamina: 3, wallBounce: 14 });
    if (attack === "heavy") Object.assign(m, { duration: 31, activeStart: 8, activeEnd: 21, damage: 11, kb: 27, lift: -20, cooldown: 42, stamina: 9, wallBounce: 30 });
    if (attack === "crouchLight") Object.assign(m, { duration: 15, activeStart: 4, activeEnd: 10, damage: 4, kb: 11, lift: -2, cooldown: 14, stamina: 3, wallBounce: 12 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 18, damage: 9, kb: 21, lift: -12, cooldown: 40, stamina: 8, wallBounce: 24 });
    if (attack === "airHeavy") Object.assign(m, { duration: 31, activeStart: 7, activeEnd: 21, damage: 11, kb: 25, lift: 18, cooldown: 42, stamina: 9, wallBounce: 30 });

    if (attack === "special" || attack === "airSpecial") {
      if (attack === "airSpecial") Object.assign(m, { duration: 48, activeStart: 4, activeEnd: 39, damage: 11, kb: 28, lift: -5, cooldown: 155, stamina: 20, wallBounce: 34, continuous: true, hitInterval: 10 });
      else if (aim === "forward") Object.assign(m, { duration: 38, activeStart: 10, activeEnd: 24, damage: 11, kb: 29, lift: -12, cooldown: 135, stamina: 17, wallBounce: 32 });
      else if (aim === "up") Object.assign(m, { duration: 38, activeStart: 10, activeEnd: 24, damage: 10, kb: 22, lift: -35, cooldown: 135, stamina: 17, wallBounce: 28 });
      else if (aim === "down") Object.assign(m, { duration: 38, activeStart: 10, activeEnd: 24, damage: 11, kb: 30, lift: 12, cooldown: 135, stamina: 17, armorBreak: true, wallBounce: 34, blockDrain: 30 });
    }
  }

  if (piece === "knight") {
    if (attack === "light") Object.assign(m, { duration: 15, activeStart: 4, activeEnd: 10, damage: 5, kb: 12, lift: -5, cooldown: 13, stamina: 3, wallBounce: 14 });
    if (attack === "heavy") Object.assign(m, { duration: 27, activeStart: 8, activeEnd: 17, damage: 9, kb: 22, lift: -23, cooldown: 34, stamina: 8, wallBounce: 28 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 25, activeStart: 7, activeEnd: 15, damage: 8, kb: 20, lift: -16, cooldown: 32, stamina: 8, wallBounce: 24 });
    if (attack === "airHeavy") Object.assign(m, { duration: 34, activeStart: 4, activeEnd: 25, damage: 11, kb: 26, lift: -2, cooldown: 42, stamina: 10, wallBounce: 36, continuous: true, hitInterval: 13 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 36, activeStart: 10, activeEnd: 22, damage: 11, kb: 31, lift: -18, cooldown: 125, stamina: 16, wallBounce: 38 });
      if (aim === "up") Object.assign(m, { duration: 36, activeStart: 10, activeEnd: 22, damage: 10, kb: 20, lift: -38, cooldown: 125, stamina: 16, wallBounce: 28 });
      if (aim === "down") Object.assign(m, { duration: 36, activeStart: 10, activeEnd: 22, damage: 12, kb: 34, lift: 18, cooldown: 130, stamina: 17, armorBreak: true, wallBounce: 40, blockDrain: 30 });
    }
  }

  if (piece === "pawn") {
    if (attack === "light") Object.assign(m, { duration: 16, activeStart: 5, activeEnd: 10, damage: 4, kb: 11, lift: -2, cooldown: 15, stamina: 3, wallBounce: 10 });
    if (attack === "heavy") Object.assign(m, { duration: 27, activeStart: 9, activeEnd: 17, damage: 7, kb: 17, lift: -5, cooldown: 34, stamina: 8, wallBounce: 17 });
    if (attack === "crouchLight") Object.assign(m, { duration: 16, activeStart: 5, activeEnd: 10, damage: 4, kb: 10, lift: -1, cooldown: 15, stamina: 3, wallBounce: 10 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 27, activeStart: 9, activeEnd: 17, damage: 7, kb: 18, lift: -11, cooldown: 36, stamina: 8, wallBounce: 18 });
    if (attack === "airHeavy") Object.assign(m, { duration: 27, activeStart: 9, activeEnd: 17, damage: 7, kb: 17, lift: 10, cooldown: 34, stamina: 8, wallBounce: 18 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 34, activeStart: 10, activeEnd: 21, damage: 8, kb: 22, lift: -4, cooldown: 118, stamina: 15, wallBounce: 22 });
      if (aim === "up") Object.assign(m, { duration: 34, activeStart: 10, activeEnd: 21, damage: 7, kb: 15, lift: -25, cooldown: 118, stamina: 15, wallBounce: 18 });
      if (aim === "down") Object.assign(m, { duration: 34, activeStart: 10, activeEnd: 21, damage: 8, kb: 22, lift: -2, cooldown: 118, stamina: 15, armorBreak: true, wallBounce: 24, blockDrain: 28 });
    }
  }

  if (piece === "queen") {
    if (attack === "light") Object.assign(m, { duration: 16, activeStart: 4, activeEnd: 11, damage: 7, kb: 18, lift: -5, cooldown: 14, stamina: 3, wallBounce: 22 });
    if (attack === "heavy") Object.assign(m, { duration: 29, activeStart: 9, activeEnd: 19, damage: 13, kb: 32, lift: -12, cooldown: 40, stamina: 10, armorBreak: true, armorOnStart: 13, wallBounce: 38, blockDrain: 34 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 30, activeStart: 9, activeEnd: 19, damage: 12, kb: 29, lift: -17, cooldown: 42, stamina: 10, wallBounce: 36 });
    if (attack === "airHeavy") Object.assign(m, { duration: 29, activeStart: 9, activeEnd: 18, damage: 12, kb: 27, lift: 16, cooldown: 42, stamina: 10, wallBounce: 36 });

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 52, activeStart: 14, activeEnd: 31, damage: 15, kb: 40, lift: -8, cooldown: 150, stamina: 20, armorBreak: true, armorOnStart: 24, wallBounce: 50, blockDrain: 42 });
      if (aim === "up") Object.assign(m, { duration: 50, activeStart: 14, activeEnd: 30, damage: 13, kb: 23, lift: -40, cooldown: 150, stamina: 20, armorBreak: true, armorOnStart: 22, wallBounce: 34 });
      if (aim === "down") Object.assign(m, { duration: 50, activeStart: 14, activeEnd: 30, damage: 14, kb: 37, lift: 14, cooldown: 150, stamina: 20, armorBreak: true, armorOnStart: 22, wallBounce: 48, blockDrain: 40 });
    }
  }

  return m;
}

function counterMeta(f) {
  const piece = effectivePiece(f);

  const table = {
    king: { duration: 30, activeStart: 6, activeEnd: 20, cooldown: 90, stamina: 18, damage: 12, kb: 35, lift: -10, armor: 24, wallBounce: 44, name: "Royal Reversal" },
    rook: { duration: 34, activeStart: 6, activeEnd: 22, cooldown: 95, stamina: 18, damage: 10, kb: 42, lift: -4, armor: 30, wallBounce: 52, name: "Castle Reprisal" },
    bishop: { duration: 28, activeStart: 4, activeEnd: 18, cooldown: 82, stamina: 16, damage: 9, kb: 27, lift: -24, armor: 14, wallBounce: 34, name: "Diagonal Punish" },
    knight: { duration: 28, activeStart: 4, activeEnd: 18, cooldown: 80, stamina: 16, damage: 10, kb: 32, lift: -14, armor: 12, wallBounce: 40, name: "Fork Counter" },
    pawn: { duration: 26, activeStart: 5, activeEnd: 17, cooldown: 74, stamina: 13, damage: 7, kb: 24, lift: -8, armor: 10, wallBounce: 26, name: "Last-Rank Jab" },
    queen: { duration: 30, activeStart: 4, activeEnd: 20, cooldown: 78, stamina: 16, damage: 13, kb: 37, lift: -18, armor: 18, wallBounce: 46, name: "Queen's Verdict" }
  };

  return table[piece] || table.king;
}

function forwardBox(f, width, height, yOffset = 0, gap = 0) {
  const dir = attackDir(f);
  const x = dir === 1 ? f.x + f.width + gap : f.x - width - gap;
  return { x, y: f.y + yOffset, width, height };
}

function bodyForwardBox(f, width, height, yOffset = 0, forwardOffset = 0) {
  const dir = attackDir(f);
  const centerX = f.x + f.width / 2 + dir * forwardOffset;
  return {
    x: centerX - width / 2,
    y: f.y + yOffset,
    width,
    height
  };
}

function upBox(f, width, height, xOffset = 0) {
  const dir = attackDir(f);
  return {
    x: f.x + f.width / 2 - width / 2 + dir * xOffset,
    y: f.y - height + 18,
    width,
    height
  };
}

function diagonalBox(f, width, height, yOffset = 0, forwardOffset = 0) {
  const dir = attackDir(f);

  return {
    x: dir === 1
      ? f.x + f.width * 0.45 + forwardOffset
      : f.x + f.width * 0.55 - width - forwardOffset,
    y: f.y + yOffset,
    width,
    height
  };
}

function aroundBodyBox(f, padX = 24, padY = 24) {
  return {
    x: f.x - padX,
    y: f.y - padY,
    width: f.width + padX * 2,
    height: f.height + padY * 2
  };
}

function attackBox(f) {
  const piece = effectivePiece(f);
  const attack = f.attack;
  const aim = f.attackAim || "forward";

  if (piece === "king") {
    if (attack === "light") return forwardBox(f, 100, 58, 26);
    if (attack === "heavy") return forwardBox(f, 150, 92, 14);
    if (attack === "crouchHeavy") return forwardBox(f, 138, 62, f.height * 0.5);
    if (attack === "airHeavy") return bodyForwardBox(f, 130, 108, 20, 20);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 132, 240, 0);
      if (aim === "down") return forwardBox(f, 92, 100, 18);
      return bodyForwardBox(f, 240, 138, -6, 58);
    }
  }

  if (piece === "rook") {
    if (attack === "light") return forwardBox(f, 145, 54, 36);
    if (attack === "heavy") return forwardBox(f, 205, 94, 22);
    if (attack === "crouchHeavy") return forwardBox(f, 180, 58, f.height * 0.53);
    if (attack === "airHeavy") return forwardBox(f, 132, 102, 18);

    if (attack === "special") {
      if (aim === "up") return upBox(f, 110, 312, 0);
      if (aim === "down") return forwardBox(f, 270, 70, f.height * 0.6);
      return f.attackFacing === 1
        ? { x: f.x + f.width * 0.5, y: f.y + 14, width: 880 - (f.x + f.width * 0.5), height: 118 }
        : { x: 80, y: f.y + 14, width: f.x + f.width * 0.5 - 80, height: 118 };
    }
  }

  if (piece === "bishop") {
    if (attack === "light") return forwardBox(f, 130, 86, 12);
    if (attack === "heavy") return diagonalBox(f, 180, 152, -96, 18);
    if (attack === "crouchLight") return forwardBox(f, 120, 38, f.height * 0.63);
    if (attack === "crouchHeavy") return forwardBox(f, 150, 68, f.height * 0.43);
    if (attack === "airHeavy") return diagonalBox(f, 180, 158, 18, 18);

    if (attack === "airSpecial") return aroundBodyBox(f, 54, 42);

    if (attack === "special") {
      if (aim === "up") return diagonalBox(f, 196, 182, -150, 32);
      if (aim === "down") return diagonalBox(f, 196, 182, 42, 32);
      return diagonalBox(f, 235, 150, -16, 30);
    }
  }

  if (piece === "knight") {
    if (attack === "light") return forwardBox(f, 80, 58, 28);
    if (attack === "heavy") return bodyForwardBox(f, 110, 108, -16, 30);
    if (attack === "crouchHeavy") return forwardBox(f, 102, 76, f.height * 0.4);
    if (attack === "airHeavy") return aroundBodyBox(f, 34, 30);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 120, 158, 10);
      if (aim === "down") return bodyForwardBox(f, 142, 116, f.height * 0.28, 42);
      return bodyForwardBox(f, 142, 112, -4, 52);
    }
  }

  if (piece === "pawn") {
    if (attack === "light") return forwardBox(f, 92, 32, 38);
    if (attack === "heavy") return forwardBox(f, 122, 60, 24);
    if (attack === "crouchLight") return forwardBox(f, 88, 26, f.height * 0.64);
    if (attack === "crouchHeavy") return forwardBox(f, 106, 58, f.height * 0.44);
    if (attack === "airHeavy") return forwardBox(f, 98, 82, 14);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 84, 138, 8);
      if (aim === "down") return forwardBox(f, 122, 58, f.height * 0.56);
      return forwardBox(f, 140, 52, 28);
    }
  }

  if (piece === "queen") {
    if (attack === "light") return forwardBox(f, 155, 84, 14);
    if (attack === "heavy") return forwardBox(f, 222, 130, -8);
    if (attack === "crouchHeavy") return forwardBox(f, 178, 70, f.height * 0.44);
    if (attack === "airHeavy") return forwardBox(f, 158, 126, 6);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 180, 280, 0);
      if (aim === "down") return forwardBox(f, 294, 110, f.height * 0.32);
      return bodyForwardBox(f, 340, 182, -20, 52);
    }
  }

  return forwardBox(f, 70, 50, 20);
}

function counterBox(f) {
  const piece = effectivePiece(f);
  const dir = f.facing || 1;

  if (piece === "rook") {
    return dir === 1
      ? { x: f.x - 20, y: f.y + 6, width: 200, height: f.height + 20 }
      : { x: f.x + f.width - 180, y: f.y + 6, width: 200, height: f.height + 20 };
  }

  if (piece === "bishop") return diagonalBox(f, 190, 170, -70, 20);
  if (piece === "knight") return aroundBodyBox(f, 54, 42);
  if (piece === "pawn") return forwardBox(f, 135, 58, 34);
  if (piece === "queen") return aroundBodyBox(f, 90, 70);

  return forwardBox(f, 160, 110, 10);
}

function currentMoveActive(f) {
  if (!f.attack) return false;
  const meta = getMoveMeta(f);
  const elapsed = f.attackDuration - f.attackTimer;
  return elapsed >= meta.activeStart && elapsed <= meta.activeEnd;
}

function currentCounterActive(f) {
  if (f.counterTimer <= 0 || f.counterUsed) return false;
  const meta = counterMeta(f);
  const elapsed = f.counterDuration - f.counterTimer;
  return elapsed >= meta.activeStart && elapsed <= meta.activeEnd;
}

function promotePawn(f) {
  if (f.characterKey !== "pawn" || f.promoted) return;

  f.preQueenStats = {
    maxHp: f.maxHp,
    speed: f.speed,
    jump: f.jump,
    width: f.width,
    standingHeight: f.standingHeight,
    crouchHeight: f.crouchHeight,
    characterName: f.characterName
  };

  const hpRatio = f.hp / f.maxHp;

  f.promoted = true;
  f.queenTimer = QUEEN_DURATION;
  f.promotionMeter = PROMOTION_MAX;

  f.maxHp = Math.round(f.maxHp * 1.38);
  f.hp = Math.max(1, Math.ceil(f.maxHp * hpRatio));
  f.speed *= 1.12;
  f.jump *= 1.08;
  f.width += 8;
  f.standingHeight += 16;
  f.crouchHeight = Math.floor(f.standingHeight * 0.72);
  f.height = f.standingHeight;
  f.characterName = "Queen";
  f.armorTimer = 24;
}

function revertQueen(f) {
  if (!f.promoted || !f.preQueenStats) return;

  const hpRatio = f.hp / f.maxHp;

  f.promoted = false;
  f.queenTimer = 0;
  f.promotionMeter = 0;

  f.maxHp = f.preQueenStats.maxHp;
  f.hp = Math.max(1, Math.ceil(f.maxHp * hpRatio));
  f.speed = f.preQueenStats.speed;
  f.jump = f.preQueenStats.jump;
  f.width = f.preQueenStats.width;
  f.standingHeight = f.preQueenStats.standingHeight;
  f.crouchHeight = f.preQueenStats.crouchHeight;
  f.height = f.crouching ? f.crouchHeight : f.standingHeight;
  f.characterName = "Pawn";
  f.preQueenStats = null;

  if (f.y + f.height > FLOOR_Y) {
    f.y = FLOOR_Y - f.height;
  }
}

function chargePawn(f, amount) {
  if (f.characterKey !== "pawn" || f.promoted) return;
  f.promotionMeter = clamp(f.promotionMeter + amount, 0, PROMOTION_MAX);

  if (f.promotionMeter >= PROMOTION_MAX) {
    promotePawn(f);
  }
}

function updateWallState(f) {
  if (f.x <= LEFT_WALL + 2) f.wallSide = -1;
  else if (f.x + f.width >= RIGHT_WALL - 2) f.wallSide = 1;
  else f.wallSide = 0;
}

function tryWallJump(f, jumpPressed) {
  if (!jumpPressed || f.grounded || !f.wallSide || f.wallJumpLock > 0) return;

  let jumpMul = 1;
  let xMul = 1.7;
  const piece = effectivePiece(f);

  if (piece === "knight") {
    jumpMul = 1.45;
    xMul = 2.08;
  }

  if (piece === "bishop") {
    jumpMul = 1.26;
    xMul = 2.0;
  }

  if (piece === "rook") {
    jumpMul = 0.75;
    xMul = 1.34;
  }

  if (piece === "king") {
    jumpMul = 0.82;
    xMul = 1.42;
  }

  if (piece === "queen") {
    jumpMul = 1.18;
    xMul = 1.9;
  }

  f.vx = -f.wallSide * f.speed * xMul;
  f.vy = -f.jump * 0.92 * jumpMul;
  f.facing = -f.wallSide;
  f.attackFacing = f.facing;
  f.wallJumpLock = 16;
}

function fixedVectorMove(vx, vy, frames) {
  return {
    type: "fixedVector",
    vx,
    vy,
    frames
  };
}

function chooseKnightLPattern(f, input) {
  let primary;

  if (input.left && !input.right) primary = { x: -1, y: 0 };
  else if (input.right && !input.left) primary = { x: 1, y: 0 };
  else if (input.jump && !input.crouch) primary = { x: 0, y: -1 };
  else if (input.crouch && !input.jump) primary = { x: 0, y: 1 };
  else primary = { x: f.facing || 1, y: 0 };

  let secondary;

  if (primary.x !== 0) {
    if (input.jump && !input.crouch) secondary = { x: 0, y: -1 };
    else if (input.crouch && !input.jump) secondary = { x: 0, y: 1 };
    else secondary = { x: 0, y: -1 };
  } else {
    if (input.left && !input.right) secondary = { x: -1, y: 0 };
    else if (input.right && !input.left) secondary = { x: 1, y: 0 };
    else secondary = { x: f.facing || 1, y: 0 };
  }

  return {
    type: "knightL",
    phase: 1,
    timer: 8,
    timer2: 7,
    primary,
    secondary,
    speed1: 16.5,
    speed2: 12.0
  };
}

function bishopZigzagPattern(f, input) {
  const dir = f.facing || 1;

  let firstY = -1;
  if (input.crouch && !input.jump) firstY = 1;
  if (input.jump && !input.crouch) firstY = -1;

  return {
    type: "bishopZigzag",
    phase: 0,
    timer: 6,
    dir,
    firstY,
    speedX: 11.7,
    speedY: 9.5,
    phases: [
      { x: dir, y: firstY, frames: 6 },
      { x: dir, y: -firstY, frames: 7 },
      { x: dir, y: firstY, frames: 7 },
      { x: dir, y: -firstY, frames: 5 }
    ]
  };
}

function applyScriptedMovement(f) {
  const sm = f.scriptedMove;
  if (!sm) return;

  if (sm.type === "fixedVector") {
    f.vx = sm.vx;
    f.vy = sm.vy;
    sm.frames -= 1;

    if (sm.frames <= 0) f.scriptedMove = null;
    return;
  }

  if (sm.type === "knightL") {
    if (sm.phase === 1) {
      f.vx = sm.primary.x * sm.speed1;
      f.vy = sm.primary.y * sm.speed1;
      sm.timer -= 1;

      if (sm.timer <= 0) {
        sm.phase = 2;
        sm.timer = sm.timer2;
      }
    } else {
      f.vx = sm.secondary.x * sm.speed2;
      f.vy = sm.secondary.y * sm.speed2;
      sm.timer -= 1;

      if (sm.timer <= 0) f.scriptedMove = null;
    }

    return;
  }

  if (sm.type === "bishopZigzag") {
    const phase = sm.phases[sm.phase];

    if (!phase) {
      f.scriptedMove = null;
      return;
    }

    f.vx = phase.x * sm.speedX;
    f.vy = phase.y * sm.speedY;

    sm.timer -= 1;

    if (sm.timer <= 0) {
      sm.phase++;
      const next = sm.phases[sm.phase];

      if (!next) f.scriptedMove = null;
      else sm.timer = next.frames;
    }
  }
}

function startCounter(f, game) {
  const meta = counterMeta(f);

  if (f.counterCooldown > 0) return;
  if (f.attack) return;
  if (f.hurtTimer > 8 || f.guardBrokenTimer > 0) return;
  if (f.stamina < meta.stamina * 0.7) return;

  f.counterTimer = meta.duration;
  f.counterDuration = meta.duration;
  f.counterCooldown = meta.cooldown;
  f.counterUsed = false;
  f.armorTimer = Math.max(f.armorTimer, meta.armor);
  f.stamina = Math.max(0, f.stamina - meta.stamina);
  f.staminaRegenDelay = 36;

  const piece = effectivePiece(f);
  const dir = f.facing || 1;

  if (piece === "bishop") {
    f.vx += dir * 3.2;
    f.vy = Math.min(f.vy, -5.5);
    f.grounded = false;
  }

  if (piece === "knight") {
    f.vx -= dir * 5.2;
    f.vy = Math.min(f.vy, -6.8);
    f.grounded = false;
  }

  if (piece === "rook") {
    f.vx *= 0.1;
  }

  if (piece === "pawn") {
    f.vx += dir * 2.7;
  }

  if (piece === "queen") {
    f.vx += dir * 3.8;
    f.vy = Math.min(f.vy, -3.8);
  }

  pushEffect(game, "counterStart", f.x + f.width / 2, f.y + f.height / 2, {
    timer: 24,
    piece,
    dir,
    name: meta.name
  });
}

function startAttack(f, baseType, input, game) {
  if (f.attack) return;
  if (f.counterTimer > 0) return;
  if (f.guardBrokenTimer > 0 || f.hurtTimer > 8) return;

  const attack = moveKey(baseType, f);
  const aim = baseType === "special" ? getSpecialAim(input) : "forward";
  const meta = getMoveMeta(f, attack, aim);

  if (baseType === "light" && f.lightCooldown > 0) return;
  if (baseType === "heavy" && f.heavyCooldown > 0) return;
  if (baseType === "special" && f.specialCooldown > 0) return;

  if (f.stamina < meta.stamina * 0.6) return;

  f.stamina = Math.max(0, f.stamina - meta.stamina);
  f.staminaRegenDelay = baseType === "special" ? 48 : baseType === "heavy" ? 24 : 12;

  f.attack = attack;
  f.attackAim = aim;
  f.attackFacing = f.facing || 1;
  f.attackTimer = meta.duration;
  f.attackDuration = meta.duration;
  f.hitThisAttack = false;
  f.multiHitCooldown = 0;
  f.scriptedMove = null;

  if (baseType === "light") f.lightCooldown = meta.cooldown;
  if (baseType === "heavy") f.heavyCooldown = meta.cooldown;
  if (baseType === "special") f.specialCooldown = meta.cooldown;

  if (meta.armorOnStart > 0) {
    f.armorTimer = Math.max(f.armorTimer, meta.armorOnStart);
  }

  const piece = effectivePiece(f);

  if (piece === "king") {
    if (attack === "light") f.vx += f.facing * 1.3;
    if (attack === "heavy") f.vx += f.facing * 3.6;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.0;

    if (attack === "airHeavy") {
      f.vy += 4.1;
      f.vx += f.facing * 2.0;
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 4.2;

      if (aim === "up") {
        f.vy = Math.min(f.vy, -8.2);
        f.grounded = false;
      }

      if (aim === "down") f.vx += f.facing * 2.2;
    }
  }

  if (piece === "rook") {
    if (attack === "light") f.vx += f.facing * 1.4;
    if (attack === "heavy") f.vx += f.facing * 3.8;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.0;

    if (attack === "airHeavy") {
      f.vy += 5.0;
      f.vx += f.facing * 1.2;
    }

    if (attack === "special") {
      if (aim === "forward") {
        f.vx *= 0.08;
        f.armorTimer = Math.max(f.armorTimer, 70);
      }

      if (aim === "up") {
        f.vx *= 0.08;
        f.vy = Math.min(f.vy, -2.2);
      }

      if (aim === "down") f.vx += f.facing * 6.5;
    }
  }

  if (piece === "bishop") {
    if (attack === "light") f.vx += f.facing * 1.8;

    if (attack === "heavy") {
      f.scriptedMove = fixedVectorMove(f.facing * 9.8, -8.2, 13);
      f.vx = f.facing * 9.8;
      f.vy = -8.2;
      f.grounded = false;
    }

    if (attack === "airHeavy") {
      f.scriptedMove = fixedVectorMove(f.facing * 9.6, 8.8, 13);
      f.vx = f.facing * 9.6;
      f.vy = 8.8;
    }

    if (attack === "airSpecial") {
      f.scriptedMove = bishopZigzagPattern(f, input);
      f.grounded = false;
    } else if (attack === "special") {
      if (aim === "forward") {
        f.vx += f.facing * 8.6;
        f.vy = -4.6;
        f.grounded = false;
      }

      if (aim === "up") {
        f.vx += f.facing * 4.8;
        f.vy = -13.4;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 6.8;
        f.vy += 8.2;
      }
    }
  }

  if (piece === "knight") {
    if (attack === "light") f.vx += f.facing * 1.6;

    if (attack === "heavy") {
      f.vx += f.facing * 1.5;
      f.vy = Math.min(f.vy, -11.0);
      f.grounded = false;
    }

    if (attack === "crouchHeavy") {
      f.vx -= f.facing * 2.0;
      f.vy = Math.min(f.vy, -6.2);
      f.grounded = false;
    }

    if (attack === "airHeavy") {
      f.scriptedMove = chooseKnightLPattern(f, input);
      f.grounded = false;
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        f.vx += f.facing * 10.6;
        f.vy = -12.4;
        f.grounded = false;
      }

      if (aim === "up") {
        f.vx -= f.facing * 3.6;
        f.vy = -18.2;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 11.2;
        f.vy += 11.0;
      }
    }
  }

  if (piece === "pawn") {
    if (attack === "light") f.vx += f.facing * 1.4;
    if (attack === "heavy") f.vx += f.facing * 2.6;

    if (attack === "crouchHeavy") {
      f.vx += f.facing * 3.2;
      f.vy = Math.min(f.vy, -4.8);
      f.grounded = false;
    }

    if (attack === "airHeavy") f.vx += f.facing * 2.0;

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 7.0;

      if (aim === "up") {
        f.vx += f.facing * 1.7;
        f.vy = -11.2;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 5.0;
        f.vy = Math.min(f.vy, -2.2);
      }

      chargePawn(f, 3.5);
    }
  }

  if (piece === "queen") {
    if (attack === "light") f.vx += f.facing * 2.1;
    if (attack === "heavy") f.vx += f.facing * 4.1;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.0;
    if (attack === "airHeavy") f.vx += f.facing * 2.6;

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 6.8;

      if (aim === "up") {
        f.vy = -13.2;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 8.6;
        f.vy += 6.6;
      }
    }
  }

  pushEffect(game, "moveStart", f.x + f.width / 2, f.y + f.height / 2, {
    timer: 12,
    piece: effectivePiece(f),
    attack,
    aim,
    dir: f.attackFacing
  });
}

function updateFighter(f, opponent, input, game) {
  if (f.lightCooldown > 0) f.lightCooldown--;
  if (f.heavyCooldown > 0) f.heavyCooldown--;
  if (f.specialCooldown > 0) f.specialCooldown--;
  if (f.counterCooldown > 0) f.counterCooldown--;

  if (f.counterTimer > 0) f.counterTimer--;
  if (f.counterTimer <= 0) f.counterUsed = false;

  if (f.hurtTimer > 0) f.hurtTimer--;
  if (f.armorTimer > 0) f.armorTimer--;
  if (f.invulnTimer > 0) f.invulnTimer--;
  if (f.guardBrokenTimer > 0) f.guardBrokenTimer--;
  if (f.dashTimer > 0) f.dashTimer--;
  if (f.dashCooldown > 0) f.dashCooldown--;
  if (f.staminaRegenDelay > 0) f.staminaRegenDelay--;
  if (f.multiHitCooldown > 0) f.multiHitCooldown--;
  if (f.wallJumpLock > 0) f.wallJumpLock--;
  if (f.comboTimer > 0) f.comboTimer--;
  else f.comboCount = 0;

  if (f.promoted && f.characterKey === "pawn") {
    f.queenTimer--;

    if (f.queenTimer <= 0) {
      revertQueen(f);
      pushEffect(game, "queenEnd", f.x + f.width / 2, f.y + f.height / 2, { timer: 34 });
    }
  }

  if (f.characterKey === "pawn" && !f.promoted) {
    chargePawn(f, f.hp < f.maxHp * 0.3 ? 0.018 : 0.008);
  }

  const jumpPressed = !!input.jump && !f.jumpWasDown;
  const counterPressed = !!input.counter && !f.counterWasDown;

  if (jumpPressed) f.jumpBuffer = 8;
  else if (f.jumpBuffer > 0) f.jumpBuffer--;

  if (f.grounded) {
    f.coyoteTimer = 8;
    f.airDodged = false;
  } else if (f.coyoteTimer > 0) {
    f.coyoteTimer--;
  }

  updateWallState(f);
  tryWallJump(f, jumpPressed);

  const stunned = f.hurtTimer > 8 || f.guardBrokenTimer > 0;

  const oldHeight = f.height;
  f.crouching = !!input.crouch && f.grounded && !f.attack && !stunned && f.counterTimer <= 0;
  f.height = f.crouching ? f.crouchHeight : f.standingHeight;
  f.y += oldHeight - f.height;

  if (counterPressed) {
    startCounter(f, game);
  }

  const groundDash =
    input.counter &&
    f.grounded &&
    !counterPressed &&
    !f.attack &&
    f.counterTimer <= 0 &&
    f.dashCooldown <= 0 &&
    f.stamina >= 15 &&
    input.left !== input.right &&
    !f.crouching &&
    !stunned;

  if (groundDash) {
    const dir = input.left ? -1 : 1;
    f.vx = dir * f.speed * 2.0;
    f.facing = dir;
    f.attackFacing = dir;
    f.dashTimer = 10;
    f.dashCooldown = 30;
    f.invulnTimer = 4;
    f.stamina -= 15;
    f.staminaRegenDelay = 28;
    pushEffect(game, "dash", f.x + f.width / 2, f.y + f.height * 0.85, { timer: 14, dir });
  }

  const airDodge =
    input.counter &&
    !counterPressed &&
    !f.grounded &&
    !f.airDodged &&
    f.counterTimer <= 0 &&
    f.stamina >= 20 &&
    !stunned;

  if (airDodge) {
    const dir = input.left && !input.right ? -1 : input.right && !input.left ? 1 : f.facing;
    f.vx = dir * f.speed * 1.85;
    f.vy *= 0.18;
    f.dashTimer = 12;
    f.invulnTimer = 8;
    f.airDodged = true;
    f.stamina -= 20;
    f.staminaRegenDelay = 34;
    pushEffect(game, "airDodge", f.x + f.width / 2, f.y + f.height * 0.5, { timer: 16, dir });
  }

  const piece = effectivePiece(f);
  const airControl =
    piece === "bishop" ? 1.18 :
    piece === "knight" ? 1.22 :
    piece === "queen" ? 1.12 :
    1.0;

  if (!f.attack && !stunned && f.counterTimer <= 0) {
    if (input.left && !input.right) {
      f.vx = f.crouching
        ? -f.speed * 0.38
        : f.grounded
          ? -f.speed
          : Math.max(f.vx - f.speed * 0.16 * airControl, -f.speed * airControl);
    } else if (input.right && !input.left) {
      f.vx = f.crouching
        ? f.speed * 0.38
        : f.grounded
          ? f.speed
          : Math.min(f.vx + f.speed * 0.16 * airControl, f.speed * airControl);
    } else {
      f.vx *= f.grounded ? 0.72 : 0.96;
    }
  } else if (!f.dashTimer) {
    f.vx *= f.grounded ? 0.86 : 0.97;
  }

  if (f.jumpBuffer > 0 && f.coyoteTimer > 0 && !f.attack && !f.crouching && !stunned && f.counterTimer <= 0) {
    f.vy = -f.jump;
    f.grounded = false;
    f.jumpBuffer = 0;
    f.coyoteTimer = 0;
  }

  if (!f.grounded && input.crouch && f.vy > -2 && !f.attack && f.counterTimer <= 0) {
    f.vy += 0.55;
  }

  if (!stunned && f.counterTimer <= 0) {
    if (input.light) startAttack(f, "light", input, game);
    if (input.heavy) startAttack(f, "heavy", input, game);
    if (input.special) startAttack(f, "special", input, game);
  }

  applyScriptedMovement(f);

  f.x += f.vx;
  f.y += f.vy;
  f.vy += GRAVITY;

  if (f.y + f.height >= FLOOR_Y) {
    f.y = FLOOR_Y - f.height;
    f.vy = 0;
    f.grounded = true;

    if (f.scriptedMove && f.scriptedMove.type === "fixedVector" && f.scriptedMove.vy > 0) {
      f.scriptedMove = null;
    }
  } else {
    f.grounded = false;
  }

  if (f.x < LEFT_WALL) f.x = LEFT_WALL;
  if (f.x + f.width > RIGHT_WALL) f.x = RIGHT_WALL - f.width;

  updateWallState(f);

  if (!f.grounded && f.wallSide && f.vy > 3.5 && !f.attack) {
    f.vy = Math.min(f.vy, piece === "rook" || piece === "king" ? 5.4 : 3.7);
  }

  if (!f.attack && f.counterTimer <= 0) {
    f.facing = f.x < opponent.x ? 1 : -1;
    f.attackFacing = f.facing;
  }

  if (f.attack) {
    f.attackTimer--;

    if (f.attackTimer <= 0) {
      f.attack = null;
      f.attackAim = "forward";
      f.attackFacing = f.facing;
      f.hitThisAttack = false;
      f.multiHitCooldown = 0;
      f.scriptedMove = null;
    }
  }

  if (f.wallBounceWindow > 0) {
    f.wallBounceWindow--;

    const hitLeft = f.x <= LEFT_WALL + 1;
    const hitRight = f.x + f.width >= RIGHT_WALL - 1;

    if ((hitLeft || hitRight) && Math.abs(f.vx) > 4.2) {
      const side = hitLeft ? -1 : 1;

      f.x = hitLeft ? LEFT_WALL : RIGHT_WALL - f.width;
      f.vx = -side * Math.max(7, Math.abs(f.vx) * 0.52);
      f.vy = Math.min(f.vy, -7);

      const wallDmg = Math.ceil(f.wallBouncePower * WALL_BOUNCE_DAMAGE_MULT);
      f.hp = Math.max(0, f.hp - wallDmg);
      f.hurtTimer = Math.max(f.hurtTimer, 18);

      pushEffect(game, "wallBounce", f.x + f.width / 2, f.y + f.height / 2, { timer: 18 });
      f.wallBounceWindow = 0;
    }
  }

  f.jumpWasDown = !!input.jump;
  f.counterWasDown = !!input.counter;
}

function applyCounter(counterUser, attacker, game) {
  const meta = counterMeta(counterUser);
  const piece = effectivePiece(counterUser);
  const dir = counterUser.facing || (counterUser.x < attacker.x ? 1 : -1);

  counterUser.counterUsed = true;
  counterUser.counterTimer = Math.max(counterUser.counterTimer, 12);
  counterUser.invulnTimer = 14;
  counterUser.hurtTimer = 0;

  attacker.attack = null;
  attacker.scriptedMove = null;
  attacker.hurtTimer = 28;
  attacker.guardBrokenTimer = Math.max(attacker.guardBrokenTimer, 10);

  attacker.hp = Math.max(0, attacker.hp - meta.damage);
  attacker.vx = dir * meta.kb * GLOBAL_KNOCKBACK_MULT;
  attacker.vy = meta.lift * GLOBAL_LIFT_MULT;
  attacker.wallBounceWindow = 46;
  attacker.wallBouncePower = meta.wallBounce;
  attacker.lastHitBy = counterUser.side;
  attacker.comboCount += 1;
  attacker.comboTimer = 90;

  if (piece === "bishop") {
    counterUser.x += dir * 38;
    counterUser.vx = dir * 7;
    counterUser.vy = -7;
  }

  if (piece === "knight") {
    counterUser.x -= dir * 32;
    counterUser.vx = -dir * 4;
    counterUser.vy = -8;
  }

  if (piece === "rook") {
    counterUser.vx = -dir * 2;
    attacker.vx *= 1.22;
  }

  if (piece === "pawn") {
    counterUser.vx = dir * 4;
  }

  if (piece === "queen") {
    counterUser.vx = dir * 6;
    counterUser.vy = -5;
  }

  game.hitstop = Math.max(game.hitstop, 10);
  game.shake = Math.max(game.shake, 12);

  pushEffect(game, "counterHit", attacker.x + attacker.width / 2, attacker.y + attacker.height / 2, {
    timer: 30,
    piece,
    dir,
    name: meta.name,
    damage: meta.damage
  });
}

function applyGrab(attacker, defender, meta, game, box) {
  const dir = attacker.attackFacing || attacker.facing || 1;

  defender.invulnTimer = 0;
  defender.hurtTimer = 36;
  defender.guardBrokenTimer = Math.max(defender.guardBrokenTimer, 18);

  defender.x = attacker.x + attacker.width / 2 + dir * 54 - defender.width / 2;
  defender.y = Math.min(defender.y, attacker.y + attacker.height * 0.1);
  defender.vx = dir * meta.throwPower * GLOBAL_KNOCKBACK_MULT;
  defender.vy = -14;
  defender.hp = Math.max(0, defender.hp - meta.damage);

  defender.wallBounceWindow = 50;
  defender.wallBouncePower = meta.wallBounce;
  defender.lastHitBy = attacker.side;
  defender.comboCount += 1;
  defender.comboTimer = 100;

  game.hitstop = Math.max(game.hitstop, 12);
  game.shake = Math.max(game.shake, 13);

  pushEffect(game, "grab", defender.x + defender.width / 2, defender.y + defender.height / 2, {
    timer: 22,
    damage: meta.damage,
    dir,
    piece: effectivePiece(attacker)
  });

  pushEffect(game, "hit", box.x + box.width / 2, box.y + box.height / 2, {
    timer: 18,
    damage: meta.damage,
    attack: attacker.attack,
    piece: effectivePiece(attacker),
    dir
  });

  attacker.hitThisAttack = true;
}

function handleCounterCollision(f, opponent, game) {
  if (!currentCounterActive(f)) return;

  const box = counterBox(f);
  if (!rectsOverlap(box, opponent)) return;

  applyCounter(f, opponent, game);
}

function handleHit(attacker, defender, game) {
  if (!attacker.attack) return;

  const meta = getMoveMeta(attacker);

  if (!currentMoveActive(attacker)) return;
  if (defender.invulnTimer > 0) return;

  if (meta.continuous) {
    if (attacker.multiHitCooldown > 0) return;
  } else if (attacker.hitThisAttack) {
    return;
  }

  const box = attackBox(attacker);
  if (!rectsOverlap(box, defender)) return;

  if (currentCounterActive(defender)) {
    applyCounter(defender, attacker, game);
    return;
  }

  if (meta.grab) {
    applyGrab(attacker, defender, meta, game, box);
    return;
  }

  let damage = meta.damage;
  let kb = meta.kb * GLOBAL_KNOCKBACK_MULT;
  let lift = meta.lift * GLOBAL_LIFT_MULT;

  const comboScale = clamp(1 - defender.comboCount * 0.07, 0.58, 1);
  damage = Math.ceil(damage * comboScale);
  kb *= clamp(1 - defender.comboCount * 0.04, 0.7, 1);

  const defenderArmored = defender.armorTimer > 0 && !meta.armorBreak;

  if (meta.continuous) {
    damage = Math.max(2, Math.ceil(damage * 0.5));
    kb *= 0.55;
  }

  if (defenderArmored) {
    damage = Math.ceil(damage * 0.48);
    kb *= 0.38;
    pushEffect(game, "armor", defender.x + defender.width / 2, defender.y + defender.height * 0.45, { timer: 10 });
  } else {
    defender.hurtTimer = meta.continuous ? 8 : 20;
  }

  defender.hp = Math.max(0, defender.hp - damage);
  defender.vx += attacker.attackFacing * kb;
  defender.vy += lift;
  defender.lastHitBy = attacker.side;
  defender.comboCount += 1;
  defender.comboTimer = 90;

  defender.wallBounceWindow = 42;
  defender.wallBouncePower = meta.wallBounce;

  if (attacker.characterKey === "pawn" && !attacker.promoted) {
    chargePawn(attacker, 4.5 + damage * 0.28);
  }

  if (defender.characterKey === "pawn" && !defender.promoted) {
    chargePawn(defender, 1.8 + damage * 0.08);
  }

  game.hitstop = Math.max(game.hitstop, meta.continuous ? 3 : meta.damage >= 13 ? 9 : meta.damage >= 9 ? 7 : 5);
  game.shake = Math.max(game.shake, meta.damage >= 13 ? 10 : meta.damage >= 9 ? 7 : 4);

  pushEffect(
    game,
    "hit",
    clamp(box.x + box.width / 2, defender.x, defender.x + defender.width),
    clamp(box.y + box.height / 2, defender.y, defender.y + defender.height),
    {
      timer: meta.continuous ? 8 : 18,
      damage,
      attack: attacker.attack,
      piece: effectivePiece(attacker),
      dir: attacker.attackFacing
    }
  );

  if (meta.continuous) attacker.multiHitCooldown = meta.hitInterval;
  else attacker.hitThisAttack = true;
}

function determineRoundWinner(white, black, game) {
  if (white.hp <= 0 && black.hp <= 0) {
    if (white.hp === black.hp) return null;
    return white.hp > black.hp ? "white" : "black";
  }

  if (white.hp <= 0) return "black";
  if (black.hp <= 0) return "white";

  if (game.roundTime <= 0) {
    if (white.hp === black.hp) return null;
    return white.hp > black.hp ? "white" : "black";
  }

  return null;
}

function updateGame(lobby) {
  if (!lobby || !lobby.game || lobby.status !== "playing") return;

  const game = lobby.game;
  const white = game.fighters.white;
  const black = game.fighters.black;

  game.tick++;

  if (game.shake > 0) game.shake--;
  decayEffects(game);

  if (game.roundOver) {
    game.roundOverTimer--;

    if (game.roundOverTimer <= 0) {
      if (lobby.match.matchWinner) {
        finishMatch(lobby);
        sendGameState(lobby);
        sendLobbyData();
      } else {
        lobby.match.currentRound += 1;
        startRound(lobby);
        sendGameState(lobby);
        sendLobbyData();
      }
    }

    return;
  }

  if (game.hitstop > 0) {
    game.hitstop--;
    return;
  }

  game.roundTime = Math.max(0, game.roundTime - 1);

  const whiteInput = players[white.id]?.input || {};
  const blackInput = players[black.id]?.input || {};

  updateFighter(white, black, whiteInput, game);
  updateFighter(black, white, blackInput, game);

  handleCounterCollision(white, black, game);
  handleCounterCollision(black, white, game);

  handleHit(white, black, game);
  handleHit(black, white, game);

  const winnerSide = determineRoundWinner(white, black, game);

  if (winnerSide) {
    game.roundOver = true;
    game.roundWinner = winnerSide;

    if (winnerSide === "white") lobby.match.whiteRounds++;
    else lobby.match.blackRounds++;

    const winner = game.fighters[winnerSide];

    pushEffect(game, "roundWin", winner.x + winner.width / 2, winner.y + winner.height / 2, {
      timer: 80,
      side: winnerSide
    });

    if (
      lobby.match.whiteRounds >= lobby.match.roundsToWin ||
      lobby.match.blackRounds >= lobby.match.roundsToWin
    ) {
      lobby.match.matchWinner = winnerSide;
      lobby.winner = winner.name;
      leaderboard[winner.name] = (leaderboard[winner.name] || 0) + 1;
      lobby.message = `${winner.name} wins the match ${lobby.match.whiteRounds}-${lobby.match.blackRounds}.`;
      game.roundOverTimer = 220;
    } else {
      lobby.message = `${winner.name} wins round ${lobby.match.currentRound}.`;
      game.roundOverTimer = 150;
    }
  }
}

setInterval(() => {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.status === "playing" && lobby.game) {
      updateGame(lobby);
      sendGameState(lobby);
    }
  }
}, 1000 / TICK_RATE);

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    name: `Player ${Object.keys(players).length + 1}`,
    characterKey: "king",
    lobbyId: null,
    role: "menu",
    input: {}
  };

  socket.emit("welcome", {
    id: socket.id,
    characters: CHARACTERS
  });

  sendLobbyData();

  socket.on("setName", (name) => {
    players[socket.id].name = cleanName(name);

    if (!leaderboard[players[socket.id].name]) {
      leaderboard[players[socket.id].name] = 0;
    }

    sendLobbyData();
  });

  socket.on("setCharacter", (key) => {
    if (!CHARACTERS[key]) return;
    players[socket.id].characterKey = key;
    sendLobbyData();
  });

  socket.on("createLobby", (lobbyName) => {
    if (Object.keys(lobbies).length >= MAX_LOBBIES) {
      socket.emit("serverMessage", "Too many open boards right now.");
      return;
    }

    leaveCurrentLobby(socket.id);

    const id = makeId();

    lobbies[id] = {
      id,
      name: String(lobbyName || `${players[socket.id].name}'s Board`).trim().slice(0, 28),
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

    joinSocketRoom(socket, id);
    socket.emit("enteredLobby", { lobbyId: id, role: "white" });

    sendGameState(lobbies[id]);
    sendLobbyData();
  });

  socket.on("joinLobby", (lobbyId) => {
    const lobby = lobbies[lobbyId];

    if (!lobby || lobby.status !== "waiting" || lobby.blackId) return;

    leaveCurrentLobby(socket.id);

    lobby.blackId = socket.id;
    players[socket.id].lobbyId = lobbyId;
    players[socket.id].role = "black";

    joinSocketRoom(socket, lobbyId);
    socket.emit("enteredLobby", { lobbyId, role: "black" });

    initMatch(lobby);
    startRound(lobby);

    sendGameState(lobby);
    sendLobbyData();
  });

  socket.on("watchLobby", (lobbyId) => {
    const lobby = lobbies[lobbyId];

    if (!lobby) return;

    leaveCurrentLobby(socket.id);

    lobby.spectators.add(socket.id);
    players[socket.id].lobbyId = lobbyId;
    players[socket.id].role = "spectator";

    joinSocketRoom(socket, lobbyId);
    socket.emit("enteredLobby", { lobbyId, role: "spectator" });

    sendGameState(lobby);
    sendLobbyData();
  });

  socket.on("leaveLobby", () => {
    leaveCurrentLobby(socket.id);
    socket.emit("leftLobby");
    sendLobbyData();
  });

  socket.on("input", (input) => {
    const p = players[socket.id];

    if (!p || !input || typeof input !== "object") return;

    p.input = {
      left: !!input.left,
      right: !!input.right,
      jump: !!input.jump,
      crouch: !!input.crouch,
      counter: !!input.counter,
      light: !!input.light,
      heavy: !!input.heavy,
      special: !!input.special
    };
  });

  socket.on("disconnect", () => {
    leaveCurrentLobby(socket.id);
    delete players[socket.id];
    sendLobbyData();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});