// ===== Wavelength Online - WebSocket Server (Left/Right Rules) =====
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 3000;

// --- TOPICS ---
const rawTopics = fs.readFileSync(path.join(__dirname, "topics.json"), "utf-8");
const TOPICS = JSON.parse(rawTopics);

// --- Room & Global Management ---
const rooms = new Map();
const globalUsers = new Map(); // userId -> { ws, name, avatar, friendCode, currentRoom }
const friendCodeToUserId = new Map(); // friendCode -> userId

// --- MongoDB Initialization ---
let db, usersCollection;
async function initDB() {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set!");
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db("wavelength");
    usersCollection = db.collection("users");
    console.log("Connected to MongoDB!");
  } catch (e) {
    console.error("MongoDB connection error:", e);
  }
}
initDB();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function pickTopic(room) {
  let available = TOPICS.filter((_, i) => !room.usedTopics.includes(i));
  if (available.length === 0) { room.usedTopics = []; available = TOPICS; }
  const idx = TOPICS.indexOf(available[Math.floor(Math.random() * available.length)]);
  room.usedTopics.push(idx);
  return TOPICS[idx];
}

// function calcMainScore(diff) removed as we now calculate inline

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(data); });
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getPlayerList(room) {
  return room.players.map(p => ({ name: p.name, id: p.id }));
}

// --- HTTP Server ---
const MIME = { ".html":"text/html",".css":"text/css",".js":"application/javascript",".json":"application/json" };

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === "/" ? "index.html" : urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on("connection", (ws) => {
  ws._userId = null;
  ws._roomCode = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    await handleMessage(ws, msg);
  });

  ws.on("close", () => handleDisconnect(ws, ws._userId));
});

