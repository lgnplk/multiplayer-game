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
    title: "Slow fortress. Long rays, armor, range, and wall pressure.",
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
    title: "Tricky and evasive. Hops, angles, wall jumps, and fakeouts.",
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
    attackAim: "forward",
    hitThisAttack: false,
    multiHitCooldown: 0,

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

function getSpecialAim(input) {
  if (input && input.jump) return "up";
  if (input && input.crouch) return "down";
  return "forward";
}

function isContinuousAttack(f) {
  const piece = effectivePiece(f);
  return piece === "rook" && f.attack === "special";
}

function mergeProfiles(base, bonus) {
  return {
    damageMul: base.damageMul * (bonus.damageMul ?? 1),
    knockbackMul: base.knockbackMul * (bonus.knockbackMul ?? 1),
    rangeBonus: base.rangeBonus + (bonus.rangeBonus ?? 0),
    armorBreak: base.armorBreak || !!bonus.armorBreak,
    wallBounce: base.wallBounce + (bonus.wallBounce ?? 0),
    lift: base.lift + (bonus.lift ?? 0)
  };
}

function getMoveProfile(f, attackType = f.attack) {
  const piece = effectivePiece(f);

  const p = {
    damageMul: 1,
    knockbackMul: 1,
    rangeBonus: 0,
    armorBreak: false,
    wallBounce: 6,
    lift: -2.5
  };

  if (piece === "king") {
    if (attackType === "light") {
      p.rangeBonus = 8;
      p.knockbackMul = 1.05;
    } else if (attackType === "heavy") {
      p.damageMul = 1.18;
      p.knockbackMul = 1.5;
      p.rangeBonus = 16;
      p.wallBounce = 10;
      p.lift = -7;
    } else if (attackType === "special") {
      p.damageMul = 0.95;
      p.knockbackMul = 2.0;
      p.rangeBonus = 12;
      p.wallBounce = 13;
      p.armorBreak = true;
      p.lift = -5;
    } else if (attackType === "crouchHeavy") {
      p.damageMul = 1.08;
      p.knockbackMul = 1.55;
      p.rangeBonus = 10;
      p.wallBounce = 10;
      p.lift = -9;
    } else if (attackType === "airHeavy") {
      p.damageMul = 1.12;
      p.knockbackMul = 1.35;
      p.wallBounce = 9;
      p.lift = 5;
    }
  }

  if (piece === "rook") {
    if (attackType === "light") {
      p.rangeBonus = 52;
      p.knockbackMul = 1.2;
      p.wallBounce = 9;
      p.lift = -1.5;
    } else if (attackType === "heavy") {
      p.rangeBonus = 92;
      p.damageMul = 1.15;
      p.knockbackMul = 2.0;
      p.wallBounce = 17;
      p.armorBreak = true;
      p.lift = -4;
    } else if (attackType === "special") {
      p.rangeBonus = 130;
      p.damageMul = 1.1;
      p.knockbackMul = 2.55;
      p.wallBounce = 24;
      p.armorBreak = true;
      p.lift = -2;
    } else if (attackType === "crouchHeavy") {
      p.rangeBonus = 70;
      p.damageMul = 1.08;
      p.knockbackMul = 1.9;
      p.wallBounce = 19;
      p.lift = -7;
    } else if (attackType === "airHeavy") {
      p.rangeBonus = 30;
      p.knockbackMul = 1.55;
      p.wallBounce = 14;
      p.lift = 6;
    }
  }

  if (piece === "bishop") {
    if (attackType === "light") {
      p.rangeBonus = 42;
      p.damageMul = 0.95;
      p.knockbackMul = 1.0;
      p.lift = -4;
    } else if (attackType === "heavy") {
      p.rangeBonus = 78;
      p.damageMul = 1.08;
      p.knockbackMul = 1.18;
      p.wallBounce = 10;
      p.lift = -6;
    } else if (attackType === "special") {
      p.rangeBonus = 120;
      p.damageMul = 1.12;
      p.knockbackMul = 1.4;
      p.wallBounce = 13;
      p.lift = -5;
    } else if (attackType === "airSpecial") {
      p.rangeBonus = 105;
      p.damageMul = 1.18;
      p.knockbackMul = 1.42;
      p.wallBounce = 12;
      p.lift = 4;
    } else if (attackType === "crouchLight") {
      p.rangeBonus = 55;
      p.damageMul = 0.9;
      p.knockbackMul = 0.95;
    }
  }

  if (piece === "knight") {
    if (attackType === "light") {
      p.rangeBonus = 4;
      p.knockbackMul = 0.92;
      p.lift = -3;
    } else if (attackType === "heavy") {
      p.rangeBonus = 14;
      p.damageMul = 1.0;
      p.knockbackMul = 1.08;
      p.wallBounce = 8;
      p.lift = -11;
    } else if (attackType === "special") {
      p.rangeBonus = 20;
      p.damageMul = 0.9;
      p.knockbackMul = 1.12;
      p.wallBounce = 9;
      p.lift = -13;
    } else if (attackType === "airLight") {
      p.rangeBonus = 18;
      p.knockbackMul = 1.02;
      p.lift = 1;
    } else if (attackType === "airHeavy") {
      p.rangeBonus = 26;
      p.damageMul = 1.18;
      p.knockbackMul = 1.5;
      p.wallBounce = 12;
      p.lift = 7;
    } else if (attackType === "airSpecial") {
      p.rangeBonus = 40;
      p.damageMul = 1.32;
      p.knockbackMul = 1.9;
      p.wallBounce = 17;
      p.lift = 10;
    } else if (attackType === "crouchHeavy") {
      p.rangeBonus = 12;
      p.damageMul = 0.96;
      p.knockbackMul = 1.28;
      p.wallBounce = 9;
      p.lift = -12;
    }
  }

  if (piece === "pawn") {
    if (attackType === "light") {
      p.rangeBonus = 14;
      p.damageMul = 0.97;
      p.knockbackMul = 0.95;
    } else if (attackType === "heavy") {
      p.rangeBonus = 18;
      p.damageMul = 1.06;
      p.knockbackMul = 1.22;
      p.wallBounce = 8;
      p.lift = -4;
    } else if (attackType === "special") {
      p.rangeBonus = 28;
      p.damageMul = 0.95;
      p.knockbackMul = 1.5;
      p.wallBounce = 11;
      p.lift = -2;
    } else if (attackType === "crouchLight") {
      p.rangeBonus = 18;
      p.damageMul = 0.84;
      p.knockbackMul = 1.08;
      p.lift = -1;
    } else if (attackType === "crouchHeavy") {
      p.rangeBonus = 20;
      p.damageMul = 1.12;
      p.knockbackMul = 1.38;
      p.wallBounce = 10;
      p.lift = -10;
    } else if (attackType === "airHeavy") {
      p.rangeBonus = 16;
      p.damageMul = 1.16;
      p.knockbackMul = 1.28;
      p.wallBounce = 10;
      p.lift = 8;
    }
  }

  if (piece === "queen") {
    if (attackType === "light") {
      p.rangeBonus = 55;
      p.damageMul = 1.2;
      p.knockbackMul = 1.3;
      p.wallBounce = 12;
    } else if (attackType === "heavy") {
      p.rangeBonus = 90;
      p.damageMul = 1.34;
      p.knockbackMul = 1.8;
      p.wallBounce = 18;
      p.lift = -7;
    } else if (attackType === "special") {
      p.rangeBonus = 135;
      p.damageMul = 1.5;
      p.knockbackMul = 2.35;
      p.wallBounce = 26;
      p.armorBreak = true;
      p.lift = -5;
    } else if (attackType === "airSpecial") {
      p.rangeBonus = 100;
      p.damageMul = 1.42;
      p.knockbackMul = 2.05;
      p.wallBounce = 21;
      p.armorBreak = true;
      p.lift = 9;
    } else if (attackType === "crouchHeavy") {
      p.rangeBonus = 42;
      p.damageMul = 1.28;
      p.knockbackMul = 1.95;
      p.wallBounce = 18;
      p.lift = -10;
    }
  }

  return p;
}

