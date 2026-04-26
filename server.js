const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const players = {};
let chatLog = [];
let roundNumber = 0;
let currentRound = null;
let lastOutcome = null;

const COLORS = ["Crimson", "Indigo", "Gold", "Violet"];
const SHAPES = ["Circle", "Triangle", "Square", "Star"];
const WORDS = ["MIRROR", "CLOCK", "ASH", "ECHO"];
const TONES = ["warm", "cold", "silent", "restless"];

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function makeArtifacts() {
  const colors = shuffle(COLORS);
  const shapes = shuffle(SHAPES);
  const words = shuffle(WORDS);
  const tones = shuffle(TONES);

  return [0, 1, 2, 3].map((i) => ({
    index: i,
    color: colors[i],
    shape: shapes[i],
    word: words[i],
    tone: tones[i]
  }));
}

function makeTrueClue(artifacts, targetIndex) {
  const target = artifacts[targetIndex];

  const clueTypes = [
    () => `The correct door is ${target.color}.`,
    () => `The correct door bears the ${target.shape}.`,
    () => `The correct door whispers the word ${target.word}.`,
    () => `The correct door feels ${target.tone}.`,
    () => {
      const wrong = randomFrom(artifacts.filter((a) => a.index !== targetIndex));
      return `The correct door is not ${wrong.color}.`;
    },
    () => {
      const wrong = randomFrom(artifacts.filter((a) => a.index !== targetIndex));
      return `The correct door does not bear the ${wrong.shape}.`;
    },
    () => {
      const wrong = randomFrom(artifacts.filter((a) => a.index !== targetIndex));
      return `Ignore the word ${wrong.word}.`;
    }
  ];

  return randomFrom(clueTypes)();
}

function makeFalseClue(artifacts, targetIndex) {
  const wrong = randomFrom(artifacts.filter((a) => a.index !== targetIndex));

  const clueTypes = [
    () => `The correct door is ${wrong.color}.`,
    () => `The correct door bears the ${wrong.shape}.`,
    () => `The correct door whispers the word ${wrong.word}.`,
    () => `The correct door feels ${wrong.tone}.`,
    () => {
      const target = artifacts[targetIndex];
      return `The correct door is not ${target.color}.`;
    },
    () => {
      const target = artifacts[targetIndex];
      return `The correct door does not bear the ${target.shape}.`;
    },
    () => {
      const target = artifacts[targetIndex];
      return `Ignore the word ${target.word}.`;
    }
  ];

  return randomFrom(clueTypes)();
}

function makePrivateClues(playerIds, artifacts, targetIndex) {
  const clues = {};

  const shuffledIds = shuffle(playerIds);

  shuffledIds.forEach((id, i) => {
    let signal;
    let text;
    let reliable;

    if (shuffledIds.length >= 3 && i === shuffledIds.length - 1) {
      signal = "FRACTURED";
      reliable = false;
      text = makeFalseClue(artifacts, targetIndex);
    } else if (i % 3 === 1) {
      signal = "HAZY";
      reliable = true;
      text = makeTrueClue(artifacts, targetIndex);
    } else {
      signal = "CLEAR";
      reliable = true;
      text = makeTrueClue(artifacts, targetIndex);
    }

    clues[id] = {
      signal,
      text,
      reliable
    };
  });

  return clues;
}

function publicPlayers() {
  const result = {};
  for (const id in players) {
    result[id] = {
      name: players[id].name,
      color: players[id].color,
      score: players[id].score,
      connected: true
    };
  }
  return result;
}

function sendState() {
  if (!currentRound) return;

  const publicRound = {
    number: currentRound.number,
    artifacts: currentRound.artifacts,
    votes: currentRound.votes,
    phase: currentRound.phase
  };

  io.emit("state", {
    players: publicPlayers(),
    round: publicRound,
    chatLog,
    lastOutcome
  });

  for (const id in players) {
    io.to(id).emit("privateClue", currentRound.clues[id] || null);
  }
}

function startNewRound() {
  const ids = Object.keys(players);

  if (ids.length === 0) {
    currentRound = null;
    return;
  }

  roundNumber++;

  const artifacts = makeArtifacts();
  const targetIndex = Math.floor(Math.random() * 4);
  const clues = makePrivateClues(ids, artifacts, targetIndex);

  currentRound = {
    number: roundNumber,
    artifacts,
    targetIndex,
    clues,
    votes: {},
    phase: "playing"
  };

  lastOutcome = null;

  chatLog.push({
    system: true,
    text: `Round ${roundNumber} begins. New private clues have been distributed.`
  });

  if (chatLog.length > 40) chatLog = chatLog.slice(-40);

  sendState();
}

