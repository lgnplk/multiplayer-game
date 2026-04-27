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

const PROMOTION_MAX = 100;
const QUEEN_DURATION = 12 * 60;

const MAX_EFFECTS = 120;
const MAX_LOBBIES = 80;

const players = {};
const lobbies = {};
const leaderboard = {};
let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Royal control. Stable, armored, explosive authority.",
    maxHp: 625,
    speed: 4.2,
    jump: 13.4,
    width: 72,
    height: 124
  },
  rook: {
    name: "Rook",
    title: "Fortress piece. Brutal range, beam pressure, heavy body.",
    maxHp: 730,
    speed: 3.1,
    jump: 11.1,
    width: 82,
    height: 130
  },
  bishop: {
    name: "Bishop",
    title: "Diagonal menace. Rift movement and slashing angles.",
    maxHp: 540,
    speed: 4.75,
    jump: 14.8,
    width: 64,
    height: 122
  },
  knight: {
    name: "Knight",
    title: "Chaotic jumper. L-shaped burst offense and air pressure.",
    maxHp: 535,
    speed: 4.55,
    jump: 17.2,
    width: 66,
    height: 116
  },
  pawn: {
    name: "Pawn",
    title: "Underdog lancer. Charges in bravely, then promotes.",
    maxHp: 545,
    speed: 4.65,
    jump: 13.8,
    width: 58,
    height: 108
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
    speed: ch.speed * 1.28,
    jump: ch.jump * 1.1,

    facing: side === "white" ? 1 : -1,
    grounded: true,
    crouching: false,
    blocking: false,

    attack: null,
    attackTimer: 0,
    attackDuration: 0,
    attackAim: "forward",
    hitThisAttack: false,
    multiHitCooldown: 0,

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
    parryTimer: 0,

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

    jumpWasDown: false,
    blockWasDown: false
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
  let type = baseType;
  if (!f.grounded) {
    if (baseType === "light") type = "airLight";
    if (baseType === "heavy") type = "airHeavy";
    if (baseType === "special") type = "airSpecial";
  } else if (f.crouching) {
    if (baseType === "light") type = "crouchLight";
    if (baseType === "heavy") type = "crouchHeavy";
  }
  return type;
}