function getAimProfileBonus(f) {
  const piece = effectivePiece(f);
  const attack = f.attack;
  const aim = f.attackAim || "forward";

  const bonus = {
    damageMul: 1,
    knockbackMul: 1,
    rangeBonus: 0,
    armorBreak: false,
    wallBounce: 0,
    lift: 0
  };

  if (attack !== "special" && attack !== "airSpecial") return bonus;

  if (piece === "rook") {
    if (aim === "forward") {
      bonus.rangeBonus += 120;
      bonus.knockbackMul *= 1.25;
      bonus.wallBounce += 8;
      bonus.damageMul *= 0.62;
    }

    if (aim === "up") {
      bonus.rangeBonus += 80;
      bonus.knockbackMul *= 1.1;
      bonus.wallBounce += 5;
      bonus.lift -= 12;
      bonus.damageMul *= 0.58;
    }

    if (aim === "down") {
      bonus.rangeBonus += 55;
      bonus.knockbackMul *= 1.55;
      bonus.wallBounce += 10;
      bonus.lift -= 4;
      bonus.damageMul *= 0.72;
    }
  }

  if (piece === "bishop") {
    if (aim === "forward") {
      bonus.rangeBonus += 95;
      bonus.lift -= 4;
    }

    if (aim === "up") {
      bonus.rangeBonus += 70;
      bonus.lift -= 14;
      bonus.knockbackMul *= 1.15;
    }

    if (aim === "down") {
      bonus.rangeBonus += 70;
      bonus.lift += 8;
      bonus.knockbackMul *= 1.25;
    }
  }

  if (piece === "knight") {
    if (aim === "forward") {
      bonus.rangeBonus += 25;
      bonus.knockbackMul *= 1.25;
      bonus.wallBounce += 3;
    }

    if (aim === "up") {
      bonus.rangeBonus += 20;
      bonus.lift -= 18;
      bonus.knockbackMul *= 1.1;
    }

    if (aim === "down") {
      bonus.rangeBonus += 30;
      bonus.lift += 12;
      bonus.damageMul *= 1.18;
      bonus.knockbackMul *= 1.35;
      bonus.wallBounce += 5;
    }
  }

  if (piece === "king") {
    if (aim === "forward") {
      bonus.knockbackMul *= 1.25;
      bonus.wallBounce += 5;
    }

    if (aim === "up") {
      bonus.lift -= 16;
      bonus.rangeBonus += 20;
      bonus.damageMul *= 0.9;
    }

    if (aim === "down") {
      bonus.knockbackMul *= 1.55;
      bonus.wallBounce += 7;
      bonus.armorBreak = true;
    }
  }

  if (piece === "pawn") {
    if (aim === "forward") {
      bonus.knockbackMul *= 1.2;
      bonus.wallBounce += 3;
    }

    if (aim === "up") {
      bonus.lift -= 12;
      bonus.rangeBonus += 10;
      bonus.damageMul *= 0.95;
    }

    if (aim === "down") {
      bonus.lift -= 6;
      bonus.knockbackMul *= 1.35;
      bonus.wallBounce += 4;
    }
  }

  if (piece === "queen") {
    if (aim === "forward") {
      bonus.rangeBonus += 95;
      bonus.knockbackMul *= 1.35;
      bonus.wallBounce += 8;
      bonus.armorBreak = true;
    }

    if (aim === "up") {
      bonus.rangeBonus += 70;
      bonus.lift -= 22;
      bonus.damageMul *= 1.05;
      bonus.armorBreak = true;
    }

    if (aim === "down") {
      bonus.rangeBonus += 75;
      bonus.lift += 10;
      bonus.knockbackMul *= 1.55;
      bonus.wallBounce += 10;
      bonus.armorBreak = true;
    }
  }

  return bonus;
}

