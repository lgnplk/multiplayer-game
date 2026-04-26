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

const players = {};
const lobbies = {};
const leaderboard = {};

let nextLobbyId = 1;

const CHARACTERS = {
  king: {
    name: "King",
    title: "Balanced royal bruiser",
    maxHp: 115,
    speed: 4.8,
    jump: 14,
    width: 48,
    height: 98,
    reach: 64,
    lightDamage: 7,
    heavyDamage: 14,
    specialDamage: 16
  },
  knight: {
    name: "Knight",
    title: "Fast aerial attacker",
    maxHp: 95,
    speed: 6.1,
    jump: 17,
    width: 44,
    height: 92,
    reach: 58,
    lightDamage: 6,
    heavyDamage: 12,
    specialDamage: 15
  },
  bishop: {
    name: "Bishop",
    title: "Long diagonal blade",
    maxHp: 90,
    speed: 5.2,
    jump: 15,
    width: 42,
    height: 96,
    reach: 78,
    lightDamage: 5,
    heavyDamage: 13,
    specialDamage: 17
  },
  rook: {
    name: "Rook",
    title: "Slow armored wall",
    maxHp: 140,
    speed: 3.7,
    jump: 12,
    width: 62,
    height: 108,
    reach: 70,
    lightDamage: 8,
    heavyDamage: 18,
    specialDamage: 19
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
    p1Name: players[lobby.p1]?.name || null,
    p2Name: players[lobby.p2]?.name || null,
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

function createFighter(socketId, side, characterKey) {
  const ch = getCharacter(characterKey);

  return {
    id: socketId,
    name: players[socketId]?.name || "Unknown",
    side,
    characterKey,
    characterName: ch.name,
    color: side === "red" ? "#e53935" : "#2f7cff",

    x: side === "red" ? 220 : 700,
    y: FLOOR_Y - ch.height,
    vx: 0,
    vy: 0,

    width: ch.width,
    standingHeight: ch.height,
    crouchHeight: Math.floor(ch.height * 0.62),
    height: ch.height,

    maxHp: ch.maxHp,
    hp: ch.maxHp,
    speed: ch.speed,
    jump: ch.jump,
    reach: ch.reach,

    facing: side === "red" ? 1 : -1,
    grounded: true,
    crouching: false,
    blocking: false,

    lightDamage: ch.lightDamage,
    heavyDamage: ch.heavyDamage,
    specialDamage: ch.specialDamage,

    attack: null,
    attackTimer: 0,
    hitThisAttack: false,

    lightCooldown: 0,
    heavyCooldown: 0,
    specialCooldown: 0,

    hurtTimer: 0
  };
}

function createGame(lobby) {
  lobby.status = "playing";
  lobby.winner = null;
  lobby.message = "The board is set. Fight.";

  lobby.game = {
    width: WIDTH,
    height: HEIGHT,
    floorY: FLOOR_Y,
    roundOver: false,
    roundOverTimer: 0,
    fighters: {
      red: createFighter(lobby.p1, "red", players[lobby.p1].characterKey),
      blue: createFighter(lobby.p2, "blue", players[lobby.p2].characterKey)
    }
  };
}

function resetLobbyAfterFight(lobby) {
  lobby.status = "finished";
  lobby.game = null;
}

function joinSocketRoom(socket, lobbyId) {
  socket.join(`lobby:${lobbyId}`);
}

function leaveCurrentLobby(socketId) {
  const player = players[socketId];
  if (!player || !player.lobbyId) return;

  const lobby = lobbies[player.lobbyId];
  if (!lobby) {
    player.lobbyId = null;
    player.role = "menu";
    return;
  }

  lobby.spectators.delete(socketId);

  if (lobby.p1 === socketId) lobby.p1 = null;
  if (lobby.p2 === socketId) lobby.p2 = null;

  if (lobby.status === "playing") {
    const remainingId = lobby.p1 || lobby.p2;

    if (remainingId && players[remainingId]) {
      const winnerName = players[remainingId].name;
      leaderboard[winnerName] = (leaderboard[winnerName] || 0) + 1;
      lobby.winner = winnerName;
      lobby.message = `${winnerName} wins because the opponent disconnected.`;
    }

    resetLobbyAfterFight(lobby);
  }

  if (!lobby.p1 && !lobby.p2 && lobby.spectators.size === 0) {
    delete lobbies[lobby.id];
  }

  player.lobbyId = null;
  player.role = "menu";
}

function sendGameState(lobby) {
  if (!lobby) return;

  io.to(`lobby:${lobby.id}`).emit("gameState", {
    lobby: {
      id: lobby.id,
      name: lobby.name,
      status: lobby.status,
      p1Name: players[lobby.p1]?.name || null,
      p2Name: players[lobby.p2]?.name || null,
      winner: lobby.winner,
      message: lobby.message
    },
    game: lobby.game,
    leaderboard: publicLeaderboard()
  });
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
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

function getAttackDuration(type) {
  const durations = {
    light: 14,
    heavy: 28,
    special: 38,
    crouchLight: 16,
    crouchHeavy: 31,
    airLight: 18,
    airHeavy: 30,
    airSpecial: 34
  };

  return durations[type] || 20;
}

function getCooldown(type) {
  const cooldowns = {
    light: 19,
    heavy: 48,
    special: 96,
    crouchLight: 24,
    crouchHeavy: 58,
    airLight: 28,
    airHeavy: 64,
    airSpecial: 105
  };

  return cooldowns[type] || 30;
}

function getDamage(f) {
  const multipliers = {
    light: 1,
    heavy: 1,
    special: 1,
    crouchLight: 0.8,
    crouchHeavy: 1.15,
    airLight: 0.9,
    airHeavy: 1.25,
    airSpecial: 1.35
  };

  let base = f.lightDamage;

  if (f.attack.includes("Heavy")) base = f.heavyDamage;
  else if (f.attack.includes("Special")) base = f.specialDamage;
  else if (f.attack === "heavy") base = f.heavyDamage;
  else if (f.attack === "special") base = f.specialDamage;

  return Math.ceil(base * (multipliers[f.attack] || 1));
}

function getKnockback(f) {
  const values = {
    light: 6,
    heavy: 13,
    special: 16,
    crouchLight: 4,
    crouchHeavy: 15,
    airLight: 7,
    airHeavy: 13,
    airSpecial: 18
  };

  return values[f.attack] || 8;
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

function updateFighter(f, opponent, input) {
  if (f.hurtTimer > 0) f.hurtTimer--;

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

  const defenderFacingAttack =
    defender.facing === -attacker.facing;

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

  attacker.hitThisAttack = true;
}

function updateGame(lobby) {
  if (!lobby || lobby.status !== "playing" || !lobby.game) return;

  const game = lobby.game;
  const red = game.fighters.red;
  const blue = game.fighters.blue;

  if (game.roundOver) {
    game.roundOverTimer--;

    if (game.roundOverTimer <= 0) {
      resetLobbyAfterFight(lobby);
      sendGameState(lobby);
      sendLobbyData();
    }

    return;
  }

  const redInput = players[red.id]?.input || {};
  const blueInput = players[blue.id]?.input || {};

  updateFighter(red, blue, redInput);
  updateFighter(blue, red, blueInput);

  handleHit(red, blue);
  handleHit(blue, red);

  if (red.hp <= 0 || blue.hp <= 0) {
    game.roundOver = true;
    game.roundOverTimer = 180;

    const winnerSide = red.hp > blue.hp ? "red" : "blue";
    const winner = game.fighters[winnerSide];
    const winnerName = winner.name;

    lobby.winner = winnerName;
    lobby.message = `Checkmate. ${winnerName} wins.`;
    leaderboard[winnerName] = (leaderboard[winnerName] || 0) + 1;
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
      p1: socket.id,
      p2: null,
      spectators: new Set(),
      status: "waiting",
      game: null,
      winner: null,
      message: "Waiting for player 2..."
    };

    players[socket.id].lobbyId = id;
    players[socket.id].role = "p1";

    joinSocketRoom(socket, id);

    socket.emit("enteredLobby", { lobbyId: id, role: "p1" });

    sendGameState(lobbies[id]);
    sendLobbyData();
  });

  socket.on("joinLobby", (lobbyId) => {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.status !== "waiting" || lobby.p2) return;

    leaveCurrentLobby(socket.id);

    lobby.p2 = socket.id;
    lobby.status = "playing";
    lobby.message = "The board is set. Fight.";

    players[socket.id].lobbyId = lobbyId;
    players[socket.id].role = "p2";

    joinSocketRoom(socket, lobbyId);

    createGame(lobby);

    socket.emit("enteredLobby", { lobbyId, role: "p2" });

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