function getMoveMeta(f, attack = f.attack, aim = f.attackAim || "forward") {
  const piece = effectivePiece(f);
  const base = {
    duration: 20,
    activeStart: 5,
    activeEnd: 12,
    damage: 6,
    kb: 8,
    lift: -4,
    range: 60,
    width: 80,
    height: 40,
    cooldown: 20,
    stamina: 4,
    armorBreak: false,
    continuous: false,
    hitInterval: 8,
    wallBounce: 8,
    blockDrain: 16,
    armorOnStart: 0
  };

  const m = { ...base };

  if (piece === "king") {
    if (attack === "light") Object.assign(m, { duration: 16, activeStart: 4, activeEnd: 10, damage: 7, kb: 8, lift: -3, width: 80, height: 42, cooldown: 16, stamina: 4 });
    if (attack === "heavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 16, damage: 14, kb: 15, lift: -8, width: 118, height: 70, cooldown: 40, stamina: 10, wallBounce: 14, armorOnStart: 14 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 44, activeStart: 10, activeEnd: 25, damage: 13, kb: 18, lift: -6, width: 170, height: 120, cooldown: 92, stamina: 18, armorBreak: true, wallBounce: 18, armorOnStart: 24 });
      if (aim === "up") Object.assign(m, { duration: 40, activeStart: 10, activeEnd: 18, damage: 12, kb: 12, lift: -16, width: 100, height: 200, cooldown: 92, stamina: 18, wallBounce: 12, armorOnStart: 18 });
      if (aim === "down") Object.assign(m, { duration: 42, activeStart: 12, activeEnd: 18, damage: 16, kb: 17, lift: -4, width: 155, height: 70, cooldown: 92, stamina: 18, armorBreak: true, wallBounce: 16, armorOnStart: 24 });
    }
    if (attack === "crouchHeavy") Object.assign(m, { duration: 30, activeStart: 9, activeEnd: 16, damage: 13, kb: 15, lift: -9, width: 110, height: 46, cooldown: 42, stamina: 9, wallBounce: 13 });
    if (attack === "airHeavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 16, damage: 13, kb: 13, lift: 7, width: 110, height: 90, cooldown: 42, stamina: 9, wallBounce: 13 });
  }

  if (piece === "rook") {
    if (attack === "light") Object.assign(m, { duration: 18, activeStart: 5, activeEnd: 12, damage: 7, kb: 10, lift: -2, width: 120, height: 38, cooldown: 18, stamina: 4, wallBounce: 10 });
    if (attack === "heavy") Object.assign(m, { duration: 30, activeStart: 9, activeEnd: 18, damage: 15, kb: 18, lift: -5, width: 165, height: 72, cooldown: 48, stamina: 10, armorBreak: true, wallBounce: 18, armorOnStart: 18 });
    if (attack === "special") {
      if (aim === "forward") Object.assign(m, { duration: 72, activeStart: 10, activeEnd: 62, damage: 5, kb: 8, lift: -1, width: 440, height: 64, cooldown: 108, stamina: 22, continuous: true, hitInterval: 9, armorBreak: true, wallBounce: 12, blockDrain: 8, armorOnStart: 50 });
      if (aim === "up") Object.assign(m, { duration: 68, activeStart: 12, activeEnd: 56, damage: 5, kb: 7, lift: -12, width: 82, height: 290, cooldown: 108, stamina: 22, continuous: true, hitInterval: 9, wallBounce: 10, blockDrain: 8, armorOnStart: 48 });
      if (aim === "down") Object.assign(m, { duration: 68, activeStart: 12, activeEnd: 56, damage: 6, kb: 9, lift: -2, width: 260, height: 44, cooldown: 108, stamina: 22, continuous: true, hitInterval: 8, armorBreak: true, wallBounce: 14, blockDrain: 10, armorOnStart: 48 });
    }
    if (attack === "crouchHeavy") Object.assign(m, { duration: 32, activeStart: 10, activeEnd: 18, damage: 14, kb: 17, lift: -8, width: 145, height: 42, cooldown: 52, stamina: 10, wallBounce: 16 });
    if (attack === "airHeavy") Object.assign(m, { duration: 30, activeStart: 8, activeEnd: 17, damage: 14, kb: 14, lift: 8, width: 100, height: 84, cooldown: 52, stamina: 10, wallBounce: 15 });
  }

  if (piece === "bishop") {
    if (attack === "light") Object.assign(m, { duration: 18, activeStart: 4, activeEnd: 10, damage: 6, kb: 9, lift: -5, width: 115, height: 66, cooldown: 18, stamina: 4 });
    if (attack === "heavy") Object.assign(m, { duration: 26, activeStart: 8, activeEnd: 15, damage: 12, kb: 13, lift: -8, width: 150, height: 94, cooldown: 36, stamina: 9, wallBounce: 12 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 42, activeStart: 8, activeEnd: 18, damage: 12, kb: 14, lift: -6, width: 190, height: 120, cooldown: 88, stamina: 18, wallBounce: 13 });
      if (aim === "up") Object.assign(m, { duration: 40, activeStart: 8, activeEnd: 16, damage: 11, kb: 12, lift: -18, width: 170, height: 150, cooldown: 88, stamina: 18, wallBounce: 11 });
      if (aim === "down") Object.assign(m, { duration: 40, activeStart: 9, activeEnd: 16, damage: 13, kb: 15, lift: 7, width: 170, height: 150, cooldown: 88, stamina: 18, armorBreak: true, wallBounce: 15 });
    }
    if (attack === "crouchLight") Object.assign(m, { duration: 16, activeStart: 4, activeEnd: 10, damage: 5, kb: 7, lift: -2, width: 110, height: 32, cooldown: 16, stamina: 3 });
    if (attack === "airHeavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 16, damage: 12, kb: 13, lift: 6, width: 110, height: 96, cooldown: 38, stamina: 9 });
  }

  if (piece === "knight") {
    if (attack === "light") Object.assign(m, { duration: 14, activeStart: 4, activeEnd: 8, damage: 6, kb: 7, lift: -3, width: 56, height: 44, cooldown: 14, stamina: 3 });
    if (attack === "heavy") Object.assign(m, { duration: 26, activeStart: 8, activeEnd: 14, damage: 11, kb: 12, lift: -12, width: 76, height: 78, cooldown: 34, stamina: 8, wallBounce: 11 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 36, activeStart: 7, activeEnd: 16, damage: 13, kb: 14, lift: -12, width: 95, height: 88, cooldown: 72, stamina: 16, wallBounce: 15 });
      if (aim === "up") Object.assign(m, { duration: 36, activeStart: 7, activeEnd: 16, damage: 12, kb: 11, lift: -18, width: 90, height: 120, cooldown: 72, stamina: 16, wallBounce: 11 });
      if (aim === "down") Object.assign(m, { duration: 34, activeStart: 7, activeEnd: 15, damage: 14, kb: 16, lift: 10, width: 110, height: 86, cooldown: 72, stamina: 16, armorBreak: true, wallBounce: 16 });
    }
    if (attack === "crouchHeavy") Object.assign(m, { duration: 24, activeStart: 7, activeEnd: 13, damage: 10, kb: 13, lift: -10, width: 74, height: 58, cooldown: 32, stamina: 8 });
    if (attack === "airHeavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 15, damage: 12, kb: 14, lift: 9, width: 86, height: 94, cooldown: 36, stamina: 8 });
  }

  if (piece === "pawn") {
    if (attack === "light") Object.assign(m, { duration: 15, activeStart: 4, activeEnd: 8, damage: 6, kb: 8, lift: -2, width: 82, height: 26, cooldown: 15, stamina: 3 });
    if (attack === "heavy") Object.assign(m, { duration: 24, activeStart: 7, activeEnd: 14, damage: 10, kb: 12, lift: -5, width: 110, height: 52, cooldown: 30, stamina: 8 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 30, activeStart: 6, activeEnd: 14, damage: 11, kb: 14, lift: -4, width: 126, height: 42, cooldown: 64, stamina: 14, wallBounce: 12 });
      if (aim === "up") Object.assign(m, { duration: 32, activeStart: 8, activeEnd: 15, damage: 10, kb: 10, lift: -15, width: 72, height: 120, cooldown: 64, stamina: 14, wallBounce: 10 });
      if (aim === "down") Object.assign(m, { duration: 30, activeStart: 8, activeEnd: 14, damage: 12, kb: 15, lift: -1, width: 110, height: 46, cooldown: 64, stamina: 14, armorBreak: true, wallBounce: 14 });
    }
    if (attack === "crouchLight") Object.assign(m, { duration: 15, activeStart: 4, activeEnd: 8, damage: 5, kb: 7, lift: -1, width: 82, height: 22, cooldown: 15, stamina: 3 });
    if (attack === "crouchHeavy") Object.assign(m, { duration: 24, activeStart: 8, activeEnd: 14, damage: 11, kb: 14, lift: -10, width: 95, height: 48, cooldown: 34, stamina: 8, wallBounce: 12 });
    if (attack === "airHeavy") Object.assign(m, { duration: 24, activeStart: 8, activeEnd: 14, damage: 11, kb: 12, lift: 9, width: 88, height: 74, cooldown: 32, stamina: 8, wallBounce: 12 });
  }

  if (piece === "queen") {
    if (attack === "light") Object.assign(m, { duration: 16, activeStart: 4, activeEnd: 10, damage: 9, kb: 10, lift: -4, width: 136, height: 70, cooldown: 14, stamina: 3, wallBounce: 12 });
    if (attack === "heavy") Object.assign(m, { duration: 28, activeStart: 7, activeEnd: 16, damage: 16, kb: 17, lift: -8, width: 190, height: 110, cooldown: 36, stamina: 8, armorBreak: true, wallBounce: 18, armorOnStart: 10 });
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") Object.assign(m, { duration: 52, activeStart: 10, activeEnd: 26, damage: 18, kb: 20, lift: -7, width: 290, height: 150, cooldown: 92, stamina: 18, armorBreak: true, wallBounce: 22, armorOnStart: 22 });
      if (aim === "up") Object.assign(m, { duration: 50, activeStart: 10, activeEnd: 22, damage: 16, kb: 14, lift: -22, width: 150, height: 250, cooldown: 92, stamina: 18, armorBreak: true, wallBounce: 16, armorOnStart: 22 });
      if (aim === "down") Object.assign(m, { duration: 50, activeStart: 10, activeEnd: 22, damage: 17, kb: 18, lift: 8, width: 250, height: 90, cooldown: 92, stamina: 18, armorBreak: true, wallBounce: 20, armorOnStart: 22 });
    }
    if (attack === "crouchHeavy") Object.assign(m, { duration: 30, activeStart: 8, activeEnd: 16, damage: 15, kb: 16, lift: -11, width: 150, height: 54, cooldown: 38, stamina: 8, wallBounce: 16 });
    if (attack === "airHeavy") Object.assign(m, { duration: 28, activeStart: 8, activeEnd: 15, damage: 15, kb: 15, lift: 10, width: 130, height: 110, cooldown: 38, stamina: 8, wallBounce: 16 });
  }

  return m;
}

