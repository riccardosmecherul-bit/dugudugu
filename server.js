import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(); const httpServer=createServer(app);
const io=new Server(httpServer,{
  cors:{origin:"*",methods:["GET","POST"]},
  transports:["websocket"],
  perMessageDeflate:false,
  pingInterval:20000,
  pingTimeout:25000,
  maxHttpBufferSize:1e6
});
app.use(express.static(path.join(__dirname,"public"),{maxAge:"1h",immutable:true}));
app.get("/",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const rooms=new Map();
function roomCode(){const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let code;do{code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join("");}while(rooms.has(code));return code;}
io.on("connection",socket=>{let id=null,role=null;
socket.on("createLobby",()=>{if(id)return;id=roomCode();role="host";rooms.set(id,{host:socket.id,guest:null});socket.join(id);socket.emit("lobbyCreated",{code:id});});
socket.on("joinLobby",({code})=>{if(id)return;const requested=(code||"").trim().toUpperCase(),room=rooms.get(requested);if(!room)return socket.emit("lobbyError","Lobby not found. Check the 4-character code.");if(room.guest)return socket.emit("lobbyError","Lobby is already full.");id=requested;role="guest";room.guest=socket.id;socket.join(id);socket.emit("lobbyJoined",{code:id});io.to(room.host).emit("guestJoined");});
socket.on("selectFighter",({index})=>{const room=rooms.get(id);if(!room||!Number.isInteger(index)||index<0||index>5)return;if(role==="host"&&room.guest)io.to(room.guest).emit("opponentSelected",{index});if(role==="guest")io.to(room.host).emit("opponentSelected",{index});});
socket.on("startMatch",data=>{const room=rooms.get(id);if(!room||role!=="host"||!room.guest)return;if(!Number.isInteger(data.hostPick)||!Number.isInteger(data.guestPick))return;if(data.hostPick===data.guestPick)return socket.emit("lobbyError","Both players must choose different fighters.");io.to(room.guest).emit("startMatch",data);});
socket.on("guestInput",data=>{const room=rooms.get(id);if(room&&role==="guest")io.to(room.host).emit("guestInput",{up:!!data.up,down:!!data.down,left:!!data.left,right:!!data.right});});
socket.on("state",data=>{const room=rooms.get(id);if(room&&role==="host"&&room.guest)io.to(room.guest).volatile.emit("state",data);});
socket.on("roundEnd",data=>{const room=rooms.get(id);if(room&&role==="host"&&room.guest)io.to(room.guest).emit("roundEnd",{hostWins:Math.max(0,Math.min(2,data.hostWins|0)),guestWins:Math.max(0,Math.min(2,data.guestWins|0)),matchOver:!!data.matchOver,nextMap:String(data.nextMap||"boxing")});});
socket.on("disconnect",()=>{const room=rooms.get(id);if(!room)return;if(role==="host"){if(room.guest)io.to(room.guest).emit("hostDisconnected");rooms.delete(id);}else if(role==="guest"){room.guest=null;io.to(room.host).emit("guestDisconnected");}});
});
httpServer.listen(process.env.PORT||3000,"0.0.0.0",()=>console.log("Server started"));
