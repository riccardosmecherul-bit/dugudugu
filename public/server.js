import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["polling", "websocket"]
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = new Map();
function makeCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let code;
  do{code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join("");}while(rooms.has(code));
  return code;
}

io.on("connection",(socket)=>{
  let roomId=null,role=null;

  socket.on("createLobby",()=>{
    const code=makeCode();
    rooms.set(code,{host:socket.id,guest:null,started:false});
    roomId=code;role="host";socket.join(code);
    socket.emit("lobbyCreated",{code,role});
  });

  socket.on("joinLobby",({code})=>{
    const room=rooms.get((code||"").toUpperCase());
    if(!room)return socket.emit("lobbyError","Lobby not found.");
    if(room.guest)return socket.emit("lobbyError","Lobby is full.");
    room.guest=socket.id;roomId=room.code;role="guest";socket.join(room.code);
    socket.emit("lobbyJoined",{code:room.code,role});
    io.to(room.host).emit("guestJoined");
  });

  socket.on("hostCharacter",(index)=>{const r=rooms.get(roomId);if(r&&role==="host")io.to(r.guest).emit("hostCharacter",index);});
  socket.on("guestCharacter",(index)=>{const r=rooms.get(roomId);if(r&&role==="guest")io.to(r.host).emit("guestCharacter",index);});
  socket.on("guestInput",(input)=>{const r=rooms.get(roomId);if(r&&role==="guest")io.to(r.host).emit("guestInput",input);});
  socket.on("startOnlineBattle",(data)=>{const r=rooms.get(roomId);if(r&&role==="host")io.to(r.guest).emit("startOnlineBattle",data);});
  socket.on("stateSnapshot",(snapshot)=>{const r=rooms.get(roomId);if(r&&role==="host")io.to(r.guest).emit("stateSnapshot",snapshot);});

  socket.on("disconnect",()=>{
    const room=rooms.get(roomId);if(!room)return;
    if(role==="host"){if(room.guest)io.to(room.guest).emit("hostDisconnected");rooms.delete(roomId);}
    else if(role==="guest"){room.guest=null;io.to(room.host).emit("guestDisconnected");}
  });
});

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,"0.0.0.0",()=>console.log(`Dugu Dugu Battle running on port ${PORT}`));
