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

const MOVE_SPEED_MULT = 1.58;
const JUMP_MULT = 1.18;
const GLOBAL_KNOCKBACK_MULT = 1.42;
const GLOBAL_LIFT_MULT = 1.18;
const WALL_BOUNCE_DAMAGE_MULT = 0.72;

const players = {};
const lobbies = {};
const leaderboard = {};
let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Heavy royal bruiser. Uses a scepter, shoulder checks, and command slams.",
    maxHp: 625,
    speed: 4.55,
    jump: 13.5,
    width: 72,
    height: 124
  },
  rook: {
    name: "Rook",
    title: "Fortress grappler. Rams, shoves, wall-bounces, and crushes space.",
    maxHp: 740,
    speed: 3.8,
    jump: 11.6,
    width: 84,
    height: 132
  },
  bishop: {
    name: "Bishop",
    title: "Fast diagonal duelist. Uses blade-like mitre cuts and angled lunges.",
    maxHp: 540,
    speed: 5.15,
    jump: 15.2,
    width: 64,
    height: 122
  },
  knight: {
    name: "Knight",
    title: "Explosive jumper. Kicks, hooks, tramples, and launches in L-patterns.",
    maxHp: 535,
    speed: 5.0,
    jump: 18.2,
    width: 66,
    height: 116
  },
  pawn: {
    name: "Pawn",
    title: "Fast lancer. Spear pokes, brave charges, and dangerous promotion pressure.",
    maxHp: 545,
    speed: 5.1,
    jump: 14.2,
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
    speed: ch.speed * MOVE_SPEED_MULT,
    jump: ch.jump * JUMP_MULT,

    facing: side === "white" ? 1 : -1,
    grounded: true,
    crouching: false,
    blocking: false,

    attack: null,
    attackTimer: 0,
    attackDuration: 0,
    attackAim: "forward",
    attackFacing: side === "white" ? 1 : -1,
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

function attackDir(f) {
  return f.attack ? (f.attackFacing || f.facing || 1) : (f.facing || 1);
}

function getMoveMeta(f, attack = f.attack, aim = f.attackAim || "forward") {
  const piece = effectivePiece(f);

  const m = {
    duration: 20,
    activeStart: 5,
    activeEnd: 12,
    damage: 5,
    kb: 9,
    lift: -3,
    range: 60,
    width: 80,
    height: 40,
    cooldown: 20,
    stamina: 4,
    armorBreak: false,
    continuous: false,
    hitInterval: 8,
    wallBounce: 10,
    blockDrain: 14,
    armorOnStart: 0
  };

  if (piece === "king") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 15,
        activeStart: 4,
        activeEnd: 9,
        damage: 5,
        kb: 11,
        lift: -3,
        width: 92,
        height: 48,
        cooldown: 15,
        stamina: 4,
        wallBounce: 11
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 28,
        activeStart: 8,
        activeEnd: 16,
        damage: 10,
        kb: 20,
        lift: -8,
        width: 132,
        height: 80,
        cooldown: 42,
        stamina: 10,
        armorOnStart: 15,
        wallBounce: 22,
        blockDrain: 22
      });
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, {
        duration: 29,
        activeStart: 8,
        activeEnd: 15,
        damage: 9,
        kb: 18,
        lift: -12,
        width: 128,
        height: 54,
        cooldown: 42,
        stamina: 9,
        wallBounce: 18
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 27,
        activeStart: 7,
        activeEnd: 15,
        damage: 9,
        kb: 16,
        lift: 10,
        width: 124,
        height: 100,
        cooldown: 42,
        stamina: 9,
        wallBounce: 19
      });
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 42,
          activeStart: 10,
          activeEnd: 20,
          damage: 11,
          kb: 27,
          lift: -7,
          width: 210,
          height: 126,
          cooldown: 90,
          stamina: 18,
          armorBreak: true,
          armorOnStart: 26,
          wallBounce: 28,
          blockDrain: 30
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 38,
          activeStart: 9,
          activeEnd: 17,
          damage: 9,
          kb: 15,
          lift: -25,
          width: 120,
          height: 225,
          cooldown: 88,
          stamina: 18,
          armorOnStart: 18,
          wallBounce: 18
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 40,
          activeStart: 11,
          activeEnd: 18,
          damage: 12,
          kb: 25,
          lift: -4,
          width: 180,
          height: 80,
          cooldown: 92,
          stamina: 18,
          armorBreak: true,
          armorOnStart: 24,
          wallBounce: 28,
          blockDrain: 34
        });
      }
    }
  }

  if (piece === "rook") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 17,
        activeStart: 5,
        activeEnd: 11,
        damage: 5,
        kb: 15,
        lift: -2,
        width: 138,
        height: 46,
        cooldown: 18,
        stamina: 4,
        wallBounce: 16
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 31,
        activeStart: 9,
        activeEnd: 17,
        damage: 11,
        kb: 28,
        lift: -6,
        width: 190,
        height: 88,
        cooldown: 50,
        stamina: 11,
        armorBreak: true,
        armorOnStart: 22,
        wallBounce: 34,
        blockDrain: 34
      });
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, {
        duration: 30,
        activeStart: 9,
        activeEnd: 16,
        damage: 10,
        kb: 26,
        lift: -10,
        width: 165,
        height: 50,
        cooldown: 50,
        stamina: 10,
        wallBounce: 32
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 30,
        activeStart: 8,
        activeEnd: 16,
        damage: 10,
        kb: 21,
        lift: 12,
        width: 120,
        height: 96,
        cooldown: 48,
        stamina: 10,
        wallBounce: 28
      });
    }

    if (attack === "special") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 58,
          activeStart: 12,
          activeEnd: 22,
          damage: 13,
          kb: 36,
          lift: -3,
          width: 260,
          height: 92,
          cooldown: 105,
          stamina: 22,
          armorBreak: true,
          armorOnStart: 42,
          wallBounce: 42,
          blockDrain: 40
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 54,
          activeStart: 12,
          activeEnd: 24,
          damage: 8,
          kb: 18,
          lift: -28,
          width: 96,
          height: 305,
          cooldown: 100,
          stamina: 22,
          continuous: true,
          hitInterval: 10,
          armorOnStart: 38,
          wallBounce: 24
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 48,
          activeStart: 10,
          activeEnd: 18,
          damage: 12,
          kb: 34,
          lift: -5,
          width: 250,
          height: 60,
          cooldown: 100,
          stamina: 22,
          armorBreak: true,
          armorOnStart: 36,
          wallBounce: 40,
          blockDrain: 38
        });
      }
    }
  }

  if (piece === "bishop") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 15,
        activeStart: 4,
        activeEnd: 9,
        damage: 4,
        kb: 12,
        lift: -6,
        width: 120,
        height: 78,
        cooldown: 15,
        stamina: 4,
        wallBounce: 12
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 25,
        activeStart: 7,
        activeEnd: 14,
        damage: 9,
        kb: 19,
        lift: -11,
        width: 162,
        height: 106,
        cooldown: 36,
        stamina: 9,
        wallBounce: 20
      });
    }

    if (attack === "crouchLight") {
      Object.assign(m, {
        duration: 14,
        activeStart: 4,
        activeEnd: 8,
        damage: 4,
        kb: 10,
        lift: -2,
        width: 112,
        height: 32,
        cooldown: 14,
        stamina: 3,
        wallBounce: 10
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 26,
        activeStart: 7,
        activeEnd: 14,
        damage: 9,
        kb: 18,
        lift: 9,
        width: 125,
        height: 104,
        cooldown: 36,
        stamina: 9,
        wallBounce: 20
      });
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 36,
          activeStart: 8,
          activeEnd: 16,
          damage: 10,
          kb: 23,
          lift: -10,
          width: 215,
          height: 136,
          cooldown: 78,
          stamina: 17,
          wallBounce: 24
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 36,
          activeStart: 8,
          activeEnd: 16,
          damage: 9,
          kb: 18,
          lift: -27,
          width: 180,
          height: 170,
          cooldown: 78,
          stamina: 17,
          wallBounce: 20
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 36,
          activeStart: 8,
          activeEnd: 16,
          damage: 10,
          kb: 24,
          lift: 10,
          width: 180,
          height: 170,
          cooldown: 78,
          stamina: 17,
          armorBreak: true,
          wallBounce: 26,
          blockDrain: 28
        });
      }
    }
  }

  if (piece === "knight") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 13,
        activeStart: 3,
        activeEnd: 8,
        damage: 4,
        kb: 11,
        lift: -4,
        width: 68,
        height: 50,
        cooldown: 13,
        stamina: 3,
        wallBounce: 12
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 25,
        activeStart: 7,
        activeEnd: 13,
        damage: 8,
        kb: 18,
        lift: -18,
        width: 94,
        height: 92,
        cooldown: 32,
        stamina: 8,
        wallBounce: 20
      });
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, {
        duration: 23,
        activeStart: 7,
        activeEnd: 12,
        damage: 8,
        kb: 18,
        lift: -14,
        width: 90,
        height: 66,
        cooldown: 32,
        stamina: 8,
        wallBounce: 18
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 26,
        activeStart: 7,
        activeEnd: 14,
        damage: 9,
        kb: 21,
        lift: 14,
        width: 104,
        height: 104,
        cooldown: 34,
        stamina: 8,
        wallBounce: 24
      });
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 32,
          activeStart: 6,
          activeEnd: 14,
          damage: 10,
          kb: 25,
          lift: -16,
          width: 122,
          height: 100,
          cooldown: 66,
          stamina: 15,
          wallBounce: 30
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 32,
          activeStart: 6,
          activeEnd: 14,
          damage: 9,
          kb: 17,
          lift: -30,
          width: 108,
          height: 140,
          cooldown: 66,
          stamina: 15,
          wallBounce: 20
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 30,
          activeStart: 6,
          activeEnd: 13,
          damage: 11,
          kb: 28,
          lift: 16,
          width: 128,
          height: 100,
          cooldown: 66,
          stamina: 15,
          armorBreak: true,
          wallBounce: 32,
          blockDrain: 28
        });
      }
    }
  }

  if (piece === "pawn") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 13,
        activeStart: 3,
        activeEnd: 8,
        damage: 4,
        kb: 12,
        lift: -2,
        width: 96,
        height: 30,
        cooldown: 13,
        stamina: 3,
        wallBounce: 12
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 22,
        activeStart: 6,
        activeEnd: 13,
        damage: 8,
        kb: 18,
        lift: -6,
        width: 128,
        height: 60,
        cooldown: 28,
        stamina: 7,
        wallBounce: 18
      });
    }

    if (attack === "crouchLight") {
      Object.assign(m, {
        duration: 13,
        activeStart: 3,
        activeEnd: 8,
        damage: 4,
        kb: 10,
        lift: -1,
        width: 92,
        height: 24,
        cooldown: 13,
        stamina: 3,
        wallBounce: 10
      });
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, {
        duration: 23,
        activeStart: 7,
        activeEnd: 13,
        damage: 8,
        kb: 20,
        lift: -14,
        width: 110,
        height: 56,
        cooldown: 32,
        stamina: 8,
        wallBounce: 22
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 23,
        activeStart: 7,
        activeEnd: 13,
        damage: 8,
        kb: 18,
        lift: 12,
        width: 100,
        height: 82,
        cooldown: 30,
        stamina: 8,
        wallBounce: 20
      });
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 28,
          activeStart: 5,
          activeEnd: 13,
          damage: 9,
          kb: 24,
          lift: -5,
          width: 148,
          height: 48,
          cooldown: 58,
          stamina: 13,
          wallBounce: 26
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 30,
          activeStart: 7,
          activeEnd: 14,
          damage: 8,
          kb: 15,
          lift: -26,
          width: 88,
          height: 140,
          cooldown: 58,
          stamina: 13,
          wallBounce: 18
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 28,
          activeStart: 7,
          activeEnd: 13,
          damage: 9,
          kb: 24,
          lift: -2,
          width: 128,
          height: 56,
          cooldown: 58,
          stamina: 13,
          armorBreak: true,
          wallBounce: 28,
          blockDrain: 28
        });
      }
    }
  }

  if (piece === "queen") {
    if (attack === "light") {
      Object.assign(m, {
        duration: 14,
        activeStart: 3,
        activeEnd: 9,
        damage: 7,
        kb: 15,
        lift: -5,
        width: 150,
        height: 78,
        cooldown: 13,
        stamina: 3,
        wallBounce: 18
      });
    }

    if (attack === "heavy") {
      Object.assign(m, {
        duration: 27,
        activeStart: 7,
        activeEnd: 15,
        damage: 12,
        kb: 26,
        lift: -10,
        width: 210,
        height: 122,
        cooldown: 34,
        stamina: 8,
        armorBreak: true,
        armorOnStart: 12,
        wallBounce: 32,
        blockDrain: 34
      });
    }

    if (attack === "crouchHeavy") {
      Object.assign(m, {
        duration: 28,
        activeStart: 7,
        activeEnd: 15,
        damage: 11,
        kb: 24,
        lift: -16,
        width: 170,
        height: 62,
        cooldown: 36,
        stamina: 8,
        wallBounce: 30
      });
    }

    if (attack === "airHeavy") {
      Object.assign(m, {
        duration: 27,
        activeStart: 7,
        activeEnd: 14,
        damage: 11,
        kb: 22,
        lift: 15,
        width: 150,
        height: 120,
        cooldown: 36,
        stamina: 8,
        wallBounce: 30
      });
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        Object.assign(m, {
          duration: 48,
          activeStart: 9,
          activeEnd: 21,
          damage: 14,
          kb: 34,
          lift: -8,
          width: 320,
          height: 170,
          cooldown: 86,
          stamina: 18,
          armorBreak: true,
          armorOnStart: 22,
          wallBounce: 42,
          blockDrain: 42
        });
      }

      if (aim === "up") {
        Object.assign(m, {
          duration: 46,
          activeStart: 9,
          activeEnd: 20,
          damage: 12,
          kb: 20,
          lift: -34,
          width: 170,
          height: 270,
          cooldown: 86,
          stamina: 18,
          armorBreak: true,
          armorOnStart: 20,
          wallBounce: 28
        });
      }

      if (aim === "down") {
        Object.assign(m, {
          duration: 46,
          activeStart: 9,
          activeEnd: 20,
          damage: 13,
          kb: 32,
          lift: 12,
          width: 280,
          height: 100,
          cooldown: 86,
          stamina: 18,
          armorBreak: true,
          armorOnStart: 20,
          wallBounce: 40,
          blockDrain: 40
        });
      }
    }
  }

  return m;
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

