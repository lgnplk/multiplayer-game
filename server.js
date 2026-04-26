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
const GRAVITY = 0.78;
const ROUNDS_TO_WIN = 3;
const PROMOTION_MAX = 100;

const LEFT_WALL = 20;
const RIGHT_WALL = WIDTH - 20;

const players = {};
const lobbies = {};
const leaderboard = {};

let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Strong standalone fighter. Defensive, stable, and hard to bully.",
    maxHp: 205,
    speed: 4.45,
    jump: 13.7,
    width: 62,
    height: 112,
    reach: 62,
    lightDamage: 6,
    heavyDamage: 11,
    specialDamage: 13
  },
  rook: {
    name: "Rook",
    title: "Slow fortress. Huge reach, huge knockback, terrifying near walls.",
    maxHp: 235,
    speed: 3.35,
    jump: 11.5,
    width: 74,
    height: 120,
    reach: 92,
    lightDamage: 5,
    heavyDamage: 13,
    specialDamage: 15
  },
  bishop: {
    name: "Bishop",
    title: "Diagonal range monster. Controls strange angles from far away.",
    maxHp: 170,
    speed: 4.85,
    jump: 15.2,
    width: 56,
    height: 110,
    reach: 102,
    lightDamage: 4,
    heavyDamage: 11,
    specialDamage: 14
  },
  knight: {
    name: "Knight",
    title: "Tricky and evasive. Great hops, angles, wall jumps, and fakeouts.",
    maxHp: 170,
    speed: 4.55,
    jump: 17.5,
    width: 58,
    height: 106,
    reach: 58,
    lightDamage: 5,
    heavyDamage: 9,
    specialDamage: 12
  },
  pawn: {
    name: "Pawn",
    title: "Playable underdog. Builds promotion by surviving and landing hits.",
    maxHp: 175,
    speed: 4.75,
    jump: 14,
    width: 52,
    height: 98,
    reach: 55,
    lightDamage: 5,
    heavyDamage: 9,
    specialDamage: 10
  }
};

function makeId() {
  return String(nextLobbyId++);
}

function cleanName(name) {
  return String(name || "Nameless").trim().slice(0, 18) || "Nameless";
}

function getCharacter(key) {
  return CHARACTERS[key] || CHARACTERS.king;
}

function roomName(lobbyId) {
  return `lobby:${lobbyId}`;
}

