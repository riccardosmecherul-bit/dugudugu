import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = here;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 256 * 1024
});
app.get("/health", (_req, res) => res.json({ ok: true, service: "dugu-dugu-multiplayer" }));
app.use(express.static(publicDir, { maxAge: "1h" }));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const rooms = new Map();
const FIGHTERS = 6;
const MAPS = new Set(["boxing", "school", "medieval"]);
const DIRECTIONS = ["up", "down", "left", "right"];
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function roomFor(socket) {
  const id = socket.data.roomId;
  const room = id && rooms.get(id);
  return room && room[socket.data.role] === socket.id ? room : null;
}
function validPick(n) { return Number.isInteger(n) && n >= 0 && n < FIGHTERS; }
function cleanInput(value = {}) {
  const result = {};
  for (const key of DIRECTIONS) result[key] = value[key] === true;
  return result;
}
io.on("connection", socket => {
  socket.data.roomId = null;
  socket.data.role = null;
  socket.data.lastInputAt = 0;

  socket.on("createLobby", () => {
    if (socket.data.roomId) return;
    const code = makeCode();
    const room = { code, host: socket.id, guest: null, picks: { host: null, guest: null }, started: false, input: { up:false, down:false, left:false, right:false } };
    rooms.set(code, room);
    socket.data.roomId = code; socket.data.role = "host"; socket.join(code);
    socket.emit("lobbyCreated", { code, role: "host" });
  });

  socket.on("joinLobby", (payload = {}) => {
    if (socket.data.roomId) return;
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code) || !room) return socket.emit("lobbyError", "Lobby not found. Check the 4-character code.");
    if (room.guest) return socket.emit("lobbyError", "Lobby is already full.");
    room.guest = socket.id;
    socket.data.roomId = code; socket.data.role = "guest"; socket.join(code);
    socket.emit("lobbyJoined", { code, role: "guest" });
    io.to(room.host).emit("guestJoined");
  });

  socket.on("selectFighter", payload => {
    const room = roomFor(socket);
    if (!room || room.started || !payload || !validPick(payload.index)) return;
    const opponent = socket.data.role === "host" ? "guest" : "host";
    if (room.picks[opponent] === payload.index) return socket.emit("lobbyError", "Choose a different fighter from your opponent.");
    room.picks[socket.data.role] = payload.index;
    const target = room[opponent];
    if (target) io.to(target).emit("opponentSelected", { index: payload.index });
  });

  socket.on("startMatch", payload => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "host" || !room.guest || room.started) return;
    const hostPick = room.picks.host ?? payload?.hostPick;
    const guestPick = room.picks.guest ?? payload?.guestPick;
    if (!validPick(hostPick) || !validPick(guestPick) || hostPick === guestPick) return;
    const map = MAPS.has(payload?.map) ? payload.map : "boxing";
    room.picks = { host: hostPick, guest: guestPick }; room.started = true;
    const match = { hostPick, guestPick, map, session: `${room.code}-${Date.now()}` };
    io.to(room.code).emit("startMatch", match);
  });

  // Guest sends continuous input state. Host remains authoritative for movement/combat.
  socket.on("guestInput", payload => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "guest" || !room.started) return;
    const now = Date.now();
    if (now - socket.data.lastInputAt < 12) return;
    socket.data.lastInputAt = now;
    room.input = cleanInput(payload);
    io.to(room.host).emit("guestInput", room.input);
  });

  socket.on("state", state => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "host" || !room.guest || !room.started) return;
    if (!state || !Array.isArray(state.chars) || state.chars.length > 6) return;
    const chars = [];
    for (const c of state.chars) {
      if (!c || !validPick(c.i) || ![c.x,c.y,c.hp].every(Number.isFinite)) continue;
      chars.push({ i:c.i, x:c.x, y:c.y, vx:Number(c.vx)||0, vy:Number(c.vy)||0,
        hp:Math.max(0, Math.min(750, c.hp)), alive:!!c.alive, w:Number(c.w)||0, h:Number(c.h)||0 });
    }
    io.to(room.guest).emit("state", { sentAt: Date.now(), chars });
  });

  socket.on("roundEnd", data => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "host" || !room.guest) return;
    room.started = false;
    const packet = {
      hostWins: Math.max(0, Math.min(2, Number(data?.hostWins) | 0)),
      guestWins: Math.max(0, Math.min(2, Number(data?.guestWins) | 0)),
      matchOver: !!data?.matchOver,
      nextMap: MAPS.has(data?.nextMap) ? data.nextMap : "boxing"
    };
    io.to(room.code).emit("roundEnd", packet);
  });

  socket.on("disconnect", () => {
    const room = roomFor(socket);
    if (!room) return;
    const id = room.code;
    if (socket.data.role === "host") {
      if (room.guest) io.to(room.guest).emit("hostDisconnected");
      rooms.delete(id);
    } else {
      room.guest = null; room.started = false;
      room.input = { up:false, down:false, left:false, right:false };
      room.picks.guest = null;
      io.to(room.host).emit("guestDisconnected");
    }
  });
});

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => console.log(`Dugu Dugu multiplayer server listening on ${port}`));
