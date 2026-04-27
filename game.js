// ===== Wavelength Online Client Logic (L/R Rules) =====

const state = {
  ws: null,
  playerId: null,
  roomCode: null,
  isHost: false,
  myName: "",
  players: [],
  maxRounds: 5,
  soundEnabled: true,
  chatUnread: 0,
  currentVote: null
};

// --- DOM Helpers ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const show = (id) => {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $(`#${id}`).classList.add("active");
};

// --- Sound Effects ---
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, duration, type = "sine") {
  if (!state.soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}
function sfxClick() { playTone(600, 0.1); }
function sfxSuccess() { playTone(523, 0.15); setTimeout(() => playTone(659, 0.15), 100); setTimeout(() => playTone(784, 0.2), 200); }
function sfxPerfect() { playTone(523, 0.1); setTimeout(() => playTone(659, 0.1), 80); setTimeout(() => playTone(784, 0.1), 160); setTimeout(() => playTone(1047, 0.3), 240); }
function sfxReveal() { playTone(440, 0.3, "triangle"); }
function sfxChat() { playTone(800, 0.1, "square"); }

// --- UI Helpers ---
function showToast(msg) {
  const toast = $("#toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function updateConnectionStatus(connected) {
  const status = $("#connection-status");
  const text = status.querySelector(".conn-text");
  if (connected) {
    status.classList.add("connected");
    text.textContent = "接続済み";
  } else {
    status.classList.remove("connected");
    text.textContent = "切断・再接続中...";
  }
}

// --- Confetti ---
function launchConfetti() {
  const canvas = $("#confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const particles = [];
  const colors = ["#ff4e50", "#fc913a", "#f9d423", "#4ecdc4", "#4e7cff", "#9b59ff", "#ff4ea3"];
  for (let i = 0; i < 120; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 18 - 4,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      life: 1,
    });
  }
  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.rotation += p.rotSpeed;
      p.life -= 0.012;
      if (p.life <= 0) return;
      alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 200) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  animate();
}

// --- Initialize WebSocket ---
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => updateConnectionStatus(true);
  state.ws.onclose = () => {
    updateConnectionStatus(false);
    setTimeout(connectWebSocket, 2000);
  };
  state.ws.onmessage = (event) => handleServerMessage(JSON.parse(event.data));
}

function sendMsg(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  } else {
    showToast("サーバーに接続されていません");
  }
}