function forwardBox(f, width, height, yOffset = 0, gap = 0) {
  const x = f.facing === 1 ? f.x + f.width + gap : f.x - width - gap;
  return { x, y: f.y + yOffset, width, height };
}

function centeredBox(f, width, height, yOffset = 0) {
  return { x: f.x + f.width / 2 - width / 2, y: f.y + yOffset, width, height };
}

function upBox(f, width, height, xOffset = 0) {
  return {
    x: f.x + f.width / 2 - width / 2 + xOffset,
    y: f.y - height + 18,
    width,
    height
  };
}

function attackBox(f) {
  const meta = getMoveMeta(f);
  const piece = effectivePiece(f);
  const attack = f.attack;
  const aim = f.attackAim || "forward";

  if (piece === "king") {
    if (attack === "light") return forwardBox(f, 84, 44, 30);
    if (attack === "heavy") return forwardBox(f, 122, 72, 18);
    if (attack === "crouchHeavy") return forwardBox(f, 112, 48, f.height * 0.52);
    if (attack === "airHeavy") return centeredBox(f, 120, 95, 24);
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 110, 210);
      if (aim === "down") return centeredBox(f, 160, 76, f.height * 0.52);
      return centeredBox(f, 190, 124, -4);
    }
  }

  if (piece === "rook") {
    if (attack === "light") return forwardBox(f, 122, 42, 40);
    if (attack === "heavy") return forwardBox(f, 168, 82, 24);
    if (attack === "crouchHeavy") return forwardBox(f, 150, 44, f.height * 0.55);
    if (attack === "airHeavy") return forwardBox(f, 105, 92, 20);
    if (attack === "special") {
      if (aim === "up") return upBox(f, 86, 292);
      if (aim === "down") return forwardBox(f, 262, 48, f.height * 0.62);
      return forwardBox(f, 445, 70, 24);
    }
  }

  if (piece === "bishop") {
    if (attack === "light") return forwardBox(f, 118, 72, 16);
    if (attack === "heavy") return forwardBox(f, 150, 102, 6);
    if (attack === "crouchLight") return forwardBox(f, 112, 28, f.height * 0.65);
    if (attack === "airHeavy") return forwardBox(f, 118, 100, 12);
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 175, 155, f.facing * 34);
      if (aim === "down") return { x: f.x + f.facing * 10, y: f.y + 40, width: 175, height: 155 };
      return { x: f.facing === 1 ? f.x + 40 : f.x - 190 + f.width - 40, y: f.y - 10, width: 190, height: 130 };
    }
  }

  if (piece === "knight") {
    if (attack === "light") return forwardBox(f, 60, 46, 30);
    if (attack === "heavy") return forwardBox(f, 78, 82, -2);
    if (attack === "crouchHeavy") return forwardBox(f, 80, 60, f.height * 0.44);
    if (attack === "airHeavy") return forwardBox(f, 94, 98, 18);
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 96, 130);
      if (aim === "down") return forwardBox(f, 112, 90, f.height * 0.32);
      return forwardBox(f, 100, 92, 4);
    }
  }

  if (piece === "pawn") {
    if (attack === "light") return forwardBox(f, 88, 28, 40);
    if (attack === "heavy") return forwardBox(f, 114, 56, 26);
    if (attack === "crouchLight") return forwardBox(f, 86, 22, f.height * 0.66);
    if (attack === "crouchHeavy") return forwardBox(f, 98, 52, f.height * 0.46);
    if (attack === "airHeavy") return forwardBox(f, 92, 78, 16);
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 78, 126);
      if (aim === "down") return forwardBox(f, 112, 50, f.height * 0.58);
      return forwardBox(f, 130, 44, 30);
    }
  }

  if (piece === "queen") {
    if (attack === "light") return forwardBox(f, 140, 74, 18);
    if (attack === "heavy") return forwardBox(f, 192, 116, -6);
    if (attack === "crouchHeavy") return forwardBox(f, 154, 56, f.height * 0.46);
    if (attack === "airHeavy") return forwardBox(f, 136, 112, 8);
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 154, 255);
      if (aim === "down") return forwardBox(f, 255, 92, f.height * 0.34);
      return centeredBox(f, 300, 160, -18);
    }
  }

  return forwardBox(f, meta.width, meta.height, 20);
}