function getAttackDuration(type, f = null) {
  const piece = f ? effectivePiece(f) : null;

  if (type === "special") {
    if (piece === "rook") return 78;
    if (piece === "bishop") return 46;
    if (piece === "king") return 44;
    if (piece === "knight") return 38;
    if (piece === "pawn") return 34;
    if (piece === "queen") return 52;
  }

  if (type === "airSpecial") {
    if (piece === "rook") return 54;
    if (piece === "bishop") return 42;
    if (piece === "knight") return 36;
    if (piece === "queen") return 46;
  }

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

  if (piece === "rook") {
    if (type === "heavy" || type === "special") cd += 10;
  }

  if (piece === "bishop") {
    if (type === "special" || type === "airSpecial") cd += 4;
  }

  if (piece === "knight") {
    if (type === "special" || type === "airSpecial") cd -= 10;
    if (type === "airLight" || type === "airHeavy") cd -= 6;
  }

  if (piece === "pawn") {
    if (type === "light" || type === "crouchLight") cd -= 3;
  }

  if (piece === "queen") {
    if (type === "special" || type === "airSpecial") cd += 6;
    else cd -= 4;
  }

  return Math.max(8, Math.ceil(cd));
}

function startAttack(f, baseType, input = {}) {
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

  if (baseType === "special") {
    f.attackAim = getSpecialAim(input);
  } else {
    f.attackAim = "forward";
  }

  const cooldown = getCooldown(type, f);

  if (baseType === "light" && f.lightCooldown > 0) return;
  if (baseType === "heavy" && f.heavyCooldown > 0) return;
  if (baseType === "special" && f.specialCooldown > 0) return;

  f.attack = type;
  f.attackTimer = getAttackDuration(type, f);
  f.hitThisAttack = false;
  f.multiHitCooldown = 0;

  if (baseType === "light") f.lightCooldown = cooldown;
  if (baseType === "heavy") f.heavyCooldown = cooldown;
  if (baseType === "special") f.specialCooldown = cooldown;

  const piece = effectivePiece(f);
  const aim = f.attackAim;

  if (piece === "king") {
    if (type === "light") f.vx += f.facing * 0.8;

    if (type === "heavy") {
      f.vx += f.facing * 1.8;
      f.armorTimer = 12;
    }

    if (type === "special") {
      f.armorTimer = 36;

      if (aim === "forward") f.vx *= 0.1;

      if (aim === "up") {
        f.vx *= 0.25;
        f.vy = Math.min(f.vy, -4);
      }

      if (aim === "down") {
        f.vx += f.facing * 2.6;
      }
    }
  }

  if (piece === "rook") {
    if (type === "light") f.vx += f.facing * 0.6;

    if (type === "heavy") {
      f.vx += f.facing * 1.6;
      f.armorTimer = 20;
    }

    if (type === "special") {
      f.armorTimer = 58;

      if (aim === "forward") {
        f.vx *= 0.05;
      }

      if (aim === "up") {
        f.vx *= 0.04;
        f.vy = Math.min(f.vy, -1.5);
      }

      if (aim === "down") {
        f.vx += f.facing * 6.8;
      }
    }

    if (type === "crouchHeavy") {
      f.vx += f.facing * 1.2;
      f.armorTimer = 18;
    }
  }

  if (piece === "bishop") {
    if (type === "light") f.vx += f.facing * 0.4;
    if (type === "heavy") f.vx += f.facing * 0.8;

    if (type === "special" || type === "airSpecial") {
      if (aim === "forward") {
        f.vx -= f.facing * 5.0;
        f.vy = Math.min(f.vy, -2.5);
      }

      if (aim === "up") {
        f.vx -= f.facing * 2.5;
        f.vy = -8.5;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx -= f.facing * 3.2;
        f.vy += 4.5;
      }
    }
  }

  if (piece === "knight") {
    if (type === "light") f.vx += f.facing * 0.2;

    if (type === "heavy") {
      f.vy = Math.min(f.vy, -6.5);
      f.grounded = false;
    }

    if (type === "special" || type === "airSpecial") {
      if (aim === "forward") {
        f.vx += f.facing * 3.7;
        f.vy = -13.2;
        f.grounded = false;
      }

      if (aim === "up") {
        f.vx -= f.facing * 2.4;
        f.vy = -16.0;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 7.8;
        f.vy += 9.5;
      }
    }

    if (type === "crouchHeavy") {
      f.vx -= f.facing * 1.2;
      f.vy = Math.min(f.vy, -3.5);
      f.grounded = false;
    }
  }

  if (piece === "pawn") {
    if (type === "light") f.vx += f.facing * 0.8;
    if (type === "heavy") f.vx += f.facing * 2.1;

    if (type === "special" || type === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 4.2;

      if (aim === "up") {
        f.vx += f.facing * 1.4;
        f.vy = -9.5;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 3.2;
        f.vy = Math.min(f.vy, -3.0);
      }

      chargePawn(f, 6);
    }

    if (type === "crouchHeavy") {
      f.vx += f.facing * 2.6;
      f.vy = Math.min(f.vy, -4.5);
      f.grounded = false;
    }
  }

  if (piece === "queen") {
    if (type === "light") f.vx += f.facing * 1.1;

    if (type === "heavy") {
      f.vx += f.facing * 2.2;
      f.armorTimer = 10;
    }

    if (type === "special" || type === "airSpecial") {
      f.armorTimer = 30;

      if (aim === "forward") f.vx += f.facing * 4.2;

      if (aim === "up") {
        f.vx *= 0.35;
        f.vy = -10.5;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 7.5;
        f.vy += 5.6;
      }
    }
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

  return Math.ceil(base * (typeMultipliers[f.attack] || 1));
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

  return values[f.attack] || 7;
}

function activeWindow(f) {
  const t = f.attackTimer;
  const piece = effectivePiece(f);

  if (piece === "rook" && f.attack === "special") return t <= 68 && t >= 8;

  if (f.attack === "light") return t <= 10 && t >= 4;
  if (f.attack === "heavy") return t <= 17 && t >= 5;
  if (f.attack === "special") return t <= 30 && t >= 7;

  if (f.attack === "crouchLight") return t <= 11 && t >= 4;
  if (f.attack === "crouchHeavy") return t <= 19 && t >= 6;

  if (f.attack === "airLight") return t <= 13 && t >= 4;
  if (f.attack === "airHeavy") return t <= 19 && t >= 5;
  if (f.attack === "airSpecial") return t <= 24 && t >= 6;

  return false;
}

function attackBox(f) {
  const piece = effectivePiece(f);
  const attack = f.attack;
  const aim = f.attackAim || "forward";
  const profile = mergeProfiles(getMoveProfile(f), getAimProfileBonus(f));

  const frontEdge = f.facing === 1 ? f.x + f.width : f.x;

  function forwardBox(gap, w, y, h) {
    if (f.facing === 1) {
      return { x: frontEdge + gap, y, width: w, height: h };
    }

    return { x: frontEdge - gap - w, y, width: w, height: h };
  }

  function centeredBox(xOffset, w, y, h) {
    return { x: f.x + xOffset, y, width: w, height: h };
  }

  function upBox(w, h) {
    return {
      x: f.x + f.width / 2 - w / 2,
      y: f.y - h + 12,
      width: w,
      height: h
    };
  }

  if (attack === "special" || attack === "airSpecial") {
    if (piece === "rook") {
      if (aim === "up") return upBox(72, 290);
      if (aim === "down") return forwardBox(-8, 120 + profile.rangeBonus * 0.25, f.y + f.height * 0.55, 36);
      return forwardBox(-4, 165 + profile.rangeBonus, f.y + 12, 64);
    }

    if (piece === "bishop") {
      if (aim === "up") return forwardBox(0, 150 + profile.rangeBonus * 0.45, f.y - 110, f.height * 0.75);
      if (aim === "down") return forwardBox(0, 150 + profile.rangeBonus * 0.45, f.y + f.height * 0.35, f.height * 0.65);
      return forwardBox(0, 120 + profile.rangeBonus, f.y - 42, f.height * 1.02);
    }

    if (piece === "knight") {
      if (aim === "up") return upBox(74, 145);
      if (aim === "down") return forwardBox(8, 82 + profile.rangeBonus, f.y + f.height * 0.45, f.height * 0.48);
      return forwardBox(10, 72 + profile.rangeBonus, f.y - 38, f.height * 0.5);
    }

    if (piece === "king") {
      if (aim === "up") return upBox(110, 150);
      if (aim === "down") return centeredBox(-18, f.width + 36, f.y + f.height * 0.42, f.height * 0.46);
      return centeredBox(-34, f.width + 68, f.y - 8, f.height + 16);
    }

    if (piece === "pawn") {
      if (aim === "up") return upBox(54, 110);
      if (aim === "down") return forwardBox(0, 62 + profile.rangeBonus, f.y + f.height * 0.58, f.height * 0.28);
      return forwardBox(0, 58 + profile.rangeBonus, f.y + 22, f.height * 0.3);
    }

    if (piece === "queen") {
      if (aim === "up") return upBox(155, 235);
      if (aim === "down") return forwardBox(-16, 135 + profile.rangeBonus, f.y + f.height * 0.32, f.height * 0.58);
      return centeredBox(-45, f.width + 105 + profile.rangeBonus * 0.5, f.y - 34, f.height + 68);
    }
  }

  if (piece === "king") {
    if (attack === "light") return forwardBox(0, 54, f.y + 26, f.height * 0.34);
    if (attack === "heavy") return forwardBox(0, 78, f.y + 8, f.height * 0.56);
    if (attack === "crouchLight") return forwardBox(0, 36, f.y + f.height * 0.62, f.height * 0.22);
    if (attack === "crouchHeavy") return forwardBox(0, 64, f.y + f.height * 0.5, f.height * 0.34);
    if (attack === "airLight") return forwardBox(0, 48, f.y + f.height * 0.38, f.height * 0.28);
    if (attack === "airHeavy") return forwardBox(0, 72, f.y + f.height * 0.25, f.height * 0.5);
  }

  if (piece === "rook") {
    if (attack === "light") return forwardBox(2, 124, f.y + 30, f.height * 0.22);
    if (attack === "heavy") return forwardBox(0, 188, f.y + 18, f.height * 0.42);
    if (attack === "crouchLight") return forwardBox(0, 52, f.y + f.height * 0.64, f.height * 0.18);
    if (attack === "crouchHeavy") return forwardBox(0, 158, f.y + f.height * 0.54, f.height * 0.24);
    if (attack === "airLight") return forwardBox(0, 44, f.y + f.height * 0.44, f.height * 0.2);
    if (attack === "airHeavy") return forwardBox(0, 98, f.y + f.height * 0.4, f.height * 0.32);
  }

  if (piece === "bishop") {
    if (attack === "light") return forwardBox(0, 106, f.y - 8, f.height * 0.52);
    if (attack === "heavy") return forwardBox(0, 156, f.y + 8, f.height * 0.6);
    if (attack === "crouchLight") return forwardBox(0, 111, f.y + f.height * 0.45, f.height * 0.28);
    if (attack === "crouchHeavy") return forwardBox(0, 124, f.y + f.height * 0.36, f.height * 0.36);
    if (attack === "airLight") return forwardBox(0, 52, f.y + f.height * 0.22, f.height * 0.42);
    if (attack === "airHeavy") return forwardBox(0, 98, f.y + f.height * 0.2, f.height * 0.5);
  }

  if (piece === "knight") {
    if (attack === "light") return forwardBox(0, 38, f.y + 24, f.height * 0.3);
    if (attack === "heavy") return forwardBox(0, 54, f.y - 10, f.height * 0.5);
    if (attack === "crouchLight") return forwardBox(0, 32, f.y + f.height * 0.62, f.height * 0.18);
    if (attack === "crouchHeavy") return forwardBox(6, 54, f.y + f.height * 0.38, f.height * 0.34);
    if (attack === "airLight") return forwardBox(4, 62, f.y + f.height * 0.28, f.height * 0.26);
    if (attack === "airHeavy") return forwardBox(6, 76, f.y + f.height * 0.42, f.height * 0.34);
  }

  if (piece === "pawn") {
    if (attack === "light") return forwardBox(0, 54, f.y + 26, f.height * 0.26);
    if (attack === "heavy") return forwardBox(0, 66, f.y + 20, f.height * 0.32);
    if (attack === "crouchLight") return forwardBox(0, 52, f.y + f.height * 0.64, f.height * 0.18);
    if (attack === "crouchHeavy") return forwardBox(0, 66, f.y + f.height * 0.42, f.height * 0.3);
    if (attack === "airLight") return forwardBox(0, 34, f.y + f.height * 0.34, f.height * 0.22);
    if (attack === "airHeavy") return forwardBox(0, 56, f.y + f.height * 0.48, f.height * 0.32);
  }

  if (piece === "queen") {
    if (attack === "light") return forwardBox(0, 125, f.y + 16, f.height * 0.42);
    if (attack === "heavy") return forwardBox(0, 182, f.y + 4, f.height * 0.6);
    if (attack === "crouchLight") return forwardBox(0, 46, f.y + f.height * 0.56, f.height * 0.22);
    if (attack === "crouchHeavy") return forwardBox(0, 114, f.y + f.height * 0.4, f.height * 0.34);
    if (attack === "airLight") return forwardBox(0, 52, f.y + f.height * 0.28, f.height * 0.24);
    if (attack === "airHeavy") return forwardBox(0, 129, f.y + f.height * 0.26, f.height * 0.38);
  }

  return forwardBox(0, 60, f.y + 20, f.height * 0.4);
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
  let horizontalMul = 1.75;

  if (piece === "knight") {
    strength = 1.7;
    horizontalMul = 1.95;
  }

  if (piece === "bishop") {
    strength = 1.2;
    horizontalMul = 1.8;
  }

  if (piece === "rook") {
    strength = 0.72;
    horizontalMul = 1.35;
  }

  if (piece === "king") {
    strength = 0.95;
    horizontalMul = 1.6;
  }

  if (piece === "pawn") {
    strength = 1.03;
    horizontalMul = 1.72;
  }

  if (piece === "queen") {
    strength = 1.3;
    horizontalMul = 1.9;
  }

  f.vx = -f.wallSide * f.speed * horizontalMul * strength;
  f.vy = -f.jump * 0.92 * strength;
  f.facing = -f.wallSide;
  f.wallJumpLock = 18;
  f.hurtTimer = Math.max(0, f.hurtTimer - 4);
}

function handleWallBounce(f) {
  if (f.wallBounceWindow > 0) f.wallBounceWindow--;
  if (f.wallBounceTimer > 0) f.wallBounceTimer--;

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
  if (f.multiHitCooldown > 0) f.multiHitCooldown--;

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

  if (input.light) startAttack(f, "light", input);
  if (input.heavy) startAttack(f, "heavy", input);
  if (input.special) startAttack(f, "special", input);

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
      f.attackAim = "forward";
      f.hitThisAttack = false;
      f.multiHitCooldown = 0;
    }
  }

  f.jumpWasDown = !!input.jump;
}