// --- Message Handler ---
function handleServerMessage(msg) {
  switch (msg.type) {
    case "error":
      showToast(msg.message);
      break;

    case "room_created":
    case "room_joined":
      state.roomCode = msg.code;
      state.playerId = msg.playerId;
      updateLobby(msg.players, msg.host);
      show("screen-lobby");
      $("#chat-panel").style.display = "flex";
      // Update URL with room code (without reload)
      const joinUrl = `${window.location.origin}${window.location.pathname}?room=${msg.code}`;
      window.history.replaceState(null, "", joinUrl);
      sfxSuccess();
      break;

    case "player_list":
      updateLobby(msg.players, msg.host);
      break;

    case "host_changed":
      state.isHost = (msg.host === state.playerId);
      $("#host-controls").style.display = state.isHost ? "block" : "none";
      $("#guest-waiting").style.display = state.isHost ? "none" : "block";
      showToast("あなたがホストになりました");
      break;

    case "chat_msg":
      addChatMessage(msg.name, msg.message);
      break;

    case "hint_phase":
      if (msg.isHinter) {
        show("screen-hint");
        $("#hint-round").textContent = `ラウンド ${msg.round} / ${msg.maxRounds}`;
        $("#hint-topic-left").textContent = msg.topic[0];
        $("#hint-topic-right").textContent = msg.topic[1];
        $("#hint-target-zone").style.left = `${msg.target}%`;
        $("#hint-target-marker").style.left = `${msg.target}%`;
        $("#hint-target-value").textContent = msg.target;
        $("#hint-input").value = "";
        $("#hint-main-guesser-name").textContent = msg.mainGuesserName;
      } else {
        show("screen-waiting");
        $("#wait-round").textContent = `ラウンド ${msg.round} / ${msg.maxRounds}`;
        $("#wait-topic-left").textContent = msg.topic[0];
        $("#wait-topic-right").textContent = msg.topic[1];
        $("#wait-hinter-name").textContent = msg.hinterName;
      }
      sfxReveal();
      break;

    case "topic_updated":
      if (msg.target !== null) {
        $("#hint-topic-left").textContent = msg.topic[0];
        $("#hint-topic-right").textContent = msg.topic[1];
        $("#hint-target-zone").style.left = `${msg.target}%`;
        $("#hint-target-marker").style.left = `${msg.target}%`;
        $("#hint-target-value").textContent = msg.target;
      } else {
        $("#wait-topic-left").textContent = msg.topic[0];
        $("#wait-topic-right").textContent = msg.topic[1];
      }
      break;

    case "main_guess_phase":
      show("screen-main-guess");
      $("#mguess-round").textContent = `ラウンド ${msg.round} / ${msg.maxRounds}`;
      $("#mguess-topic-left").textContent = msg.topic[0];
      $("#mguess-topic-right").textContent = msg.topic[1];
      $("#mguess-hint-display").textContent = `💡 "${msg.hint}"`;

      // Reset
      $("#mguess-slider").value = 50;
      $("#mguess-slider-value").textContent = "50";
      $("#mguess-marker").style.left = "50%";

      const isMainGuesser = msg.mainGuesserId === state.playerId;
      
      if (isMainGuesser) {
        $("#mguess-role-badge").textContent = "🎯 当てる役（あなた）";
        $("#mguess-role-badge").style.background = "var(--accent-blue)";
        $("#mguess-controls").style.display = "block";
        $("#mguess-waiting").style.display = "none";
      } else {
        let roleName = "🤔 予想フェーズ";
        if (msg.hinterId === state.playerId) roleName = "👑 ヒント役";
        else roleName = "💬 惑わし役";
        
        $("#mguess-role-badge").textContent = roleName;
        $("#mguess-role-badge").style.background = "var(--bg-glass)";
        $("#mguess-controls").style.display = "none";
        $("#mguess-waiting").style.display = "block";
        $("#mguess-main-guesser-name").textContent = msg.mainGuesserName;
      }
      sfxClick();
      break;

    case "lr_guess_phase":
      show("screen-lr-guess");
      $("#lr-round").textContent = `ラウンド ${msg.round} / ${msg.maxRounds}`;
      $("#lr-topic-left").textContent = msg.topic[0];
      $("#lr-topic-right").textContent = msg.topic[1];
      $("#lr-hint-display").textContent = `💡 "${msg.hint}"`;
      $("#lr-main-marker").style.left = `${msg.mainGuess}%`;
      $("#lr-main-val").textContent = msg.mainGuess;
      $("#lr-main-guesser-name").textContent = getPlayerName(msg.mainGuesserId);

      state.currentVote = null;
      $("#btn-lr-left").classList.remove("btn-lr-selected");
      $("#btn-lr-right").classList.remove("btn-lr-selected");
      $("#lr-submitted").textContent = "0";
      $("#lr-total").textContent = state.players.length - 2;
      $("#lr-progress-bar").style.width = "0%";

      const isOther = (state.playerId !== msg.hinterId && state.playerId !== msg.mainGuesserId);
      
      if (isOther) {
        $("#lr-controls").style.display = "block";
        $("#lr-waiting").style.display = "none";
      } else {
        $("#lr-controls").style.display = "none";
        $("#lr-waiting").style.display = "block";
      }
      sfxClick();
      break;

    case "lr_guess_update":
      $("#lr-submitted").textContent = msg.submitted;
      $("#lr-total").textContent = msg.total;
      $("#lr-progress-bar").style.width = `${(msg.submitted / msg.total) * 100}%`;
      
      if (state.currentVote) {
        $("#lr-controls").style.display = "none";
        $("#lr-waiting").style.display = "block";
      }
      break;

    case "round_result":
      show("screen-reveal");
      $("#reveal-round").textContent = `ラウンド ${msg.round} / ${msg.maxRounds}`;
      $("#reveal-topic-left").textContent = msg.topic[0];
      $("#reveal-topic-right").textContent = msg.topic[1];
      $("#reveal-hint").textContent = `💡 "${msg.hint}"`;

      $("#reveal-main-marker").style.left = `${msg.mainGuess}%`;

      // Reveal animation
      const tz = $("#reveal-target-zone");
      tz.classList.add("hidden");
      tz.classList.remove("revealed");
      tz.style.left = `${msg.target}%`;
      setTimeout(() => tz.classList.remove("hidden"), 300);
      setTimeout(() => tz.classList.add("revealed"), 350);

      const tm = $("#reveal-target-marker");
      tm.style.left = `${msg.target}%`;
      tm.style.opacity = "0";
      setTimeout(() => { tm.style.opacity = "1"; sfxReveal(); }, 600);

      $("#reveal-target-value").textContent = `ターゲット: ${msg.target}`;

      // Show scores
      const s = msg.scores;
      const mScore = s[msg.mainGuesserId].score;
      const hasPerfect = (mScore === 4);

      let scoresHtml = "";
      
      // 1. Main & Hinter
      const pBadge = mScore === 4 ? "🎯 完璧!" : mScore === 3 ? "👏 すごい!" : mScore === 2 ? "👍 良い!" : mScore === 1 ? "😅 惜しい" : "💨 残念";
      const pCls = mScore === 4 ? "score-perfect" : mScore >= 2 ? "score-good" : mScore === 1 ? "score-ok" : "score-miss";

      scoresHtml += `
        <div class="history-item" style="animation:fadeIn 0.4s ease 0s both;background:rgba(255,255,255,0.08);border:1px solid var(--accent-blue)">
          <div>
            <span style="font-size:0.8rem;color:var(--accent-blue)">メイン予想</span><br>
            <strong>${esc(msg.playerNames[msg.mainGuesserId])}</strong>
            <span style="color:var(--text-secondary);margin-left:8px">予想: ${msg.mainGuess} (差: ${Math.abs(msg.mainGuess-msg.target)})</span>
          </div>
          <span class="${pCls}" style="font-weight:700">+${mScore} ${pBadge}</span>
        </div>`;

      scoresHtml += `
        <div class="history-item" style="animation:fadeIn 0.4s ease 0.1s both;background:rgba(255,255,255,0.08);border:1px solid var(--accent-orange)">
          <div>
            <span style="font-size:0.8rem;color:var(--accent-orange)">ヒント役</span><br>
            <strong>${esc(msg.playerNames[msg.hinterId])}</strong>
          </div>
          <span class="${pCls}" style="font-weight:700">+${mScore} ${pBadge}</span>
        </div>`;

      // 2. Others (L/R)
      if (Object.keys(s).length > 2) {
        scoresHtml += `<div style="text-align:center;font-size:0.85rem;color:var(--text-secondary);margin:16px 0 8px">◀▶ 左右予想</div>`;
        
        let i = 2;
        Object.entries(s).forEach(([pid, data]) => {
          if (data.role === "other") {
            const voteStr = data.voted === "left" ? "◀ 左" : "右 ▶";
            const isCorrect = (data.voted === data.correctSide && !data.isPerfect && msg.target !== msg.mainGuess);
            
            let resultBadge = "";
            let resultCls = "";
            if (data.isPerfect) { resultBadge = "メインが完璧"; resultCls = "score-miss"; }
            else if (msg.target === msg.mainGuess) { resultBadge = "メインが完璧"; resultCls = "score-miss"; }
            else if (isCorrect) { resultBadge = "+1 🎯"; resultCls = "score-perfect"; }
            else { resultBadge = "+0 💨"; resultCls = "score-miss"; }

            scoresHtml += `
              <div class="history-item" style="animation:fadeIn 0.4s ease ${i * 0.1}s both">
                <div>
                  <strong>${esc(msg.playerNames[pid])}</strong>
                  <span style="color:var(--text-secondary);margin-left:8px">投票: ${voteStr}</span>
                </div>
                <span class="${resultCls}" style="font-weight:700">${resultBadge}</span>
              </div>`;
            i++;
          }
        });
      }

      $("#reveal-scores").innerHTML = scoresHtml;

      // Running scores
      const sortedTotal = Object.entries(msg.totalScores).sort((a, b) => b[1] - a[1]);
      $("#running-scores").innerHTML = '<p style="font-size:0.8rem;color:var(--text-secondary);width:100%;text-align:center;margin-bottom:4px">📊 累計スコア</p>' +
        sortedTotal.map(([pid, score]) => `<div class="score-chip"><span>${esc(msg.playerNames[pid])}</span><span class="pts">${score}pt</span></div>`).join("");

      // Controls
      const isHost = msg.host === state.playerId;
      $("#reveal-host-btn").style.display = isHost ? "block" : "none";
      $("#reveal-guest-wait").style.display = isHost ? "none" : "block";

      $("#btn-next-round").textContent = msg.isLastRound ? "🏆 最終結果を見る" : "➡️ 次のラウンドへ";

      if (hasPerfect) { setTimeout(() => { sfxPerfect(); launchConfetti(); }, 800); }
      else { setTimeout(() => sfxSuccess(), 600); }
      break;

    case "game_over":
      show("screen-final");
      const finalSorted = Object.entries(msg.totalScores).sort((a, b) => b[1] - a[1]);
      
      if (finalSorted.length > 0) {
        $("#final-winner-name").textContent = msg.playerNames[finalSorted[0][0]];
        $("#final-winner-score").textContent = `${finalSorted[0][1]} pts`;
      }

      $("#final-ranking").innerHTML = finalSorted.map(([pid, score], i) => `
        <div class="history-item" style="animation:fadeIn 0.4s ease ${i * 0.1}s both">
          <div class="flex-row gap-8">
            <span style="font-size:1.3rem">${i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "　"}</span>
            <strong>${esc(msg.playerNames[pid])}</strong>
          </div>
          <span style="font-weight:700;font-size:1.1rem">${score} pts</span>
        </div>`
      ).join("");

      $("#final-history").innerHTML = msg.history.map(h => `
        <div class="history-item">
          <div>
            <span style="color:var(--text-secondary)">R${h.round}</span>
            <span style="margin:0 6px">${h.topic[0]} ⇄ ${h.topic[1]}</span>
          </div>
          <span style="color:var(--text-secondary)">🎯 ${h.target} (予想: ${h.mainGuess})</span>
        </div>`
      ).join("");

      setTimeout(() => { sfxPerfect(); launchConfetti(); }, 500);
      break;
  }
}

