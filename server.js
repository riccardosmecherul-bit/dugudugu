import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const rootIndex = path.join(__dirname, "index.html");
const publicIndex = path.join(publicDir, "index.html");
const staticDir = existsSync(publicDir) ? publicDir : __dirname;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Keep Socket.IO's polling fallback available for hosts/proxies that block WebSockets.
  perMessageDeflate: false,
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e6
});

app.use(express.static(staticDir, { maxAge: "1h", immutable: true }));
app.get("/", (_req, res) => {
  const indexPath = existsSync(publicIndex) ? publicIndex : rootIndex;
  if (!existsSync(indexPath)) {
    return res.status(500).send("Missing index.html. Put it in ./public/index.html or beside server.js.");
  }
  res.sendFile(indexPath);
});

const rooms = new Map();
const FIGHTER_COUNT = 6;
const MAPS = new Set(["boxing", "school", "medieval"]);

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

io.on("connection", (socket) => {
  let roomId = null;
  let role = null;

  socket.on("createLobby", () => {
    if (roomId) return;
    roomId = roomCode();
    role = "host";
    rooms.set(roomId, { host: socket.id, guest: null });
    socket.join(roomId);
    socket.emit("lobbyCreated", { code: roomId });
  });

  socket.on("joinLobby", (payload = {}) => {
    if (roomId) return;
    const requested = String(payload.code || "").trim().toUpperCase();
    if (requested.length !== 4) {
      socket.emit("lobbyError", "Enter the 4-character room code.");
      return;
    }
    const room = rooms.get(requested);
    if (!room) {
      socket.emit("lobbyError", "Lobby not found. Check the 4-character code.");
      return;
    }
    if (room.guest) {
      socket.emit("lobbyError", "Lobby is already full.");
      return;
    }

    roomId = requested;
    role = "guest";
    room.guest = socket.id;
    socket.join(roomId);
    socket.emit("lobbyJoined", { code: roomId });
    io.to(room.host).emit("guestJoined");
  });

  socket.on("selectFighter", (payload = {}) => {
    const room = rooms.get(roomId);
    const index = payload.index;
    if (!room || !Number.isInteger(index) || index < 0 || index >= FIGHTER_COUNT) return;
    const target = role === "host" ? room.guest : role === "guest" ? room.host : null;
    if (target) io.to(target).emit("opponentSelected", { index });
  });

  socket.on("startMatch", (data = {}) => {
    const room = rooms.get(roomId);
    if (!room || role !== "host" || !room.guest) return;
    const { hostPick, guestPick } = data;
    if (!Number.isInteger(hostPick) || !Number.isInteger(guestPick) ||
        hostPick < 0 || hostPick >= FIGHTER_COUNT ||
        guestPick < 0 || guestPick >= FIGHTER_COUNT) return;
    if (hostPick === guestPick) {
      socket.emit("lobbyError", "Both players must choose different fighters.");
      return;
    }
    const map = MAPS.has(data.map) ? data.map : "boxing";
    io.to(room.guest).emit("startMatch", { hostPick, guestPick, map });
  });

  socket.on("guestInput", (data = {}) => {
    const room = rooms.get(roomId);
    if (room && role === "guest" && room.guest === socket.id) {
      io.to(room.host).emit("guestInput", {
        up: !!data.up, down: !!data.down, left: !!data.left, right: !!data.right
      });
    }
  });

  socket.on("state", (data) => {
    const room = rooms.get(roomId);
    if (room && role === "host" && room.host === socket.id && room.guest) {
      io.to(room.guest).emit("state", data);
    }
  });

  socket.on("roundEnd", (data = {}) => {
    const room = rooms.get(roomId);
    if (!room || role !== "host" || !room.guest) return;
    io.to(room.guest).emit("roundEnd", {
      hostWins: Math.max(0, Math.min(2, Number(data.hostWins) | 0)),
      guestWins: Math.max(0, Math.min(2, Number(data.guestWins) | 0)),
      matchOver: !!data.matchOver,
      nextMap: MAPS.has(data.nextMap) ? data.nextMap : "boxing"
    });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (role === "host") {
      if (room.guest) io.to(room.guest).emit("hostDisconnected");
      rooms.delete(roomId);
    } else if (role === "guest") {
      room.guest = null;
      io.to(room.host).emit("guestDisconnected");
    }
  });
});

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Dugu Dugu Battle server listening on port ${port}`);
});
