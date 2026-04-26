const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const players = {};

function randomColor() {
  const colors = ["red", "blue", "green", "purple", "orange", "cyan", "yellow"];
  return colors[Math.floor(Math.random() * colors.length)];
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  players[socket.id] = {
    x: Math.floor(Math.random() * 700),
    y: Math.floor(Math.random() * 500),
    color: randomColor()
  };

  socket.emit("currentPlayers", players);
  socket.broadcast.emit("newPlayer", {
    id: socket.id,
    player: players[socket.id]
  });

  socket.on("move", (direction) => {
    const player = players[socket.id];
    if (!player) return;

    const speed = 5;

    if (direction.up) player.y -= speed;
    if (direction.down) player.y += speed;
    if (direction.left) player.x -= speed;
    if (direction.right) player.x += speed;

    player.x = Math.max(0, Math.min(780, player.x));
    player.y = Math.max(0, Math.min(580, player.y));

    io.emit("playerMoved", {
      id: socket.id,
      player
    });
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});