function getPlayerName(id) {
  const p = state.players.find(p => p.id === id);
  return p ? p.name : "???";
}

// --- Lobby ---
function updateLobby(players, hostId) {
  state.players = players;
  state.isHost = (state.playerId === hostId);

  $("#lobby-room-code").textContent = state.roomCode;
  $("#lobby-player-count").textContent = `(${players.length}人)`;

  $("#lobby-player-list").innerHTML = players.map((p, i) => `
    <div class="player-item" style="animation:fadeIn 0.3s ease ${i * 0.05}s both">
      <span class="name">${esc(p.name)} ${p.id === state.playerId ? "(あなた)" : ""}</span>
      ${p.id === hostId ? '<span class="role role-hinter">👑 ホスト</span>' : ''}
    </div>
  `).join("");

  $("#host-controls").style.display = state.isHost ? "block" : "none";
  $("#guest-waiting").style.display = state.isHost ? "none" : "block";
}

// --- Chat ---
function addChatMessage(name, message) {
  const isSystem = name === "📢 システム";
  const chatMsgs = $("#chat-messages");
  const el = document.createElement("div");
  el.className = "chat-msg";
  if (isSystem) {
    el.style.color = "var(--text-secondary)";
    el.style.textAlign = "center";
    el.innerHTML = esc(message);
  } else {
    el.innerHTML = `<span class="chat-msg-name">${esc(name)}:</span>${esc(message)}`;
    sfxChat();
  }
  chatMsgs.appendChild(el);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;

  if ($("#chat-body").style.display === "none" && !isSystem) {
    state.chatUnread++;
    $("#chat-badge").textContent = state.chatUnread;
    $("#chat-badge").style.display = "flex";
  }
}

