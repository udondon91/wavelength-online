// ===== Wavelength Online - WebSocket Server (Left/Right Rules) =====
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// --- TOPICS ---
const TOPICS = [
  ["熱い 🔥","冷たい ❄️"],["甘い 🍬","苦い 💊"],["速い 🏎️","遅い 🐢"],
  ["大きい 🐘","小さい 🐜"],["明るい ☀️","暗い 🌙"],["うるさい 📢","静か 🤫"],
  ["高い ⬆️","低い ⬇️"],["硬い 🪨","柔らかい 🧸"],["古い 📜","新しい ✨"],
  ["重い 🏋️","軽い 🪶"],["危険 ⚠️","安全 🛡️"],["有名 🌟","無名 👤"],
  ["美しい 🌹","醜い 👹"],["楽しい 🎉","つまらない 😐"],["簡単 ✅","難しい 🧩"],
  ["贅沢 💎","質素 🍚"],["リアル 📷","ファンタジー 🧙"],["都会 🏙️","田舎 🌾"],
  ["過大評価 📈","過小評価 📉"],["健康的 🥗","不健康 🍔"],["かわいい 🐱","かっこいい 🐺"],
  ["朝型 🌅","夜型 🦉"],["インドア 🏠","アウトドア ⛰️"],["天才 🧠","努力家 💪"],
  ["未来的 🚀","レトロ 📻"],["平和 🕊️","戦争 ⚔️"],["おしゃれ 👗","ダサい 🧦"],
  ["正義 ⚖️","悪 😈"],["現実的 📊","理想的 🌈"],["陽キャ 🌞","陰キャ 🌚"],
  ["丸い ⭕","四角い 🟥"],["速攻 ⚡","じっくり 🧘"],["甘口 🍯","辛口 🌶️"],
  ["夏っぽい 🏖️","冬っぽい ⛄"],["大人向け 🍷","子供向け 🧃"],
];

// --- Room Management ---
const rooms = new Map();

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

function calcMainScore(diff) {
  if (diff <= 2) return 4;
  if (diff <= 5) return 3;
  if (diff <= 10) return 2;
  if (diff <= 20) return 1;
  return 0;
}

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
const MIME = { ".html":"text/html",".css":"text/css",".js":"application/javascript" };

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
  const playerId = "p" + nextId++;
  ws._playerId = playerId;
  ws._roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, playerId, msg);
  });

  ws.on("close", () => handleDisconnect(ws, playerId));
});

function handleMessage(ws, playerId, msg) {
  switch (msg.type) {
    case "create_room": {
      const code = generateCode();
      const room = {
        code, host: playerId, players: [{ id: playerId, name: msg.name, ws }],
        phase: "lobby", round: 0, maxRounds: 5, history: [], usedTopics: [], totalScores: {}, chat: [],
        hinterIndex: 0, mainGuesserIndex: 1,
        topic: null, target: 0, hint: "", mainGuess: 50, lrGuesses: {}
      };
      room.totalScores[playerId] = 0;
      rooms.set(code, room);
      ws._roomCode = code;
      sendTo(ws, { type: "room_created", code, playerId, players: getPlayerList(room), host: room.host });
      break;
    }

    case "join_room": {
      const code = (msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { sendTo(ws, { type: "error", message: "ルームが見つかりません" }); return; }
      if (room.phase !== "lobby") { sendTo(ws, { type: "error", message: "ゲームが既に開始されています" }); return; }
      if (room.players.length >= 8) { sendTo(ws, { type: "error", message: "ルームが満員です" }); return; }
      
      room.players.push({ id: playerId, name: msg.name, ws });
      room.totalScores[playerId] = 0;
      ws._roomCode = code;

      sendTo(ws, { type: "room_joined", code, playerId, players: getPlayerList(room), host: room.host });
      broadcast(room, { type: "player_list", players: getPlayerList(room), host: room.host });
      broadcast(room, { type: "chat_msg", name: "📢 システム", message: `${msg.name} が参加しました` });
      break;
    }

    case "start_game": {
      const room = getRoom(ws);
      if (!room || room.host !== playerId) return;
      if (room.players.length < 2) { sendTo(ws, { type: "error", message: "2人以上必要です" }); return; }
      room.maxRounds = msg.maxRounds || 5;
      room.round = 0;
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

      broadcast(room, {
        type: "main_guess_phase",
        topic: room.topic, hint: room.hint, round: room.round, maxRounds: room.maxRounds,
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
        broadcast(room, {
          type: "lr_guess_phase",
          mainGuess: room.mainGuess,
          topic: room.topic, hint: room.hint, round: room.round, maxRounds: room.maxRounds,
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
        sendTo(p.ws, { type: "topic_updated", topic: room.topic, target: p.id === hinter.id ? room.target : null });
      });
      break;
    }

    case "next_round": {
      const room = getRoom(ws);
      if (!room || room.host !== playerId) return;
      startNextRound(room);
      break;
    }

    case "chat": {
      const room = getRoom(ws);
      if (!room) return;
      const player = room.players.find(p => p.id === playerId);
      if (player) broadcast(room, { type: "chat_msg", name: player.name, message: msg.message });
      break;
    }
  }
}

function getRoom(ws) { return ws._roomCode ? rooms.get(ws._roomCode) : null; }

function startNextRound(room) {
  room.round++;
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
  room.hinterIndex = (room.round - 1);
  room.mainGuesserIndex = room.hinterIndex + 1;

  const hinter = room.players[room.hinterIndex % room.players.length];
  const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];

  room.players.forEach(p => {
    sendTo(p.ws, {
      type: "hint_phase",
      topic: room.topic,
      target: p.id === hinter.id ? room.target : null,
      hinterName: hinter.name,
      mainGuesserName: mainGuesser.name,
      isHinter: p.id === hinter.id,
      round: room.round, maxRounds: room.maxRounds
    });
  });
}

function showRoundResult(room) {
  room.phase = "reveal";
  const hinter = room.players[room.hinterIndex % room.players.length];
  const mainGuesser = room.players[room.mainGuesserIndex % room.players.length];

  const diff = Math.abs(room.mainGuess - room.target);
  const mainScore = calcMainScore(diff);
  const isPerfect = (mainScore === 4);

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
          pts = 1;
        }
        room.totalScores[p.id] += pts;
        scores[p.id] = { role: "other", score: pts, voted, correctSide, isPerfect };
      }
    });
  }

  room.history.push({
    round: room.round, topic: room.topic, target: room.target, hint: room.hint,
    mainGuess: room.mainGuess, scores, playerNames
  });

  broadcast(room, {
    type: "round_result", target: room.target, topic: room.topic, hint: room.hint,
    mainGuess: room.mainGuess, scores, totalScores: room.totalScores, playerNames,
    hinterId: hinter.id, mainGuesserId: mainGuesser.id,
    round: room.round, maxRounds: room.maxRounds, isLastRound: room.round >= room.maxRounds, host: room.host
  });
}

function handleDisconnect(ws, playerId) {
  const code = ws._roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.find(p => p.id === playerId);
  room.players = room.players.filter(p => p.id !== playerId);
  ws._roomCode = null;

  if (room.players.length === 0) { rooms.delete(code); return; }
  if (room.host === playerId) { room.host = room.players[0].id; broadcast(room, { type: "host_changed", host: room.host }); }
  broadcast(room, { type: "player_list", players: getPlayerList(room), host: room.host });
}

server.listen(PORT, "0.0.0.0", () => console.log(`🌊 Server running on port ${PORT}`));