function centeredBox(f, width, height, yOffset = 0) {
  return {
    x: f.x + f.width / 2 - width / 2,
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

function attackBox(f) {
  const piece = effectivePiece(f);
  const attack = f.attack;
  const aim = f.attackAim || "forward";

  if (piece === "king") {
    if (attack === "light") return forwardBox(f, 92, 48, 30);
    if (attack === "heavy") return forwardBox(f, 132, 80, 18);
    if (attack === "crouchHeavy") return forwardBox(f, 128, 54, f.height * 0.52);
    if (attack === "airHeavy") return bodyForwardBox(f, 124, 100, 24, 18);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 120, 225, 0);
      if (aim === "down") return bodyForwardBox(f, 180, 80, f.height * 0.52, 24);
      return bodyForwardBox(f, 210, 126, -4, 44);
    }
  }

  if (piece === "rook") {
    if (attack === "light") return forwardBox(f, 138, 46, 40);
    if (attack === "heavy") return forwardBox(f, 190, 88, 24);
    if (attack === "crouchHeavy") return forwardBox(f, 165, 50, f.height * 0.55);
    if (attack === "airHeavy") return forwardBox(f, 120, 96, 20);

    if (attack === "special") {
      if (aim === "up") return upBox(f, 96, 305, 0);
      if (aim === "down") return forwardBox(f, 250, 60, f.height * 0.62);
      return forwardBox(f, 260, 92, 24);
    }
  }

  if (piece === "bishop") {
    if (attack === "light") return forwardBox(f, 120, 78, 16);
    if (attack === "heavy") return forwardBox(f, 162, 106, 6);
    if (attack === "crouchLight") return forwardBox(f, 112, 32, f.height * 0.65);
    if (attack === "airHeavy") return forwardBox(f, 125, 104, 12);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return diagonalBox(f, 180, 170, -138, 28);
      if (aim === "down") return diagonalBox(f, 180, 170, 42, 28);
      return diagonalBox(f, 215, 136, -12, 24);
    }
  }

  if (piece === "knight") {
    if (attack === "light") return forwardBox(f, 68, 50, 30);
    if (attack === "heavy") return bodyForwardBox(f, 94, 92, -8, 24);
    if (attack === "crouchHeavy") return forwardBox(f, 90, 66, f.height * 0.44);
    if (attack === "airHeavy") return forwardBox(f, 104, 104, 18);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 108, 140, 8);
      if (aim === "down") return bodyForwardBox(f, 128, 100, f.height * 0.32, 38);
      return bodyForwardBox(f, 122, 100, 2, 45);
    }
  }

  if (piece === "pawn") {
    if (attack === "light") return forwardBox(f, 96, 30, 40);
    if (attack === "heavy") return forwardBox(f, 128, 60, 26);
    if (attack === "crouchLight") return forwardBox(f, 92, 24, f.height * 0.66);
    if (attack === "crouchHeavy") return forwardBox(f, 110, 56, f.height * 0.46);
    if (attack === "airHeavy") return forwardBox(f, 100, 82, 16);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 88, 140, 8);
      if (aim === "down") return forwardBox(f, 128, 56, f.height * 0.58);
      return forwardBox(f, 148, 48, 30);
    }
  }

  if (piece === "queen") {
    if (attack === "light") return forwardBox(f, 150, 78, 18);
    if (attack === "heavy") return forwardBox(f, 210, 122, -6);
    if (attack === "crouchHeavy") return forwardBox(f, 170, 62, f.height * 0.46);
    if (attack === "airHeavy") return forwardBox(f, 150, 120, 8);

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "up") return upBox(f, 170, 270, 0);
      if (aim === "down") return forwardBox(f, 280, 100, f.height * 0.34);
      return bodyForwardBox(f, 320, 170, -18, 48);
    }
  }

  return forwardBox(f, 70, 50, 20);
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
    jumpMul = 1.35;
    xMul = 1.9;
  }

  if (piece === "rook") {
    jumpMul = 0.75;
    xMul = 1.35;
  }

  if (piece === "bishop") {
    jumpMul = 1.1;
    xMul = 1.8;
  }

  if (piece === "queen") {
    jumpMul = 1.2;
    xMul = 1.9;
  }

  f.vx = -f.wallSide * f.speed * xMul;
  f.vy = -f.jump * 0.92 * jumpMul;
  f.facing = -f.wallSide;
  f.attackFacing = f.facing;
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
  f.attackFacing = f.facing || 1;
  f.attackTimer = meta.duration;
  f.attackDuration = meta.duration;
  f.hitThisAttack = false;
  f.multiHitCooldown = 0;

  if (baseType === "light") f.lightCooldown = meta.cooldown;
  if (baseType === "heavy") f.heavyCooldown = meta.cooldown;
  if (baseType === "special") f.specialCooldown = meta.cooldown;

  if (meta.armorOnStart > 0) {
    f.armorTimer = Math.max(f.armorTimer, meta.armorOnStart);
  }

  const piece = effectivePiece(f);

  if (piece === "king") {
    if (attack === "light") f.vx += f.facing * 1.7;
    if (attack === "heavy") f.vx += f.facing * 3.4;
    if (attack === "crouchHeavy") f.vx += f.facing * 2.9;

    if (attack === "airHeavy") {
      f.vy += 4.3;
      f.vx += f.facing * 2.1;
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 3.2;

      if (aim === "up") {
        f.vy = Math.min(f.vy, -7.6);
        f.grounded = false;
      }

      if (aim === "down") f.vx += f.facing * 3.8;
    }
  }

  if (piece === "rook") {
    if (attack === "light") f.vx += f.facing * 1.4;
    if (attack === "heavy") f.vx += f.facing * 4.1;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.2;

    if (attack === "airHeavy") {
      f.vy += 5.2;
      f.vx += f.facing * 1.4;
    }

    if (attack === "special") {
      if (aim === "forward") f.vx += f.facing * 5.8;

      if (aim === "up") {
        f.vx *= 0.08;
        f.vy = Math.min(f.vy, -2.2);
      }

      if (aim === "down") f.vx += f.facing * 7.2;
    }
  }

  if (piece === "bishop") {
    if (attack === "light") f.vx += f.facing * 1.6;
    if (attack === "heavy") f.vx += f.facing * 2.4;
    if (attack === "airHeavy") f.vx += f.facing * 2.1;

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        f.vx += f.facing * 8.2;
        f.vy = -4.4;
        f.grounded = false;
      }

      if (aim === "up") {
        f.vx += f.facing * 4.4;
        f.vy = -12.6;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 6.6;
        f.vy += 7.8;
      }
    }
  }

  if (piece === "knight") {
    if (attack === "light") f.vx += f.facing * 1.5;

    if (attack === "heavy") {
      f.vx += f.facing * 1.3;
      f.vy = Math.min(f.vy, -10.2);
      f.grounded = false;
    }

    if (attack === "crouchHeavy") {
      f.vx -= f.facing * 1.8;
      f.vy = Math.min(f.vy, -5.5);
      f.grounded = false;
    }

    if (attack === "airHeavy") {
      f.vx += f.facing * 2.8;
      f.vy += 3.2;
    }

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") {
        f.vx += f.facing * 10.6;
        f.vy = -12.0;
        f.grounded = false;
      }

      if (aim === "up") {
        f.vx -= f.facing * 3.4;
        f.vy = -17.2;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 11.2;
        f.vy += 10.8;
      }
    }
  }

  if (piece === "pawn") {
    if (attack === "light") f.vx += f.facing * 1.8;
    if (attack === "heavy") f.vx += f.facing * 3.3;

    if (attack === "crouchHeavy") {
      f.vx += f.facing * 4.1;
      f.vy = Math.min(f.vy, -5.4);
      f.grounded = false;
    }

    if (attack === "airHeavy") f.vx += f.facing * 2.5;

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 9.4;

      if (aim === "up") {
        f.vx += f.facing * 2.4;
        f.vy = -12.8;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 6.4;
        f.vy = Math.min(f.vy, -2.8);
      }

      chargePawn(f, 6);
    }
  }

  if (piece === "queen") {
    if (attack === "light") f.vx += f.facing * 2.2;
    if (attack === "heavy") f.vx += f.facing * 4.4;
    if (attack === "crouchHeavy") f.vx += f.facing * 3.2;
    if (attack === "airHeavy") f.vx += f.facing * 2.8;

    if (attack === "special" || attack === "airSpecial") {
      if (aim === "forward") f.vx += f.facing * 7.4;

      if (aim === "up") {
        f.vy = -13.6;
        f.grounded = false;
      }

      if (aim === "down") {
        f.vx += f.facing * 9.2;
        f.vy += 6.8;
      }
    }
  }

  pushEffect(game, "moveStart", f.x + f.width / 2, f.y + f.height / 2, {
    timer: 10,
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
    f.attackFacing = dir;
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

  if (!f.attack) {
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
  let kb = meta.kb * GLOBAL_KNOCKBACK_MULT;
  let lift = meta.lift * GLOBAL_LIFT_MULT;

  const comboScale = clamp(1 - defender.comboCount * 0.07, 0.58, 1);
  damage = Math.ceil(damage * comboScale);
  kb *= clamp(1 - defender.comboCount * 0.04, 0.7, 1);

  const defenderFacingAttack = defender.facing === -attacker.attackFacing;
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
    attacker.vx -= attacker.attackFacing * 6.5;
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

    if (defenderPiece === "king") {
      blockReduction = 0.18;
      blockKb = 0.24;
      drain *= 0.75;
    }

    if (defenderPiece === "rook") {
      blockReduction = 0.2;
      blockKb = 0.28;
      drain *= 0.82;
    }

    if (defenderPiece === "queen") {
      blockReduction = 0.16;
      blockKb = 0.23;
      drain *= 0.7;
    }

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
  defender.vx += attacker.attackFacing * kb;
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