function resolveRound() {
  if (!currentRound || currentRound.phase !== "playing") return;

  currentRound.phase = "revealed";

  const votes = Object.values(currentRound.votes);
  const counts = [0, 0, 0, 0];

  for (const vote of votes) {
    counts[vote]++;
  }

  let chosenIndex = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[chosenIndex]) {
      chosenIndex = i;
    }
  }

  const correct = chosenIndex === currentRound.targetIndex;
  const correctDoor = currentRound.artifacts[currentRound.targetIndex];
  const chosenDoor = currentRound.artifacts[chosenIndex];

  for (const id in currentRound.votes) {
    if (!players[id]) continue;

    if (currentRound.votes[id] === currentRound.targetIndex) {
      players[id].score += 2;
    } else if (correct) {
      players[id].score += 1;
    }
  }

  lastOutcome = {
    correct,
    chosenIndex,
    targetIndex: currentRound.targetIndex,
    chosenDoor,
    correctDoor,
    clues: Object.fromEntries(
      Object.entries(currentRound.clues).map(([id, clue]) => [
        id,
        {
          name: players[id]?.name || "Unknown",
          signal: clue.signal,
          text: clue.text,
          reliable: clue.reliable
        }
      ])
    )
  };

  chatLog.push({
    system: true,
    text: correct
      ? `The group chose correctly. The room opens.`
      : `The group chose wrong. The room remembers.`
  });

  sendState();

  setTimeout(() => {
    startNewRound();
  }, 8000);
}

function maybeResolveRound() {
  if (!currentRound || currentRound.phase !== "playing") return;

  const ids = Object.keys(players);
  if (ids.length === 0) return;

  const everyoneVoted = ids.every((id) => currentRound.votes[id] !== undefined);

  if (everyoneVoted) {
    resolveRound();
  }
}

function randomPlayerColor() {
  return randomFrom([
    "#ff4d4d",
    "#4da6ff",
    "#70ff70",
    "#ffcc4d",
    "#d580ff",
    "#4dffd2",
    "#ffffff"
  ]);
}

io.on("connection", (socket) => {
  players[socket.id] = {
    name: `Player ${Object.keys(players).length + 1}`,
    color: randomPlayerColor(),
    score: 0
  };

  socket.on("setName", (name) => {
    const cleaned = String(name || "").trim().slice(0, 18);
    players[socket.id].name = cleaned || players[socket.id].name;

    chatLog.push({
      system: true,
      text: `${players[socket.id].name} entered the room.`
    });

    if (!currentRound) {
      startNewRound();
    } else {
      currentRound.clues = makePrivateClues(
        Object.keys(players),
        currentRound.artifacts,
        currentRound.targetIndex
      );
      sendState();
    }
  });

  socket.on("chat", (message) => {
    if (!players[socket.id]) return;

    const text = String(message || "").trim().slice(0, 200);
    if (!text) return;

    chatLog.push({
      system: false,
      name: players[socket.id].name,
      color: players[socket.id].color,
      text
    });

    if (chatLog.length > 40) {
      chatLog = chatLog.slice(-40);
    }

    sendState();
  });

  socket.on("vote", (doorIndex) => {
    if (!currentRound || currentRound.phase !== "playing") return;
    if (!players[socket.id]) return;

    const index = Number(doorIndex);
    if (!Number.isInteger(index) || index < 0 || index > 3) return;

    currentRound.votes[socket.id] = index;

    chatLog.push({
      system: true,
      text: `${players[socket.id].name} has chosen a door.`
    });

    sendState();
    maybeResolveRound();
  });

  socket.on("forceNewRound", () => {
    startNewRound();
  });

  socket.on("disconnect", () => {
    const name = players[socket.id]?.name || "Someone";
    delete players[socket.id];

    chatLog.push({
      system: true,
      text: `${name} left the room.`
    });

    if (currentRound) {
      delete currentRound.votes[socket.id];
      delete currentRound.clues[socket.id];

      if (Object.keys(players).length === 0) {
        currentRound = null;
      } else {
        sendState();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});