function currentMoveActive(f) {
  if (!f.attack) return false;
  const meta = getMoveMeta(f);
  const elapsed = f.attackDuration - f.attackTimer;
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

  f.maxHp = Math.round(f.maxHp * 1.65);
  f.hp = Math.max(1, Math.ceil(f.maxHp * hpRatio));
  f.speed *= 1.18;
  f.jump *= 1.12;
  f.width += 8;
  f.standingHeight += 18;
  f.crouchHeight = Math.floor(f.standingHeight * 0.72);
  f.height = f.standingHeight;
  f.characterName = "Queen";
  f.armorTimer = 28;
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
  if (f.promotionMeter >= PROMOTION_MAX) promotePawn(f);
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

  if (piece === "knight") { jumpMul = 1.35; xMul = 1.9; }
  if (piece === "rook") { jumpMul = 0.75; xMul = 1.35; }
  if (piece === "bishop") { jumpMul = 1.1; xMul = 1.8; }
  if (piece === "queen") { jumpMul = 1.2; xMul = 1.9; }

  f.vx = -f.wallSide * f.speed * xMul;
  f.vy = -f.jump * 0.92 * jumpMul;
  f.facing = -f.wallSide;
  f.wallJumpLock = 16;
}

function startAttack(f, baseType, input, game) {
  if (f.attack) return;
  if (f.guardBrokenTimer > 0 || f.hurtTimer > 8) return;

  const attack = moveKey(baseType, f);
  const aim = baseType === "special" ? getSpecialAim(input) : "forward";
  const meta = getMoveMeta(f, attack, aim);

  if (baseType === "light" && f.lightCooldown > 0) return;
  if (baseType === "heavy" && f.heavyCooldown > 0) return;
  if (baseType === "special" && f.specialCooldown > 0) return;

  if (f.stamina < meta.stamina * 0.6) return;

  f.stamina = Math.max(0, f.stamina - meta.stamina);
  f.staminaRegenDelay = baseType === "special" ? 36 : baseType === "heavy" ? 24 : 12;

  f.attack = attack;
  f.attackAim = aim;
  f.attackTimer = meta.duration;
  f.attackDuration = meta.duration;
  f.hitThisAttack = false;
  f.multiHitCooldown = 0;

  if (baseType === "light") f.lightCooldown = meta.cooldown;
  if (baseType === "heavy") f.heavyCooldown = meta.cooldown;
  if (baseType === "special") f.specialCooldown = meta.cooldown;

  if (meta.armorOnStart > 0) f.armorTimer = Math.max(f.armorTimer, meta.armorOnStart);

  const piece = effectivePiece(f);

  if (piece === "king") {
    if (attack === "light") f.vx += f.facing * 1.2;
    if (attack === "heavy") f.vx += f.facing * 2.4;
    if (attack === "crouchHeavy") f.vx += f.facing * 2.1;
    if (attack === "airHeavy") { f.vy += 3.5; f.vx += f.facing * 1.6; }
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 1.2;
      if (aim === "up") { f.vy = Math.min(f.vy, -6); f.grounded = false; }
      if (aim === "down") { f.vx += f.facing * 1.6; }
    }
  }

  if (piece === "rook") {
    if (attack === "light") f.vx += f.facing * 0.8;
    if (attack === "heavy") f.vx += f.facing * 1.8;
    if (attack === "crouchHeavy") f.vx += f.facing * 1.2;
    if (attack === "special") {
      if (aim === "forward") f.vx *= 0.06;
      if (aim === "up") { f.vx *= 0.05; f.vy = Math.min(f.vy, -2); }
      if (aim === "down") f.vx += f.facing * 5.2;
    }
  }

  if (piece === "bishop") {
    if (attack === "light") f.vx += f.facing * 0.8;
    if (attack === "heavy") f.vx += f.facing * 1.1;
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") { f.vx += f.facing * 5.8; f.vy = -3; f.grounded = false; }
      if (aim === "up") { f.vx += f.facing * 2.8; f.vy = -10.8; f.grounded = false; }
      if (aim === "down") { f.vx += f.facing * 4.4; f.vy += 6; }
    }
  }

  if (piece === "knight") {
    if (attack === "light") f.vx += f.facing * 0.7;
    if (attack === "heavy") { f.vx += f.facing * 0.5; f.vy = Math.min(f.vy, -8.6); f.grounded = false; }
    if (attack === "crouchHeavy") { f.vx -= f.facing * 1.2; f.vy = Math.min(f.vy, -4); f.grounded = false; }
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") { f.vx += f.facing * 7.4; f.vy = -10.6; f.grounded = false; }
      if (aim === "up") { f.vx -= f.facing * 2.2; f.vy = -15; f.grounded = false; }
      if (aim === "down") { f.vx += f.facing * 8.6; f.vy += 8.4; }
    }
  }

  if (piece === "pawn") {
    if (attack === "light") f.vx += f.facing * 1;
    if (attack === "heavy") f.vx += f.facing * 1.6;
    if (attack === "crouchHeavy") { f.vx += f.facing * 2.5; f.vy = Math.min(f.vy, -4.5); f.grounded = false; }
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 6.2;
      if (aim === "up") { f.vx += f.facing * 1.8; f.vy = -11; f.grounded = false; }
      if (aim === "down") { f.vx += f.facing * 4.4; f.vy = Math.min(f.vy, -2); }
      chargePawn(f, 6);
    }
  }

  if (piece === "queen") {
    if (attack === "light") f.vx += f.facing * 1.2;
    if (attack === "heavy") f.vx += f.facing * 2.2;
    if (attack === "crouchHeavy") f.vx += f.facing * 1.5;
    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 4.2;
      if (aim === "up") { f.vy = -11.8; f.grounded = false; }
      if (aim === "down") { f.vx += f.facing * 6.8; f.vy += 5.5; }
    }
  }

  pushEffect(game, "moveStart", f.x + f.width / 2, f.y + f.height / 2, {
    timer: 10,
    piece: effectivePiece(f),
    attack,
    aim
  });
}

