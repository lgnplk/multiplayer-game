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

const players = {};
const lobbies = {};
const leaderboard = {};

let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Balanced royal fighter",
    maxHp: 180,
    speed: 4.7,
    jump: 14,
    width: 60,
    height: 110,
    reach: 58,
    lightDamage: 5,
    heavyDamage: 10,
    specialDamage: 12
  },
  knight: {
    name: "Knight",
    title: "Fast aerial fighter",
    maxHp: 155,
    speed: 6.1,
    jump: 17,
    width: 58,
    height: 106,
    reach: 54,
    lightDamage: 4,
    heavyDamage: 9,
    specialDamage: 11
  },
  bishop: {
    name: "Bishop",
    title: "Long diagonal striker",
    maxHp: 160,
    speed: 5.2,
    jump: 15,
    width: 56,
    height: 110,
    reach: 74,
    lightDamage: 4,
    heavyDamage: 10,
    specialDamage: 12
  },
  rook: {
    name: "Rook",
    title: "Slow wall with huge health",
    maxHp: 220,
    speed: 3.7,
    jump: 12,
    width: 70,
    height: 118,
    reach: 66,
    lightDamage: 5,
    heavyDamage: 12,
    specialDamage: 13
  },
  pawn: {
    name: "Pawn",
    title: "Promotes into a queen over time",
    maxHp: 145,
    speed: 4.9,
    jump: 14,
    width: 52,
    height: 98,
    reach: 50,
    lightDamage: 4,
    heavyDamage: 8,
    specialDamage: 9
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

function roomName(lobbyId) {
  return `lobby:${lobbyId}`;
}

function getSocket(socketId) {
  return io.sockets.sockets.get(socketId);
}

function pieceDisplayName(f) {
  if (f.characterKey === "pawn" && f.promoted) return "Queen";
  return f.characterName;
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

    hurtTimer: 0
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

function joinSocketRoom(socket, lobbyId) {
  socket.join(roomName(lobbyId));
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
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

function getCooldown(type) {
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

  return cooldowns[type] || 30;
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

  const cooldown = getCooldown(type);

  if (baseType === "light" && f.lightCooldown > 0) return;
  if (baseType === "heavy" && f.heavyCooldown > 0) return;
  if (baseType === "special" && f.specialCooldown > 0) return;

  f.attack = type;
  f.attackTimer = getAttackDuration(type);
  f.hitThisAttack = false;

  if (baseType === "light") f.lightCooldown = cooldown;
  if (baseType === "heavy") f.heavyCooldown = cooldown;
  if (baseType === "special") f.specialCooldown = cooldown;

  if (type === "airSpecial") {
    f.vx += f.facing * 7;
    f.vy += 2;
  }

  if (type === "crouchHeavy") {
    f.vx += f.facing * 2.5;
  }

  if (type === "special" && f.characterKey === "rook") {
    f.vx += f.facing * 8;
  }

  if (type === "special" && f.characterKey === "knight") {
    f.vy = -10;
    f.grounded = false;
  }
}

function getDamage(f) {
  const multipliers = {
    light: 1,
    heavy: 1,
    special: 1,
    crouchLight: 0.85,
    crouchHeavy: 1.15,
    airLight: 0.95,
    airHeavy: 1.2,
    airSpecial: 1.25
  };

  let base = f.lightDamage;

  if (f.attack === "heavy" || f.attack === "crouchHeavy" || f.attack === "airHeavy") {
    base = f.heavyDamage;
  } else if (f.attack === "special" || f.attack === "airSpecial") {
    base = f.specialDamage;
  }

  return Math.ceil(base * (multipliers[f.attack] || 1));
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

  if (f.attack === "light") return t <= 10 && t >= 4;
  if (f.attack === "heavy") return t <= 17 && t >= 5;
  if (f.attack === "special") return t <= 24 && t >= 7;

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

  let range = f.reach;
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
  f.promotionMeter = 100;

  f.maxHp += 18;
  f.hp = Math.min(f.maxHp, f.hp + 18);
  f.speed += 0.8;
  f.jump += 1.5;
  f.reach += 22;
  f.lightDamage += 2;
  f.heavyDamage += 3;
  f.specialDamage += 4;
  f.characterName = "Queen";
}

function chargePawn(f, amount) {
  if (f.characterKey !== "pawn" || f.promoted) return;

  f.promotionMeter = Math.min(100, f.promotionMeter + amount);

  if (f.promotionMeter >= 100) {
    promotePawn(f);
  }
}

function updateFighter(f, opponent, input) {
  if (f.hurtTimer > 0) f.hurtTimer--;

  if (f.characterKey === "pawn" && !f.promoted) {
    chargePawn(f, 0.045);
  }

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

  if (input.jump && f.grounded && !f.blocking && !f.attack && !f.crouching) {
    f.vy = -f.jump;
    f.grounded = false;
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

  f.x = Math.max(20, Math.min(WIDTH - f.width - 20, f.x));

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
}

function handleHit(attacker, defender) {
  if (!attacker.attack || attacker.hitThisAttack) return;
  if (!activeWindow(attacker)) return;
  if (!rectsOverlap(attackBox(attacker), defender)) return;

  let dmg = getDamage(attacker);
  let kb = getKnockback(attacker);

  const defenderFacingAttack = defender.facing === -attacker.facing;

  if (defender.blocking && defenderFacingAttack) {
    dmg = Math.ceil(dmg * 0.25);
    kb *= 0.35;
  } else {
    defender.hurtTimer = 20;
  }

  defender.hp = Math.max(0, defender.hp - dmg);
  defender.vx += attacker.facing * kb;

  if (attacker.attack === "crouchHeavy") {
    defender.vy -= 7;
  } else if (attacker.attack === "airHeavy" || attacker.attack === "airSpecial") {
    defender.vy += 4;
  } else {
    defender.vy -= 2.5;
  }

  if (attacker.characterKey === "pawn") {
    chargePawn(attacker, 10);
  }

  if (defender.characterKey === "pawn") {
    chargePawn(defender, 4);
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

    if (lobby.match.whiteRounds >= lobby.match.roundsToWin || lobby.match.blackRounds >= lobby.match.roundsToWin) {
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