async function handleMessage(ws, msg) {
  const playerId = ws._userId;
  switch (msg.type) {
    case "register": {
      ws._userId = msg.userId;
      globalUsers.set(msg.userId, { ws, name: msg.name, avatar: msg.avatar, friendCode: msg.friendCode, currentRoom: null });
      if (msg.friendCode) friendCodeToUserId.set(msg.friendCode, msg.userId);

      if (usersCollection) {
        let user = await usersCollection.findOne({ userId: msg.userId });
        if (!user) {
          user = {
            userId: msg.userId, name: msg.name, avatar: msg.avatar, friendCode: msg.friendCode,
            stats: {
              "直感": { earned: 0, max: 0 }, "感情": { earned: 0, max: 0 },
              "抽象": { earned: 0, max: 0 }, "知識": { earned: 0, max: 0 },
              "評価軸": { earned: 0, max: 0 }, "文脈依存": { earned: 0, max: 0 }
            },
            friends: []
          };
          await usersCollection.insertOne(user);
        } else {
          if (user.name !== msg.name || user.avatar !== msg.avatar) {
             await usersCollection.updateOne({ userId: msg.userId }, { $set: { name: msg.name, avatar: msg.avatar } });
          }
        }
        sendTo(ws, { type: "account_info", stats: user.stats, friends: user.friends });
      }
      break;
    }

    case "restore_account": {
      if (usersCollection) {
         const user = await usersCollection.findOne({ friendCode: msg.friendCode });
         if (user) {
            sendTo(ws, { type: "restore_success", account: { userId: user.userId, name: user.name, avatar: user.avatar, friendCode: user.friendCode }, stats: user.stats, friends: user.friends });
         } else {
            sendTo(ws, { type: "error", message: "アカウントが見つかりません" });
         }
      }
      break;
    }

    case "add_friend": {
      if (usersCollection && ws._userId) {
        await usersCollection.updateOne(
          { userId: ws._userId },
          { $addToSet: { friends: { friendCode: msg.friendCode, name: msg.friendName } } }
        );
      }
      break;
    }

    case "create_room": {
      if (!playerId) return;
      const code = generateCode();
      const room = {
        code, host: playerId, players: [{ id: playerId, name: msg.name, ws }],
        phase: "lobby", round: 0, maxRounds: 2, history: [], usedTopics: [], totalScores: {}, chat: [],
        hinterIndex: 0, mainGuesserIndex: 1, turn: 0,
        topic: null, target: 0, hint: "", mainGuess: 50, lrGuesses: {}
      };
      room.totalScores[playerId] = 0;
      rooms.set(code, room);
      ws._roomCode = code;
      const u = globalUsers.get(playerId);
      if (u) u.currentRoom = code;
      sendTo(ws, { type: "room_created", code, playerId, players: getPlayerList(room), host: room.host });
      break;
    }

    case "join_room": {
      if (!playerId) return;
      const code = (msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { sendTo(ws, { type: "error", message: "ルームが見つかりません" }); return; }
      if (room.phase !== "lobby") { sendTo(ws, { type: "error", message: "ゲームが既に開始されています" }); return; }
      if (room.players.length >= 8) { sendTo(ws, { type: "error", message: "ルームが満員です" }); return; }
      
      room.players.push({ id: playerId, name: msg.name, ws });
      room.totalScores[playerId] = 0;
      ws._roomCode = code;
      const u = globalUsers.get(playerId);
      if (u) u.currentRoom = code;

      sendTo(ws, { type: "room_joined", code, playerId, players: getPlayerList(room), host: room.host });
      broadcast(room, { type: "player_list", players: getPlayerList(room), host: room.host });
      broadcast(room, { type: "chat_msg", name: "📢 システム", message: `${msg.name} が参加しました` });
      break;
    }

    case "start_game": {
      const room = getRoom(ws);
      if (!room || room.host !== playerId) return;
      if (room.players.length < 2) { sendTo(ws, { type: "error", message: "2人以上必要です" }); return; }
      room.maxRounds = msg.maxRounds || 2; // Default to 2 rounds (rotations)
      room.turn = 0; // Total hints given so far
      room.round = 1; // Current round (rotation)
      room.history = [];
      room.usedTopics = [];
      room.totalScores = {};
      room.players.forEach(p => room.totalScores[p.id] = 0);
      startNextRound(room);
      break;
    }

    case "submit_hint": {
      const room = getRoom(ws);
      if (!room || room.phase !== "hint") return;
      const hinter = room.players[room.hinterIndex % room.players.length];
      if (hinter.id !== playerId) return;
      room.hint = msg.hint;
      room.phase = "main_guess";
      
      const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];

      const turnInRound = ((room.turn - 1) % room.players.length) + 1;
      broadcast(room, {
        type: "main_guess_phase",
        topic: [room.topic.left, room.topic.right],
        topicType: room.topic.type,
        difficulty: room.topic.difficulty,
        multiplier: room.topic.multiplier,
        hint: room.hint, 
        round: room.round, maxRounds: room.maxRounds,
        turnInRound: turnInRound, totalPlayers: room.players.length,
        hinterId: hinter.id, hinterName: hinter.name,
        mainGuesserId: mainGuesser.id, mainGuesserName: mainGuesser.name
      });
      break;
    }

    case "submit_main_guess": {
      const room = getRoom(ws);
      if (!room || room.phase !== "main_guess") return;
      const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];
      if (mainGuesser.id !== playerId) return;

      room.mainGuess = msg.guess;
      
      if (room.players.length > 2) {
        room.phase = "lr_guess";
        room.lrGuesses = {};
        const turnInRound = ((room.turn - 1) % room.players.length) + 1;
        broadcast(room, {
          type: "lr_guess_phase",
          mainGuess: room.mainGuess,
          topic: [room.topic.left, room.topic.right],
          topicType: room.topic.type,
          difficulty: room.topic.difficulty,
          multiplier: room.topic.multiplier,
          hint: room.hint, 
          round: room.round, maxRounds: room.maxRounds,
          turnInRound: turnInRound, totalPlayers: room.players.length,
          hinterId: room.players[room.hinterIndex % room.players.length].id,
          mainGuesserId: mainGuesser.id
        });
      } else {
        // Only 2 players -> go straight to reveal
        showRoundResult(room);
      }
      break;
    }

    case "submit_lr_guess": {
      const room = getRoom(ws);
      if (!room || room.phase !== "lr_guess") return;
      const hinter = room.players[room.hinterIndex % room.players.length];
      const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];
      if (playerId === hinter.id || playerId === mainGuesser.id) return; // Only Others can vote

      room.lrGuesses[playerId] = msg.guess; // "left" or "right"
      const totalOthers = room.players.length - 2;
      const submitted = Object.keys(room.lrGuesses).length;

      broadcast(room, { type: "lr_guess_update", submitted, total: totalOthers });

      if (submitted >= totalOthers) showRoundResult(room);
      break;
    }

    case "skip_topic": {
      const room = getRoom(ws);
      if (!room || room.phase !== "hint") return;
      const hinter = room.players[room.hinterIndex % room.players.length];
      if (hinter.id !== playerId) return;

      room.topic = pickTopic(room);
      room.target = Math.floor(Math.random() * 101);
      room.players.forEach(p => {
        sendTo(p.ws, { 
          type: "topic_updated", 
          topic: [room.topic.left, room.topic.right],
          difficulty: room.topic.difficulty,
          multiplier: room.topic.multiplier,
          target: p.id === hinter.id ? room.target : null 
        });
      });
      break;
    }

    case "next_round": {
      const room = getRoom(ws);
      if (!room || room.host !== playerId) return;
      startNextRound(room);
      break;
    }

    case "invite_friend": {
      const targetId = friendCodeToUserId.get(msg.friendCode);
      if (targetId) {
        const targetUser = globalUsers.get(targetId);
        if (targetUser && targetUser.ws.readyState === 1 && targetUser.currentRoom === null) {
          sendTo(targetUser.ws, {
            type: "invite_received",
            fromName: msg.fromName,
            fromAvatar: msg.fromAvatar,
            roomCode: msg.roomCode
          });
        }
      }
      break;
    }

    case "chat": {
      const room = getRoom(ws);
      if (!room) return;
      const player = room.players.find(p => p.id === ws._userId);
      if (player) broadcast(room, { type: "chat_msg", name: player.name, message: msg.message });
      break;
    }
  }
}