function getSocket(socketId) {
  return io.sockets.sockets.get(socketId);
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
    crouchHeight: Math.floor(ch.height * 0.64),
    height: ch.height,

    maxHp: ch.maxHp,
    hp: ch.maxHp,
    speed: ch.speed,
    jump: ch.jump,
    reach: ch.reach,

    facing: side === "white" ? 1 : -1,
    grounded: true,
    crouching: false,
    blocking: false,

    lightDamage: ch.lightDamage,
    heavyDamage: ch.heavyDamage,
    specialDamage: ch.specialDamage,

    promoted: false,
    promotionMeter: 0,

    attack: null,
    attackTimer: 0,
    hitThisAttack: false,

    lightCooldown: 0,
    heavyCooldown: 0,
    specialCooldown: 0,

    hurtTimer: 0,
    armorTimer: 0,

    jumpWasDown: false,
    wallSide: 0,
    wallJumpLock: 0,
    wallBounceWindow: 0,
    wallBouncePower: 0,
    wallBounceTimer: 0,
    lastWallBounceSide: 0
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
    roundOver: false,
    roundOverTimer: 0,
    roundWinner: null,
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

  if (sock) {
    sock.leave(roomName(lobbyId));
  }

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
      lobby.message = `${winnerName} wins the board because the opponent disconnected.`;
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

function getMoveProfile(f, attackType = f.attack) {
  const piece = effectivePiece(f);

  const profile = {
    damageMul: 1,
    knockbackMul: 1,
    rangeBonus: 0,
    armorBreak: false,
    wallBounce: 5,
    lift: -2.5
  };

  if (piece === "king") {
    if (attackType === "light") {
      profile.knockbackMul = 1.08;
    }

    if (attackType === "heavy") {
      profile.damageMul = 1.05;
      profile.knockbackMul = 1.35;
      profile.wallBounce = 9;
    }

    if (attackType === "special") {
      profile.damageMul = 0.95;
      profile.knockbackMul = 1.85;
      profile.rangeBonus = 50;
      profile.wallBounce = 11;
      profile.armorBreak = true;
    }

    if (attackType === "crouchHeavy") {
      profile.knockbackMul = 1.45;
      profile.wallBounce = 10;
      profile.lift = -8;
    }
  }

  if (piece === "rook") {
    profile.rangeBonus = 18;

    if (attackType === "light") {
      profile.rangeBonus += 18;
      profile.knockbackMul = 1.25;
      profile.wallBounce = 8;
    }

    if (attackType === "heavy") {
      profile.rangeBonus += 38;
      profile.damageMul = 1.12;
      profile.knockbackMul = 1.9;
      profile.wallBounce = 16;
      profile.armorBreak = true;
    }

    if (attackType === "special") {
      profile.rangeBonus += 70;
      profile.damageMul = 1.1;
      profile.knockbackMul = 2.45;
      profile.wallBounce = 22;
      profile.armorBreak = true;
    }

    if (attackType === "crouchHeavy") {
      profile.rangeBonus += 30;
      profile.knockbackMul = 1.9;
      profile.wallBounce = 18;
      profile.lift = -6;
    }

    if (attackType === "airHeavy") {
      profile.knockbackMul = 1.55;
      profile.wallBounce = 14;
    }
  }

  if (piece === "bishop") {
    profile.rangeBonus = 22;

    if (attackType === "light") {
      profile.rangeBonus += 28;
      profile.damageMul = 0.95;
    }

    if (attackType === "heavy") {
      profile.rangeBonus += 56;
      profile.knockbackMul = 1.2;
      profile.wallBounce = 10;
    }

    if (attackType === "special") {
      profile.rangeBonus += 100;
      profile.damageMul = 1.08;
      profile.knockbackMul = 1.35;
      profile.wallBounce = 12;
      profile.lift = -5;
    }

    if (attackType === "airSpecial") {
      profile.rangeBonus += 90;
      profile.damageMul = 1.15;
      profile.knockbackMul = 1.35;
      profile.wallBounce = 11;
      profile.lift = 5;
    }

    if (attackType === "crouchLight") {
      profile.rangeBonus += 35;
    }
  }

  if (piece === "knight") {
    if (attackType === "light") {
      profile.knockbackMul = 0.95;
    }

    if (attackType === "heavy") {
      profile.damageMul = 1.02;
      profile.knockbackMul = 1.15;
      profile.wallBounce = 8;
      profile.lift = -6;
    }

    if (attackType === "special") {
      profile.damageMul = 0.95;
      profile.knockbackMul = 1.2;
      profile.rangeBonus = 20;
      profile.wallBounce = 9;
      profile.lift = -10;
    }

    if (attackType === "airLight") {
      profile.rangeBonus = 16;
      profile.knockbackMul = 1.05;
    }

    if (attackType === "airHeavy") {
      profile.damageMul = 1.16;
      profile.knockbackMul = 1.45;
      profile.wallBounce = 11;
      profile.lift = 4;
    }

    if (attackType === "airSpecial") {
      profile.damageMul = 1.28;
      profile.knockbackMul = 1.8;
      profile.rangeBonus = 36;
      profile.wallBounce = 15;
      profile.lift = 7;
    }
  }

  if (piece === "pawn") {
    if (attackType === "light") {
      profile.damageMul = 0.95;
      profile.knockbackMul = 0.95;
    }

    if (attackType === "heavy") {
      profile.damageMul = 1.03;
      profile.knockbackMul = 1.18;
      profile.wallBounce = 8;
    }

    if (attackType === "special") {
      profile.damageMul = 0.9;
      profile.knockbackMul = 1.55;
      profile.rangeBonus = 12;
      profile.wallBounce = 10;
    }

    if (attackType === "crouchLight") {
      profile.damageMul = 0.85;
      profile.rangeBonus = 12;
      profile.knockbackMul = 1.1;
    }

    if (attackType === "crouchHeavy") {
      profile.damageMul = 1.1;
      profile.knockbackMul = 1.35;
      profile.wallBounce = 10;
      profile.lift = -8;
    }

    if (attackType === "airHeavy") {
      profile.damageMul = 1.15;
      profile.knockbackMul = 1.3;
      profile.wallBounce = 9;
    }
  }

  if (piece === "queen") {
    profile.damageMul = 1.28;
    profile.knockbackMul = 1.35;
    profile.rangeBonus = 42;
    profile.wallBounce = 12;

    if (attackType === "light") {
      profile.rangeBonus += 35;
    }

    if (attackType === "heavy") {
      profile.rangeBonus += 60;
      profile.knockbackMul = 1.75;
      profile.wallBounce = 17;
    }

    if (attackType === "special") {
      profile.damageMul = 1.45;
      profile.knockbackMul = 2.25;
      profile.rangeBonus += 115;
      profile.wallBounce = 24;
      profile.armorBreak = true;
    }

    if (attackType === "airSpecial") {
      profile.damageMul = 1.4;
      profile.knockbackMul = 2.0;
      profile.rangeBonus += 75;
      profile.wallBounce = 19;
      profile.armorBreak = true;
    }

    if (attackType === "crouchHeavy") {
      profile.knockbackMul = 1.9;
      profile.wallBounce = 18;
    }
  }

  return profile;
}

function getAttackDuration(type) {
  const durations = {
    light: 14,
    heavy: 28,
    special: 40,
    crouchLight: 16,
    crouchHeavy: 32,
    airLight: 18,
    airHeavy: 30,
    airSpecial: 36
  };

  return durations[type] || 20;
}

function getCooldown(type, f) {
  const piece = effectivePiece(f);

  const cooldowns = {
    light: 20,
    heavy: 50,
    special: 104,
    crouchLight: 24,
    crouchHeavy: 60,
    airLight: 28,
    airHeavy: 66,
    airSpecial: 110
  };

  let cd = cooldowns[type] || 30;

  if (piece === "knight" && type.startsWith("air")) cd *= 0.82;
  if (piece === "rook" && type === "special") cd *= 1.2;
  if (piece === "queen") cd *= 0.85;

  return Math.ceil(cd);
}

function startAttack(f, baseType) {
  if (f.attack) return;

  let type = baseType;

  if (!f.grounded) {
    if (baseType === "light") type = "airLight";
    if (baseType === "heavy") type = "airHeavy";
    if (baseType === "special") type = "airSpecial";
  } else if (f.crouching) {
    if (baseType === "light") type = "crouchLight";
    if (baseType === "heavy") type = "crouchHeavy";
  }

  const cooldown = getCooldown(type, f);

  if (baseType === "light" && f.lightCooldown > 0) return;
  if (baseType === "heavy" && f.heavyCooldown > 0) return;
  if (baseType === "special" && f.specialCooldown > 0) return;

  f.attack = type;
  f.attackTimer = getAttackDuration(type);
  f.hitThisAttack = false;

  if (baseType === "light") f.lightCooldown = cooldown;
  if (baseType === "heavy") f.heavyCooldown = cooldown;
  if (baseType === "special") f.specialCooldown = cooldown;

  const piece = effectivePiece(f);

  if (piece === "king") {
    if (type === "special") {
      f.armorTimer = 34;
      f.vx *= 0.15;
    }

    if (type === "heavy") {
      f.armorTimer = 10;
    }
  }

  if (piece === "rook") {
    if (type === "special") {
      f.vx += f.facing * 8.5;
      f.armorTimer = 44;
    }

    if (type === "heavy" || type === "crouchHeavy") {
      f.armorTimer = 24;
      f.vx += f.facing * 1.4;
    }
  }

  if (piece === "bishop") {
    if (type === "special") {
      f.vx -= f.facing * 4.5;
      f.vy = Math.min(f.vy, -2);
    }

    if (type === "airSpecial") {
      f.vx -= f.facing * 3.5;
      f.vy += 1.5;
    }
  }

  if (piece === "knight") {
    if (type === "special") {
      f.vx += f.facing * 4.2;
      f.vy = -12.5;
      f.grounded = false;
    }

    if (type === "airSpecial") {
      f.vx += f.facing * 8.5;
      f.vy += 7.5;
    }

    if (type === "crouchHeavy") {
      f.vx += f.facing * 2;
    }
  }

  if (piece === "pawn") {
    if (type === "special") {
      f.vx += f.facing * 3.5;
      chargePawn(f, 6);
    }

    if (type === "crouchHeavy") {
      f.vx += f.facing * 2.6;
    }
  }

  if (piece === "queen") {
    if (type === "special") {
      f.armorTimer = 24;
      f.vx += f.facing * 3.8;
    }

    if (type === "airSpecial") {
      f.vx += f.facing * 9.5;
      f.vy += 4.5;
    }
  }

  if (type === "crouchHeavy") {
    f.vx += f.facing * 1.5;
  }
}

function getDamage(f) {
  let base = f.lightDamage;

  if (f.attack === "heavy" || f.attack === "crouchHeavy" || f.attack === "airHeavy") {
    base = f.heavyDamage;
  } else if (f.attack === "special" || f.attack === "airSpecial") {
    base = f.specialDamage;
  }

  const typeMultipliers = {
    light: 1,
    heavy: 1,
    special: 1,
    crouchLight: 0.85,
    crouchHeavy: 1.15,
    airLight: 0.95,
    airHeavy: 1.2,
    airSpecial: 1.25
  };

  const profile = getMoveProfile(f);
  return Math.ceil(base * (typeMultipliers[f.attack] || 1) * profile.damageMul);
}

function getKnockback(f) {
  const values = {
    light: 5,
    heavy: 11,
    special: 13,
    crouchLight: 4,
    crouchHeavy: 14,
    airLight: 6,
    airHeavy: 12,
    airSpecial: 15
  };

  const profile = getMoveProfile(f);
  return (values[f.attack] || 7) * profile.knockbackMul;
}

function activeWindow(f) {
  const t = f.attackTimer;

  if (f.attack === "light") return t <= 10 && t >= 4;
  if (f.attack === "heavy") return t <= 17 && t >= 5;
  if (f.attack === "special") return t <= 25 && t >= 7;

  if (f.attack === "crouchLight") return t <= 11 && t >= 4;
  if (f.attack === "crouchHeavy") return t <= 19 && t >= 6;

  if (f.attack === "airLight") return t <= 13 && t >= 4;
  if (f.attack === "airHeavy") return t <= 19 && t >= 5;
  if (f.attack === "airSpecial") return t <= 23 && t >= 6;

  return false;
}

function attackBox(f) {
  const low = f.attack === "crouchLight" || f.attack === "crouchHeavy";
  const air = f.attack === "airLight" || f.attack === "airHeavy" || f.attack === "airSpecial";
  const piece = effectivePiece(f);
  const profile = getMoveProfile(f);

  let range = f.reach + profile.rangeBonus;
  let height = f.height * 0.5;
  let y = f.y + 22;

  if (f.attack === "heavy" || f.attack === "crouchHeavy" || f.attack === "airHeavy") {
    range += 25;
  }

  if (f.attack === "special" || f.attack === "airSpecial") {
    range += 34;
    height = f.height * 0.72;
  }

  if (low) {
    y = f.y + f.height * 0.58;
    height = f.height * 0.36;
  }

  if (air) {
    y = f.y + f.height * 0.42;
    height = f.height * 0.45;
  }

  if (piece === "rook") {
    if (f.attack === "light") {
      height *= 0.9;
    }

    if (f.attack === "heavy" || f.attack === "special") {
      height *= 1.2;
      y -= 10;
    }
  }

  if (piece === "bishop") {
    if (f.attack === "light" || f.attack === "heavy") {
      y -= 18;
      height *= 1.28;
    }

    if (f.attack === "special" || f.attack === "airSpecial") {
      y -= 42;
      height *= 1.75;
    }
  }

  if (piece === "king" && f.attack === "special") {
    y = f.y - 5;
    height = f.height + 10;
  }

  if (piece === "queen") {
    y -= 12;
    height += 24;

    if (f.attack === "special") {
      y = f.y - 35;
      height = f.height + 70;
    }
  }

  if (f.facing === 1) {
    return {
      x: f.x + f.width - 4,
      y,
      width: range,
      height
    };
  }

  return {
    x: f.x - range + 4,
    y,
    width: range,
    height
  };
}

function promotePawn(f) {
  if (f.characterKey !== "pawn" || f.promoted) return;

  f.promoted = true;
  f.promotionMeter = PROMOTION_MAX;

  f.maxHp += 55;
  f.hp = Math.min(f.maxHp, f.hp + 55);

  f.speed += 1.0;
  f.jump += 2.0;
  f.reach += 42;

  f.lightDamage += 4;
  f.heavyDamage += 6;
  f.specialDamage += 8;

  f.width += 10;
  f.standingHeight += 16;
  f.crouchHeight = Math.floor(f.standingHeight * 0.64);
  f.height = f.standingHeight;

  f.characterName = "Queen";
  f.armorTimer = 45;
  f.hurtTimer = 0;
}

function chargePawn(f, amount) {
  if (f.characterKey !== "pawn" || f.promoted) return;

  f.promotionMeter = Math.min(PROMOTION_MAX, f.promotionMeter + amount);

  if (f.promotionMeter >= PROMOTION_MAX) {
    promotePawn(f);
  }
}

function updateWallState(f) {
  if (f.x <= LEFT_WALL + 2) {
    f.wallSide = -1;
  } else if (f.x + f.width >= RIGHT_WALL - 2) {
    f.wallSide = 1;
  } else {
    f.wallSide = 0;
  }
}

function tryWallJump(f, jumpPressed) {
  if (!jumpPressed) return;
  if (f.grounded) return;
  if (!f.wallSide) return;
  if (f.wallJumpLock > 0) return;

  const piece = effectivePiece(f);

  let strength = 1;

  if (piece === "knight") strength = 1.65;
  if (piece === "bishop") strength = 1.16;
  if (piece === "rook") strength = 0.72;
  if (piece === "king") strength = 0.95;
  if (piece === "pawn") strength = 1.02;
  if (piece === "queen") strength = 1.3;

  f.vx = -f.wallSide * f.speed * 1.75 * strength;
  f.vy = -f.jump * 0.92 * strength;
  f.facing = -f.wallSide;
  f.wallJumpLock = 18;
  f.hurtTimer = Math.max(0, f.hurtTimer - 4);
}

function handleWallBounce(f) {
  if (f.wallBounceWindow > 0) {
    f.wallBounceWindow--;
  }

  if (f.wallBounceTimer > 0) {
    f.wallBounceTimer--;
  }

  const hitLeft = f.x <= LEFT_WALL + 1;
  const hitRight = f.x + f.width >= RIGHT_WALL - 1;

  if (!hitLeft && !hitRight) return;
  if (f.wallBounceWindow <= 0) return;
  if (Math.abs(f.vx) < 4.5) return;

  const side = hitLeft ? -1 : 1;

  f.x = hitLeft ? LEFT_WALL : RIGHT_WALL - f.width;
  f.vx = -side * Math.max(7, Math.abs(f.vx) * 0.55);
  f.vy = Math.min(f.vy, -7);

  const wallDamage = Math.ceil(f.wallBouncePower * 0.45);
  f.hp = Math.max(0, f.hp - wallDamage);

  f.hurtTimer = Math.max(f.hurtTimer, 24);
  f.wallBounceTimer = 20;
  f.lastWallBounceSide = side;
  f.wallBounceWindow = 0;
}

function updateFighter(f, opponent, input) {
  if (f.hurtTimer > 0) f.hurtTimer--;
  if (f.armorTimer > 0) f.armorTimer--;
  if (f.wallJumpLock > 0) f.wallJumpLock--;

  const jumpPressed = !!input.jump && !f.jumpWasDown;

  if (f.characterKey === "pawn" && !f.promoted) {
    chargePawn(f, 0.018);
  }

  updateWallState(f);
  tryWallJump(f, jumpPressed);

  const wantsCrouch = !!input.crouch && f.grounded && !f.attack;
  f.crouching = wantsCrouch;

  const oldHeight = f.height;
  f.height = f.crouching ? f.crouchHeight : f.standingHeight;
  f.y += oldHeight - f.height;

  f.blocking = !!input.block && f.grounded && !f.attack && !f.crouching;

  if (!f.attack && f.hurtTimer <= 8 && !f.blocking) {
    if (input.left && !input.right) {
      f.vx = f.crouching ? -f.speed * 0.35 : -f.speed;
    } else if (input.right && !input.left) {
      f.vx = f.crouching ? f.speed * 0.35 : f.speed;
    } else {
      f.vx *= 0.72;
    }
  } else {
    f.vx *= 0.84;
  }

  if (jumpPressed && f.grounded && !f.blocking && !f.attack && !f.crouching) {
    f.vy = -f.jump;
    f.grounded = false;
  }

  if (!f.grounded && f.wallSide && f.vy > 3.2 && !f.attack) {
    const piece = effectivePiece(f);
    const slideLimit = piece === "knight" ? 2.8 : piece === "rook" ? 5.2 : 3.8;
    f.vy = Math.min(f.vy, slideLimit);
  }

  if (input.light) startAttack(f, "light");
  if (input.heavy) startAttack(f, "heavy");
  if (input.special) startAttack(f, "special");

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
  handleWallBounce(f);

  if (f.x < opponent.x) f.facing = 1;
  else f.facing = -1;

  if (f.lightCooldown > 0) f.lightCooldown--;
  if (f.heavyCooldown > 0) f.heavyCooldown--;
  if (f.specialCooldown > 0) f.specialCooldown--;

  if (f.attack) {
    f.attackTimer--;

    if (f.attackTimer <= 0) {
      f.attack = null;
      f.hitThisAttack = false;
    }
  }

  f.jumpWasDown = !!input.jump;
}

function handleHit(attacker, defender) {
  if (!attacker.attack || attacker.hitThisAttack) return;
  if (!activeWindow(attacker)) return;
  if (!rectsOverlap(attackBox(attacker), defender)) return;

  const profile = getMoveProfile(attacker);

  let dmg = getDamage(attacker);
  let kb = getKnockback(attacker);

  const defenderFacingAttack = defender.facing === -attacker.facing;
  const defenderArmored = defender.armorTimer > 0 && !profile.armorBreak;

  if (defender.blocking && defenderFacingAttack) {
    const defenderPiece = effectivePiece(defender);

    let blockReduction = 0.25;
    let blockKnockback = 0.32;

    if (defenderPiece === "king") {
      blockReduction = 0.14;
      blockKnockback = 0.22;
    }

    if (defenderPiece === "rook") {
      blockReduction = 0.18;
      blockKnockback = 0.25;
    }

    if (defenderPiece === "pawn" && !defender.promoted) {
      blockReduction = 0.22;
      blockKnockback = 0.28;
      chargePawn(defender, 3.5);
    }

    if (defenderPiece === "queen") {
      blockReduction = 0.12;
      blockKnockback = 0.2;
    }

    dmg = Math.ceil(dmg * blockReduction);
    kb *= blockKnockback;
  } else if (defenderArmored) {
    dmg = Math.ceil(dmg * 0.5);
    kb *= 0.38;
  } else {
    defender.hurtTimer = 20;
  }

  defender.hp = Math.max(0, defender.hp - dmg);
  defender.vx += attacker.facing * kb;
  defender.vy += profile.lift;

  defender.wallBounceWindow = 40;
  defender.wallBouncePower = profile.wallBounce;

  if (attacker.attack === "crouchHeavy") {
    defender.vy -= 7;
  } else if (attacker.attack === "airHeavy" || attacker.attack === "airSpecial") {
    defender.vy += 4;
  }

  if (attacker.characterKey === "pawn") {
    if (!attacker.promoted) {
      chargePawn(attacker, 7 + dmg * 0.42);
    }
  }

  if (defender.characterKey === "pawn") {
    if (!defender.promoted) {
      chargePawn(defender, 2.5 + dmg * 0.14);
    }
  }

  attacker.hitThisAttack = true;
}

function determineRoundWinner(white, black) {
  if (white.hp <= 0 && black.hp <= 0) {
    return white.hp >= black.hp ? "white" : "black";
  }

  if (white.hp <= 0) return "black";
  if (black.hp <= 0) return "white";

  return null;
}

function updateGame(lobby) {
  if (!lobby || lobby.status !== "playing" || !lobby.game) return;

  const game = lobby.game;
  const white = game.fighters.white;
  const black = game.fighters.black;

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

  const whiteInput = players[white.id]?.input || {};
  const blackInput = players[black.id]?.input || {};

  updateFighter(white, black, whiteInput);
  updateFighter(black, white, blackInput);

  handleHit(white, black);
  handleHit(black, white);

  const roundWinnerSide = determineRoundWinner(white, black);

  if (roundWinnerSide) {
    const roundWinner = game.fighters[roundWinnerSide];
    const roundWinnerName = roundWinner.name;

    game.roundOver = true;
    game.roundWinner = roundWinnerSide;

    if (roundWinnerSide === "white") {
      lobby.match.whiteRounds += 1;
    } else {
      lobby.match.blackRounds += 1;
    }

    if (
      lobby.match.whiteRounds >= lobby.match.roundsToWin ||
      lobby.match.blackRounds >= lobby.match.roundsToWin
    ) {
      lobby.match.matchWinner = roundWinnerSide;
      lobby.winner = roundWinnerName;
      leaderboard[roundWinnerName] = (leaderboard[roundWinnerName] || 0) + 1;
      lobby.message = `Checkmate. ${roundWinnerName} wins the board ${lobby.match.whiteRounds}-${lobby.match.blackRounds}.`;
      game.roundOverTimer = 260;
    } else {
      lobby.message = `${roundWinnerName} wins round ${lobby.match.currentRound}. Next round soon.`;
      game.roundOverTimer = 170;
    }
  }
}

setInterval(() => {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.status === "playing") {
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

  socket.on("setCharacter", (characterKey) => {
    if (!CHARACTERS[characterKey]) return;
    players[socket.id].characterKey = characterKey;
    sendLobbyData();
  });

  socket.on("createLobby", (lobbyName) => {
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
    lobby.status = "playing";
    lobby.message = "The board is set.";

    players[socket.id].lobbyId = lobbyId;
    players[socket.id].role = "black";

    joinSocketRoom(socket, lobbyId);

    initMatch(lobby);
    startRound(lobby);

    socket.emit("enteredLobby", { lobbyId, role: "black" });

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
    if (!p) return;

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