function handleHit(attacker, defender) {
  if (!attacker.attack) return;
  if (!activeWindow(attacker)) return;

  const continuous = isContinuousAttack(attacker);

  if (continuous) {
    if (attacker.multiHitCooldown > 0) return;
  } else {
    if (attacker.hitThisAttack) return;
  }

  if (!rectsOverlap(attackBox(attacker), defender)) return;

  const profile = mergeProfiles(getMoveProfile(attacker), getAimProfileBonus(attacker));

  let dmg = getDamage(attacker);
  let kb = getKnockback(attacker);

  dmg = Math.ceil(dmg * profile.damageMul);
  kb *= profile.knockbackMul;

  const defenderFacingAttack = defender.facing === -attacker.facing;
  const defenderArmored = defender.armorTimer > 0 && !profile.armorBreak;

  if (continuous) {
    dmg = Math.max(2, Math.ceil(dmg * 0.38));
    kb *= 0.45;
  }

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
    defender.hurtTimer = continuous ? 8 : 20;
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

  if (attacker.characterKey === "pawn" && !attacker.promoted) {
    chargePawn(attacker, 7 + dmg * 0.42);
  }

  if (defender.characterKey === "pawn" && !defender.promoted) {
    chargePawn(defender, 2.5 + dmg * 0.14);
  }

  if (continuous) {
    attacker.multiHitCooldown = 11;
  } else {
    attacker.hitThisAttack = true;
  }
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