function updateFighter(f, opponent, input, game) {
  if (f.lightCooldown > 0) f.lightCooldown--;
  if (f.heavyCooldown > 0) f.heavyCooldown--;
  if (f.specialCooldown > 0) f.specialCooldown--;
  if (f.hurtTimer > 0) f.hurtTimer--;
  if (f.armorTimer > 0) f.armorTimer--;
  if (f.invulnTimer > 0) f.invulnTimer--;
  if (f.guardBrokenTimer > 0) f.guardBrokenTimer--;
  if (f.parryTimer > 0) f.parryTimer--;
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
      pushEffect(game, "queenEnd", f.x + f.width / 2, f.y + f.height / 2, { timer: 36 });
    }
  }

  if (f.characterKey === "pawn" && !f.promoted) {
    chargePawn(f, f.hp < f.maxHp * 0.35 ? 0.035 : 0.018);
  }

  const jumpPressed = !!input.jump && !f.jumpWasDown;
  const blockPressed = !!input.block && !f.blockWasDown;

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
  f.crouching = !!input.crouch && f.grounded && !f.attack && !stunned;
  f.height = f.crouching ? f.crouchHeight : f.standingHeight;
  f.y += oldHeight - f.height;

  if (blockPressed && f.grounded && !f.attack && !f.crouching && f.stamina >= 16 && !stunned) {
    f.parryTimer = 8;
    f.stamina = Math.max(0, f.stamina - 5);
    f.staminaRegenDelay = 16;
    pushEffect(game, "parryReady", f.x + f.width / 2, f.y + f.height * 0.5, { timer: 10 });
  }

  const canBlock = f.grounded && !f.attack && !f.crouching && !stunned && f.stamina > 0;
  f.blocking = !!input.block && canBlock;

  if (f.blocking) {
    f.stamina = Math.max(0, f.stamina - 0.38);
    f.staminaRegenDelay = 24;
    if (f.stamina <= 0) {
      f.blocking = false;
      f.guardBrokenTimer = 60;
      f.hurtTimer = Math.max(f.hurtTimer, 38);
      f.vx -= f.facing * 5;
      pushEffect(game, "guardBreak", f.x + f.width / 2, f.y + f.height * 0.45, { timer: 30 });
    }
  } else if (f.staminaRegenDelay <= 0) {
    f.stamina = Math.min(f.maxStamina, f.stamina + (f.grounded ? 0.78 : 0.42));
  }

  const groundDash =
    blockPressed &&
    f.grounded &&
    !f.attack &&
    f.dashCooldown <= 0 &&
    f.stamina >= 15 &&
    input.left !== input.right &&
    !f.crouching &&
    !stunned;

  if (groundDash) {
    const dir = input.left ? -1 : 1;
    f.vx = dir * f.speed * 2.15;
    f.facing = dir;
    f.dashTimer = 10;
    f.dashCooldown = 28;
    f.invulnTimer = 4;
    f.stamina -= 15;
    f.staminaRegenDelay = 28;
    pushEffect(game, "dash", f.x + f.width / 2, f.y + f.height * 0.85, { timer: 14, dir });
  }

  const airDodge =
    blockPressed &&
    !f.grounded &&
    !f.airDodged &&
    f.stamina >= 20 &&
    !stunned;

  if (airDodge) {
    const dir = input.left && !input.right ? -1 : input.right && !input.left ? 1 : f.facing;
    f.vx = dir * f.speed * 2;
    f.vy *= 0.18;
    f.dashTimer = 12;
    f.invulnTimer = 8;
    f.airDodged = true;
    f.stamina -= 20;
    f.staminaRegenDelay = 34;
    pushEffect(game, "airDodge", f.x + f.width / 2, f.y + f.height * 0.5, { timer: 16, dir });
  }

  if (!f.attack && !stunned && !f.blocking) {
    if (input.left && !input.right) {
      f.vx = f.crouching ? -f.speed * 0.38 : -f.speed;
    } else if (input.right && !input.left) {
      f.vx = f.crouching ? f.speed * 0.38 : f.speed;
    } else {
      f.vx *= f.grounded ? 0.72 : 0.95;
    }
  } else if (!f.dashTimer) {
    f.vx *= f.grounded ? 0.84 : 0.96;
  }

  if (f.jumpBuffer > 0 && f.coyoteTimer > 0 && !f.blocking && !f.attack && !f.crouching && !stunned) {
    f.vy = -f.jump;
    f.grounded = false;
    f.jumpBuffer = 0;
    f.coyoteTimer = 0;
  }

  if (!f.grounded && input.crouch && f.vy > -2 && !f.attack) {
    f.vy += 0.55;
  }

  if (!stunned) {
    if (input.light) startAttack(f, "light", input, game);
    if (input.heavy) startAttack(f, "heavy", input, game);
    if (input.special) startAttack(f, "special", input, game);
  }

  f.x += f.vx;
  f.y += f.vy;
  f.vy += GRAVITY;

  if (f.y + f.height >= FLOOR_Y) {
    f.y = FLOOR_Y - f.height;
    f.vy = 0;
    f.grounded = true;
  } else {
    f.grounded = false;
  }

  if (f.x < LEFT_WALL) f.x = LEFT_WALL;
  if (f.x + f.width > RIGHT_WALL) f.x = RIGHT_WALL - f.width;

  updateWallState(f);

  if (!f.grounded && f.wallSide && f.vy > 3.5 && !f.attack) {
    f.vy = Math.min(f.vy, effectivePiece(f) === "rook" ? 5.2 : 3.8);
  }

  if (!f.attack || f.attack === "special" || f.attack === "airSpecial") {
    f.facing = f.x < opponent.x ? 1 : -1;
  }

  if (f.attack) {
    f.attackTimer--;
    if (f.attackTimer <= 0) {
      f.attack = null;
      f.attackAim = "forward";
      f.hitThisAttack = false;
      f.multiHitCooldown = 0;
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
      const wallDmg = Math.ceil(f.wallBouncePower * 0.42);
      f.hp = Math.max(0, f.hp - wallDmg);
      f.hurtTimer = Math.max(f.hurtTimer, 18);
      pushEffect(game, "wallBounce", f.x + f.width / 2, f.y + f.height / 2, { timer: 18 });
      f.wallBounceWindow = 0;
    }
  }

  f.jumpWasDown = !!input.jump;
  f.blockWasDown = !!input.block;
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

  let damage = meta.damage;
  let kb = meta.kb;
  let lift = meta.lift;

  const comboScale = clamp(1 - defender.comboCount * 0.07, 0.58, 1);
  damage = Math.ceil(damage * comboScale);
  kb *= clamp(1 - defender.comboCount * 0.04, 0.7, 1);

  const defenderFacingAttack = defender.facing === -attacker.facing;
  const defenderArmored = defender.armorTimer > 0 && !meta.armorBreak;

  if (meta.continuous) {
    damage = Math.max(2, Math.ceil(damage * 0.5));
    kb *= 0.55;
  }

  if (defender.parryTimer > 0 && defenderFacingAttack) {
    defender.parryTimer = 0;
    defender.stamina = Math.min(defender.maxStamina, defender.stamina + 18);
    defender.invulnTimer = 12;
    defender.hurtTimer = 0;

    attacker.hurtTimer = Math.max(attacker.hurtTimer, 24);
    attacker.vx -= attacker.facing * 6.5;
    attacker.vy = Math.min(attacker.vy, -3.5);
    attacker.attack = null;
    attacker.attackTimer = 0;

    game.hitstop = Math.max(game.hitstop, 8);
    game.shake = Math.max(game.shake, 8);
    pushEffect(game, "parry", defender.x + defender.width / 2, defender.y + defender.height * 0.45, { timer: 24 });
    return;
  }

  if (defender.blocking && defenderFacingAttack) {
    let blockReduction = 0.28;
    let blockKb = 0.35;
    let drain = meta.blockDrain;

    const defenderPiece = effectivePiece(defender);
    if (defenderPiece === "king") { blockReduction = 0.18; blockKb = 0.24; drain *= 0.75; }
    if (defenderPiece === "rook") { blockReduction = 0.2; blockKb = 0.28; drain *= 0.82; }
    if (defenderPiece === "queen") { blockReduction = 0.16; blockKb = 0.23; drain *= 0.7; }

    damage = Math.ceil(damage * blockReduction);
    kb *= blockKb;
    defender.stamina = Math.max(0, defender.stamina - drain);
    defender.staminaRegenDelay = 40;

    if (meta.armorBreak || defender.stamina <= 0) {
      defender.blocking = false;
      defender.guardBrokenTimer = 68;
      defender.hurtTimer = Math.max(defender.hurtTimer, 42);
      kb *= 2.2;
      damage = Math.max(damage, Math.ceil(meta.damage * 0.78));
      pushEffect(game, "guardBreak", defender.x + defender.width / 2, defender.y + defender.height * 0.45, { timer: 30 });
    } else {
      pushEffect(game, "block", defender.x + defender.width / 2, defender.y + defender.height * 0.45, { timer: 10 });
    }
  } else if (defenderArmored) {
    damage = Math.ceil(damage * 0.48);
    kb *= 0.38;
    pushEffect(game, "armor", defender.x + defender.width / 2, defender.y + defender.height * 0.45, { timer: 10 });
  } else {
    defender.hurtTimer = meta.continuous ? 8 : 20;
  }

  defender.hp = Math.max(0, defender.hp - damage);
  defender.vx += attacker.facing * kb;
  defender.vy += lift;
  defender.lastHitBy = attacker.side;
  defender.comboCount += 1;
  defender.comboTimer = 90;

  defender.wallBounceWindow = 40;
  defender.wallBouncePower = meta.wallBounce;

  if (attacker.characterKey === "pawn" && !attacker.promoted) {
    chargePawn(attacker, 8 + damage * 0.5);
  }
  if (defender.characterKey === "pawn" && !defender.promoted) {
    chargePawn(defender, 3 + damage * 0.18);
  }

  game.hitstop = Math.max(game.hitstop, meta.continuous ? 3 : meta.damage >= 15 ? 9 : meta.damage >= 11 ? 7 : 5);
  game.shake = Math.max(game.shake, meta.damage >= 15 ? 10 : meta.damage >= 11 ? 7 : 4);

  pushEffect(
    game,
    "hit",
    clamp(box.x + box.width / 2, defender.x, defender.x + defender.width),
    clamp(box.y + box.height / 2, defender.y, defender.y + defender.height),
    { timer: meta.continuous ? 8 : 18, damage, attack: attacker.attack, piece: effectivePiece(attacker) }
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
    if (!leaderboard[players[socket.id].name]) leaderboard[players[socket.id].name] = 0;
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
      block: !!input.block,
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