// --- Init UI ---
function init() {
  connectWebSocket();

  // Auto-fill room code from URL query param
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get("room");
  if (roomFromUrl) {
    $("#room-code-input").value = roomFromUrl.toUpperCase();
  }

  // Create room
  $("#btn-create-room").addEventListener("click", () => {
    const name = $("#my-name-input").value.trim();
    if (!name) { showToast("名前を入力してください"); return; }
    state.myName = name;
    sendMsg({ type: "create_room", name });
    sfxClick();
  });

  // Join room
  $("#btn-join-room").addEventListener("click", () => {
    const name = $("#my-name-input").value.trim();
    const code = $("#room-code-input").value.trim();
    if (!name) { showToast("名前を入力してください"); return; }
    if (!code || code.length !== 4) { showToast("4桁のルームコードを入力してください"); return; }
    state.myName = name;
    sendMsg({ type: "join_room", name, code });
    sfxClick();
  });

  // Copy code
  $("#btn-copy-code").addEventListener("click", () => {
    navigator.clipboard.writeText(state.roomCode).then(() => showToast("📋 コードをコピーしました"));
  });

  // Copy join link
  $("#btn-copy-link").addEventListener("click", () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
    navigator.clipboard.writeText(link).then(() => showToast("🔗 参加リンクをコピーしました"));
  });

  // Round chips
  $$("#round-chips .chip").forEach(c => {
    c.addEventListener("click", () => {
      if (!state.isHost) return;
      $$("#round-chips .chip").forEach(ch => ch.classList.remove("active"));
      c.classList.add("active");
      state.maxRounds = parseInt(c.dataset.val);
      sfxClick();
    });
  });

  // Start game
  $("#btn-start-game").addEventListener("click", () => {
    sendMsg({ type: "start_game", maxRounds: state.maxRounds });
    sfxClick();
  });

  // Submit hint
  $("#btn-submit-hint").addEventListener("click", () => {
    const hint = $("#hint-input").value.trim();
    if (!hint) { showToast("ヒントを入力してください"); return; }
    sendMsg({ type: "submit_hint", hint });
    sfxClick();
  });
  $("#hint-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-submit-hint").click();
  });

  // Skip topic
  $("#btn-skip-topic").addEventListener("click", () => {
    sendMsg({ type: "skip_topic" });
    sfxClick();
  });

  // Main Guess Slider
  $("#mguess-slider").addEventListener("input", (e) => {
    $("#mguess-slider-value").textContent = e.target.value;
    $("#mguess-marker").style.left = `${e.target.value}%`;
  });

  // Submit Main Guess
  $("#btn-submit-mguess").addEventListener("click", () => {
    const guess = parseInt($("#mguess-slider").value);
    sendMsg({ type: "submit_main_guess", guess });
    $("#mguess-controls").style.display = "none";
    $("#mguess-waiting").style.display = "block";
    $("#mguess-main-guesser-name").textContent = "あなた";
    sfxClick();
  });

  // Submit L/R Guess
  $("#btn-lr-left").addEventListener("click", () => {
    state.currentVote = "left";
    $("#btn-lr-left").classList.add("btn-lr-selected");
    $("#btn-lr-right").classList.remove("btn-lr-selected");
    sendMsg({ type: "submit_lr_guess", guess: "left" });
    sfxClick();
  });
  $("#btn-lr-right").addEventListener("click", () => {
    state.currentVote = "right";
    $("#btn-lr-right").classList.add("btn-lr-selected");
    $("#btn-lr-left").classList.remove("btn-lr-selected");
    sendMsg({ type: "submit_lr_guess", guess: "right" });
    sfxClick();
  });

  // Next round
  $("#btn-next-round").addEventListener("click", () => {
    sendMsg({ type: "next_round" });
    sfxClick();
  });

  // Back to lobby / Leave
  $("#btn-back-lobby").addEventListener("click", () => window.location.href = "/");
  $("#btn-leave-lobby").addEventListener("click", () => window.location.href = "/");

  // Rules
  $("#btn-rules").addEventListener("click", () => $("#modal-rules").classList.add("active"));
  $("#btn-close-rules").addEventListener("click", () => $("#modal-rules").classList.remove("active"));
  
  // Modals background click
  $$(".modal-overlay").forEach(m => {
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("active"); });
  });

  // Chat
  $("#btn-chat-toggle").addEventListener("click", () => {
    const body = $("#chat-body");
    if (body.style.display === "none") {
      body.style.display = "flex";
      state.chatUnread = 0;
      $("#chat-badge").style.display = "none";
    } else {
      body.style.display = "none";
    }
  });

  $("#btn-chat-close").addEventListener("click", () => $("#chat-body").style.display = "none");

  $("#btn-chat-send").addEventListener("click", () => {
    const msg = $("#chat-input").value.trim();
    if (!msg) return;
    sendMsg({ type: "chat", message: msg });
    $("#chat-input").value = "";
  });
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-chat-send").click();
  });

  // Sound toggle
  $("#btn-sound-toggle").addEventListener("click", () => {
    state.soundEnabled = !state.soundEnabled;
    $("#btn-sound-toggle").textContent = state.soundEnabled ? "🔊" : "🔇";
    showToast(state.soundEnabled ? "サウンド ON" : "サウンド OFF");
  });

  // Share results
  $("#btn-share").addEventListener("click", () => {
    const hist = $$("#final-ranking .history-item");
    let text = "🌊 Wavelength 結果\n" + "━".repeat(20) + "\n";
    hist.forEach((el, i) => {
      const parts = el.innerText.split("\n");
      text += `${parts[0]} ${parts[1]}\n`;
    });
    navigator.clipboard.writeText(text).then(() => showToast("📋 コピーしました"));
  });
}

document.addEventListener("DOMContentLoaded", init);