function getRoom(ws) { return ws._roomCode ? rooms.get(ws._roomCode) : null; }

function startNextRound(room) {
  room.turn++;
  room.round = Math.ceil(room.turn / room.players.length);

  if (room.round > room.maxRounds) {
    room.phase = "final";
    const playerNames = {};
    room.players.forEach(p => playerNames[p.id] = p.name);
    broadcast(room, { type: "game_over", totalScores: room.totalScores, playerNames, history: room.history });
    room.phase = "lobby";
    return;
  }

  room.phase = "hint";
  room.hint = "";
  room.mainGuess = 50;
  room.lrGuesses = {};
  room.topic = pickTopic(room);
  room.target = Math.floor(Math.random() * 101);

  // Rotation logic: Hinter -> next, MainGuesser -> next of Hinter
  room.hinterIndex = (room.turn - 1);
  room.mainGuesserIndex = room.hinterIndex + 1;

  const hinter = room.players[room.hinterIndex % room.players.length];
  const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];

  const turnInRound = ((room.turn - 1) % room.players.length) + 1;

  room.players.forEach(p => {
    sendTo(p.ws, {
      type: "hint_phase",
      topic: [room.topic.left, room.topic.right],
      topicType: room.topic.type,
      difficulty: room.topic.difficulty,
      multiplier: room.topic.multiplier,
      target: p.id === hinter.id ? room.target : null,
      hinterName: hinter.name,
      mainGuesserName: mainGuesser.name,
      isHinter: p.id === hinter.id,
      round: room.round, maxRounds: room.maxRounds,
      turnInRound: turnInRound, totalPlayers: room.players.length
    });
  });
}

