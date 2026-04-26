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
const GRAVITY = 0.75;

const players = {};
const lobbies = {};
const leaderboard = {};

let nextLobbyId = 1;

const CHARACTERS = {
  striker: {
    name: "Striker",
    maxHp: 100,
    speed: 5.2,
    jump: 15,
    lightDamage: 6,
    heavyDamage: 13,
    specialDamage: 10,
    width: 44,
    height: 92,
    reach: 62
  },
  brute: {
    name: "Brute",
    maxHp: 130,
    speed: 3.8,
    jump: 13,
    lightDamage: 8,
    heavyDamage: 17,
    specialDamage: 12,
    width: 58,
    height: 104,
    reach: 68
  },
  viper: {
    name: "Viper",
    maxHp: 85,
    speed: 6.4,
    jump: 16,
    lightDamage: 5,
    heavyDamage: 11,
    specialDamage: 15,
    width: 38,
    height: 86,
    reach: 58
  },
  mirror: {
    name: "Mirror",
    maxHp: 100,
    speed: 4.8,
    jump: 14,
    lightDamage: 7,
    heavyDamage: 12,
    specialDamage: 13,
    width: 42,
    height: 90,
    reach: 60
  }
};

function makeId() {
  return String(nextLobbyId++);
}

function cleanName(name) {
  return String(name || "Nameless").trim().slice(0, 18) || "Nameless";
}

function getCharacter(key) {
  return CHARACTERS[key] || CHARACTERS.striker;
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
    color: side === "red" ? "#ff3e3e" : "#3e89ff",

    x: side === "red" ? 220 : 700,
    y: FLOOR_Y - ch.height,
    vx: 0,
    vy: 0,

    width: ch.width,
    height: ch.height,
    maxHp: ch.maxHp,
    hp: ch.maxHp,
    speed: ch.speed,
    jump: ch.jump,
    reach: ch.reach,

    facing: side === "red" ? 1 : -1,
    grounded: true,
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

    hurtTimer: 0,
    wins: 0
  };
}

function createGame(lobby) {
  lobby.status = "playing";
  lobby.winner = null;
  lobby.message = "Fight!";

  lobby.game = {
    width: WIDTH,
    height: HEIGHT,
    floorY: FLOOR_Y,
    startedAt: Date.now(),
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

function attackBox(f) {
  const range = f.attack === "heavy" ? f.reach + 22 : f.reach;
  const height = f.attack === "special" ? f.height * 0.75 : f.height * 0.55;

  if (f.facing === 1) {
    return {
      x: f.x + f.width,
      y: f.y + 18,
      width: range,
      height
    };
  }

  return {
    x: f.x - range,
    y: f.y + 18,
    width: range,
    height
  };
}

function startAttack(f, type) {
  if (f.attack) return;

  if (type === "light") {
    if (f.lightCooldown > 0) return;
    f.attack = "light";
    f.attackTimer = 14;
    f.hitThisAttack = false;
    f.lightCooldown = 20;
  }

  if (type === "heavy") {
    if (f.heavyCooldown > 0) return;
    f.attack = "heavy";
    f.attackTimer = 26;
    f.hitThisAttack = false;
    f.heavyCooldown = 48;
  }

  if (type === "special") {
    if (f.specialCooldown > 0) return;
    f.attack = "special";
    f.attackTimer = 34;
    f.hitThisAttack = false;
    f.specialCooldown = 90;
  }
}

function damageFor(f) {
  if (f.attack === "light") return f.lightDamage;
  if (f.attack === "heavy") return f.heavyDamage;
  if (f.attack === "special") return f.specialDamage;
  return 0;
}

function knockbackFor(f) {
  if (f.attack === "light") return 6;
  if (f.attack === "heavy") return 12;
  if (f.attack === "special") return 15;
  return 0;
}

function updateFighter(f, opponent, input) {
  const left = input.left;
  const right = input.right;
  const jump = input.jump;
  const block = input.block;

  if (f.hurtTimer > 0) f.hurtTimer--;

  f.blocking = block && f.grounded && !f.attack;

  if (!f.attack && f.hurtTimer <= 8) {
    if (left && !right) f.vx = -f.speed;
    else if (right && !left) f.vx = f.speed;
    else f.vx *= 0.72;
  } else {
    f.vx *= 0.84;
  }

  if (jump && f.grounded && !f.blocking && !f.attack) {
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

  const activeWindow =
    attacker.attack === "light"
      ? attacker.attackTimer <= 10 && attacker.attackTimer >= 4
      : attacker.attack === "heavy"
      ? attacker.attackTimer <= 16 && attacker.attackTimer >= 5
      : attacker.attackTimer <= 22 && attacker.attackTimer >= 6;

  if (!activeWindow) return;

  if (!rectsOverlap(attackBox(attacker), defender)) return;

  let dmg = damageFor(attacker);
  let kb = knockbackFor(attacker);

  if (defender.blocking && defender.facing === -attacker.facing) {
    dmg = Math.ceil(dmg * 0.25);
    kb *= 0.4;
  } else {
    defender.hurtTimer = 18;
  }

  defender.hp = Math.max(0, defender.hp - dmg);
  defender.vx += attacker.facing * kb;
  defender.vy -= attacker.attack === "heavy" ? 4 : 2;

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
    lobby.message = `${winnerName} wins!`;
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
    characterKey: "striker",
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
      name: String(lobbyName || `${players[socket.id].name}'s Lobby`).trim().slice(0, 28),
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
    lobby.message = "Fight!";

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