function showRoundResult(room) {
  room.phase = "reveal";
  const hinter = room.players[room.hinterIndex % room.players.length];
  const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];

  const diff = Math.abs(room.mainGuess - room.target);
  const baseScore = 100 - diff;
  const mainScore = Math.round(baseScore * room.topic.multiplier);
  const isPerfect = (diff === 0);

  const scores = {}; // pid -> { guess, score, type, role, lrp }
  const playerNames = {};
  room.players.forEach(p => playerNames[p.id] = p.name);

  // Hinter & Main Guesser Score
  room.totalScores[hinter.id] += mainScore;
  room.totalScores[mainGuesser.id] += mainScore;
  scores[hinter.id] = { role: "hinter", score: mainScore };
  scores[mainGuesser.id] = { role: "mainGuesser", score: mainScore, guess: room.mainGuess, diff };

  // Others Score
  if (room.players.length > 2) {
    room.players.forEach(p => {
      if (p.id !== hinter.id && p.id !== mainGuesser.id) {
        let pts = 0;
        const voted = room.lrGuesses[p.id]; // "left" or "right"
        const correctSide = room.target < room.mainGuess ? "left" : "right";
        
        if (!isPerfect && voted === correctSide && room.target !== room.mainGuess) {
          pts = Math.round(30 * room.topic.multiplier);
        }
        room.totalScores[p.id] += pts;
        scores[p.id] = { role: "other", score: pts, voted, correctSide, isPerfect };
      }
    });
  }

  const turnInRound = ((room.turn - 1) % room.players.length) + 1;
  const isLastTurnOfGame = (room.round === room.maxRounds && turnInRound === room.players.length);

  room.history.push({
    round: room.round, turn: turnInRound, topic: [room.topic.left, room.topic.right], target: room.target, hint: room.hint,
    mainGuess: room.mainGuess, scores, playerNames
  });

  broadcast(room, {
    type: "round_result", target: room.target, 
    topic: [room.topic.left, room.topic.right], 
    topicType: room.topic.type,
    difficulty: room.topic.difficulty,
    multiplier: room.topic.multiplier,
    hint: room.hint,
    mainGuess: room.mainGuess, scores, totalScores: room.totalScores, playerNames,
    hinterId: hinter.id, mainGuesserId: mainGuesser.id,
    round: room.round, maxRounds: room.maxRounds,
    turnInRound: turnInRound, totalPlayers: room.players.length,
    isLastRound: isLastTurnOfGame, host: room.host
  });

  // DB Update for Stats
  if (usersCollection) {
    const type = room.topic.type;
    const maxMain = Math.round(100 * room.topic.multiplier);
    const maxOther = Math.round(30 * room.topic.multiplier);

    const updates = [];
    for (const [pid, sData] of Object.entries(scores)) {
       let e = sData.score;
       let m = (sData.role === "other") ? maxOther : maxMain;
       updates.push({
         updateOne: {
           filter: { userId: pid },
           update: { 
             $inc: { 
               [`stats.${type}.earned`]: e,
               [`stats.${type}.max`]: m 
             } 
           }
         }
       });
    }
    if (updates.length > 0) {
       usersCollection.bulkWrite(updates).catch(console.error);
    }
  }
}

function handleDisconnect(ws, playerId) {
  if (playerId) {
    const u = globalUsers.get(playerId);
    if (u) {
      if (u.friendCode) friendCodeToUserId.delete(u.friendCode);
      globalUsers.delete(playerId);
    }
  }

  const code = ws._roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== playerId);
  ws._roomCode = null;

  if (room.players.length === 0) { rooms.delete(code); return; }
  if (room.host === playerId) { room.host = room.players[0].id; broadcast(room, { type: "host_changed", host: room.host }); }
  broadcast(room, { type: "player_list", players: getPlayerList(room), host: room.host });
}

server.listen(PORT, "0.0.0.0", () => console.log(`🌊 Server running on port ${PORT}`));
