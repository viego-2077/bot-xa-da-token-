const { Client } = require("discord.js-selfbot-v13");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ===============================================
const OWNER_ID = "1420559803046039582";
const LOG_FILE = path.join(__dirname, "log.txt");
const STATE_FILE = path.join(__dirname, "state.json");
// ===============================================

function log(message, tokenIndex = null) {
    const ts = new Date().toISOString();
    const prefix = tokenIndex !== null ? `[Token${tokenIndex + 1}]` : '[Core]';
    const line = `${ts} ${prefix} ${message}`;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

let ffmpegPath = "ffmpeg";
try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic) ffmpegPath = ffmpegStatic;
} catch (e) {
    log("Không tìm thấy ffmpeg-static.");
}

function loadTokens() {
    try {
        const data = fs.readFileSync("tokens.txt", "utf8");
        return data.split("\n").map(t => t.trim()).filter(t => t.length > 0);
    } catch (err) {
        log("Không thể đọc tokens.txt: " + err.message);
        process.exit(1);
    }
}

const tokens = loadTokens();
if (tokens.length === 0) {
    log("tokens.txt trống!");
    process.exit(1);
}

// ================= STATE PER BOT =================
const stateMap = new Map();

function defaultState() {
    return {
        connection: null,
        player: null,
        currentResource: null,
        volume: 1.0,
        fxType: 'none',
        fxValue: 0,
        shuffleMode: false,
        activeVoiceChannel: null,
        speakingInterval: null,
        currentFile: null,
        currentChannelId: null,
        ffmpegProcess: null,
        playStartTime: null,
        pausedAt: null,
        restored: false, // đánh dấu đã restore xong chưa
    };
}

function getState(client) {
    if (!stateMap.has(client.user.id)) {
        stateMap.set(client.user.id, defaultState());
    }
    return stateMap.get(client.user.id);
}

// ================= PERSISTENT STATE =================
function savePersistentState(userId) {
    // Đọc file hiện tại, không ghi đè toàn bộ
    let data = {};
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            if (raw.trim()) data = JSON.parse(raw);
        }
    } catch(e) {
        log(`Loi doc state.json: ${e.message}`);
    }

    const s = stateMap.get(userId);
    if (!s) return;

    data[userId] = {
        activeVoiceChannel: s.activeVoiceChannel,
        currentChannelId: s.currentChannelId,
        shuffleMode: s.shuffleMode,
        currentFile: s.currentFile,
        fxType: s.fxType,
        fxValue: s.fxValue,
        volume: s.volume,
    };

    try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch(e) {
        log(`Loi ghi state.json: ${e.message}`);
    }
}

function loadPersistentState(userId) {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            if (raw.trim()) {
                const data = JSON.parse(raw);
                return data[userId] || null;
            }
        }
    } catch(e) {
        log(`Loi parse state.json: ${e.message}`);
    }
    return null;
}

// ================= FX FILTER =================
function buildFilterString(fxType, fxValue) {
    switch (fxType) {
        case 'bass': return `bass=g=${fxValue}`;
        case 'treble': return `treble=g=${fxValue}`;
        case 'echo': return `aecho=0.8:0.7:40:${fxValue || 0.5}`;
        case 'reverb': return `aecho=0.8:0.6:60:${fxValue || 0.4}`;
        case 'nightcore': return 'asetrate=44100*1.25,atempo=1.0';
        case 'slow': return 'asetrate=44100*0.8,atempo=1.0';
        case 'distortion': return `distortion=gain=${fxValue || 15}`;
        case 'compressor': return 'compand=attacks=0.1:decays=0.3:points=-70/-70|-30/-10|0/0:gain=5';
        case 'lowpass': return `lowpass=f=${fxValue || 1000}`;
        case 'highpass': return `highpass=f=${fxValue || 500}`;
        case 'stereo': return `pan=stereo|c0=c0*${1 - Math.max(0, fxValue)}|c1=c1*${1 - Math.max(0, -fxValue)}`;
        case 'volume': return `volume=${fxValue}`;
        default: return null;
    }
}

// ================= CREATE STREAM =================
function createFxStream(filePath, volume, fxType, fxValue, client, seekSeconds = 0) {
    const state = getState(client);
    if (state.ffmpegProcess) {
        try { state.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
        state.ffmpegProcess = null;
    }

    const filter = buildFilterString(fxType, fxValue);
    const args = [];
    if (seekSeconds > 0.1) {
        args.push('-ss', seekSeconds.toFixed(3));
    }
    args.push('-i', filePath);
    if (filter && fxType !== 'none') {
        args.push('-af', filter);
    }
    args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.ffmpegProcess = ffmpeg;

    ffmpeg.on('error', err => log(`FFmpeg error: ${err.message}`, client.tokenIndex));
    ffmpeg.stderr.on('data', () => {});

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
    });
    resource.volume.setVolume(volume);
    return resource;
}

// ================= APPLY FX =================
async function applyFxNow(client) {
    const state = getState(client);
    if (!state.player || !state.currentFile) return;
    const status = state.player.state.status;
    if (status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Paused) return;

    let elapsed = 0;
    if (state.playStartTime) {
        elapsed = (Date.now() - state.playStartTime) / 1000;
    }
    if (elapsed < 0 || isNaN(elapsed)) elapsed = 0;

    const wasPaused = status === AudioPlayerStatus.Paused;
    const newResource = createFxStream(state.currentFile, state.volume, state.fxType, state.fxValue, client, elapsed);
    state.currentResource = newResource;
    state.player.play(newResource);

    if (wasPaused) {
        const check = setInterval(() => {
            if (state.player && state.player.state.status === AudioPlayerStatus.Playing) {
                state.player.pause();
                clearInterval(check);
            }
        }, 50);
    }

    state.playStartTime = Date.now() - elapsed * 1000;
    state.pausedAt = wasPaused ? Date.now() : null;
    log(`FX: ${state.fxType}=${state.fxValue}`, client.tokenIndex);
    savePersistentState(client.user.id);
}

// ================= HEARTBEAT =================
function startHeartbeat(connection, state) {
    if (state.speakingInterval) clearInterval(state.speakingInterval);
    state.speakingInterval = setInterval(() => {
        if (connection && connection.state.status === VoiceConnectionStatus.Ready) {
            try { connection.setSpeaking(true); } catch(e) {}
        }
    }, 20000);
}

// ================= JOIN VOICE WITH RETRY =================
async function safeJoinVoice(channel, client, retries = 3) {
    const state = getState(client);
    let lastError = null;
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                state.connection.destroy();
            }
            
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                group: client.user.id,
                selfMute: false,
                selfDeaf: true
            });
            
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            return connection;
        } catch (err) {
            lastError = err;
            log(`Join voice attempt ${attempt + 1} failed: ${err.message}`, client.tokenIndex);
            // Đợi 3 giây rồi thử lại
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    throw lastError || new Error("Khong the join voice");
}

// ================= PLAY MUSIC =================
async function playMusic(filePath, channelId, client) {
    const state = getState(client);
    try {
        if (!fs.existsSync(filePath)) throw new Error("File khong ton tai");
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isVoice()) throw new Error("Kenh khong phai voice");

        state.playStartTime = null;
        state.pausedAt = null;

        const resource = createFxStream(filePath, state.volume, state.fxType, state.fxValue, client, 0);
        state.currentResource = resource;
        state.currentFile = filePath;
        state.currentChannelId = channelId;
        state.shuffleMode = false;

        if (state.player) {
            state.player.removeAllListeners();
            state.player.stop();
        }
        state.player = createAudioPlayer();
        state.player.on(AudioPlayerStatus.Playing, () => {
            if (!state.playStartTime) {
                state.playStartTime = Date.now();
                state.pausedAt = null;
            }
            log(`Dang phat: ${path.basename(filePath)} (fx=${state.fxType})`, client.tokenIndex);
        });
        state.player.on(AudioPlayerStatus.Idle, () => {
            log(`Phat xong`, client.tokenIndex);
            state.currentResource = null;
            state.currentFile = null;
            state.playStartTime = null;
            state.pausedAt = null;
            savePersistentState(client.user.id);
        });
        state.player.on('error', err => log(`Player error: ${err.message}`, client.tokenIndex));

        const connection = await safeJoinVoice(channel, client);
        connection.subscribe(state.player);
        state.player.play(resource);
        try { connection.setSpeaking(true); } catch(e) {}

        state.connection = connection;
        state.activeVoiceChannel = channelId;
        startHeartbeat(connection, state);
        state.restored = true;
        savePersistentState(client.user.id);

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            if (state.speakingInterval) clearInterval(state.speakingInterval);
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                if (state.shuffleMode) {
                    log("Reconnected, restart shuffle...", client.tokenIndex);
                    startShuffle(state.currentChannelId, client).catch(() => {});
                } else if (state.currentFile) {
                    log("Reconnected, replay...", client.tokenIndex);
                    playMusic(state.currentFile, state.currentChannelId, client).catch(() => {});
                }
            } catch (error) {
                state.activeVoiceChannel = null;
                state.connection = null;
                savePersistentState(client.user.id);
            }
        });

    } catch (error) {
        log(`Loi playMusic: ${error.message}`, client.tokenIndex);
    }
}

// ================= SHUFFLE =================
async function startShuffle(channelId, client) {
    const state = getState(client);
    const files = fs.readdirSync(process.cwd()).filter(f => /\.(mp3|wav)$/i.test(f));
    if (files.length === 0) throw new Error("Khong co file nhac");

    if (state.player) {
        state.player.removeAllListeners();
        state.player.stop();
    }
    if (state.ffmpegProcess) {
        try { state.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
        state.ffmpegProcess = null;
    }

    state.player = createAudioPlayer();
    state.player.on('error', err => log(`Player error: ${err.message}`, client.tokenIndex));

    const playNext = () => {
        if (!state.shuffleMode) return;
        const randomFile = files[Math.floor(Math.random() * files.length)];
        const filePath = path.resolve(process.cwd(), randomFile);
        state.playStartTime = Date.now();
        state.pausedAt = null;
        state.currentFile = filePath;
        state.currentChannelId = channelId;
        const resource = createFxStream(filePath, state.volume, state.fxType, state.fxValue, client, 0);
        state.currentResource = resource;
        state.player.play(resource);
        savePersistentState(client.user.id);
        log(`Shuffle: ${randomFile}`, client.tokenIndex);
    };

    state.player.on(AudioPlayerStatus.Idle, () => {
        if (state.shuffleMode) playNext();
        else {
            state.currentResource = null;
            state.currentFile = null;
            state.playStartTime = null;
            savePersistentState(client.user.id);
        }
    });

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isVoice()) throw new Error("Kenh khong phai voice");

    const connection = await safeJoinVoice(channel, client);
    connection.subscribe(state.player);
    playNext();
    try { connection.setSpeaking(true); } catch(e) {}

    state.connection = connection;
    state.activeVoiceChannel = channelId;
    state.shuffleMode = true;
    startHeartbeat(connection, state);
    state.restored = true;
    savePersistentState(client.user.id);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (state.speakingInterval) clearInterval(state.speakingInterval);
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            if (state.shuffleMode) {
                log("Reconnected, restart shuffle...", client.tokenIndex);
                startShuffle(channelId, client).catch(() => {});
            }
        } catch (err) {
            state.activeVoiceChannel = null;
            state.connection = null;
            savePersistentState(client.user.id);
        }
    });
}

// ================= RESTORE SESSION =================
async function restoreSession(client) {
    // Đợi 1 chút để session cũ kịp timeout
    await new Promise(r => setTimeout(r, 2000));

    const cfg = loadPersistentState(client.user.id);
    if (!cfg || !cfg.activeVoiceChannel) {
        log("Khong co state de khoi phuc (da exit truoc do)", client.tokenIndex);
        return;
    }

    const state = getState(client);
    state.volume = cfg.volume || 1.0;
    state.fxType = cfg.fxType || 'none';
    state.fxValue = cfg.fxValue || 0;
    state.shuffleMode = cfg.shuffleMode || false;
    state.currentFile = cfg.currentFile || null;
    state.currentChannelId = cfg.currentChannelId || cfg.activeVoiceChannel;

    if (!state.currentChannelId) {
        log("Khong co channel de restore", client.tokenIndex);
        return;
    }

    try {
        const channel = await client.channels.fetch(state.currentChannelId);
        if (!channel?.isVoice()) {
            log("Kenh khong ton tai hoac khong phai voice", client.tokenIndex);
            // Xóa state cũ vì channel không hợp lệ
            state.activeVoiceChannel = null;
            state.shuffleMode = false;
            state.currentFile = null;
            savePersistentState(client.user.id);
            return;
        }

        if (state.shuffleMode) {
            log("Khoi phuc shuffle...", client.tokenIndex);
            await startShuffle(state.currentChannelId, client);
        } else if (state.currentFile) {
            log(`Khoi phuc phat bai: ${path.basename(state.currentFile)}`, client.tokenIndex);
            await playMusic(state.currentFile, state.currentChannelId, client);
        } else {
            log("Khoi phuc join voice (khong phat)...", client.tokenIndex);
            const connection = await safeJoinVoice(channel, client);
            state.connection = connection;
            state.activeVoiceChannel = state.currentChannelId;
            startHeartbeat(connection, state);
            state.restored = true;
            savePersistentState(client.user.id);
        }
    } catch (err) {
        log(`Khong the khoi phuc: ${err.message}`, client.tokenIndex);
    }
}

// ================= INIT CLIENTS =================
const clients = [];

for (let i = 0; i < tokens.length; i++) {
    const client = new Client();
    client.tokenIndex = i;
    client.token = tokens[i];

    client.on("ready", async () => {
        log(`Ready! ${client.user.tag} (${client.user.id})`, client.tokenIndex);
        // Khởi tạo state trong RAM ngay
        getState(client);
        // Restore session (có delay 2s bên trong)
        await restoreSession(client);
    });

    client.on("messageCreate", async (msg) => {
        if (msg.author.id !== OWNER_ID) return;
        if (!msg.content.startsWith(".")) return;

        const rawArgs = msg.content.slice(1).trim().split(/\s+/);
        let cmd = rawArgs.shift().toLowerCase();

        let tokenIdx = -1;
        if (rawArgs.length > 0 && /^token\d+$/i.test(rawArgs[0])) {
            tokenIdx = parseInt(rawArgs[0].slice(5)) - 1;
            rawArgs.shift();
        }

        if (tokenIdx !== -1 && client.tokenIndex !== tokenIdx) return;
        const canSend = () => tokenIdx === -1 ? client.tokenIndex === 0 : client.tokenIndex === tokenIdx;

        try {
            if (cmd === "xa") {
                const state = getState(client);
                state.shuffleMode = false;
                if (state.speakingInterval) clearInterval(state.speakingInterval);

                if (rawArgs.length < 2) {
                    if (canSend()) await msg.channel.send("`.xa [token<so>] <file> <id_kenh>`");
                    return;
                }
                const filePath = path.resolve(process.cwd(), rawArgs[0]);
                if (!fs.existsSync(filePath)) {
                    if (canSend()) await msg.channel.send(`Khong tim thay: \`${rawArgs[0]}\``);
                    return;
                }
                if (canSend()) await msg.channel.send(`Phat \`${rawArgs[0]}\` o <#${rawArgs[1]}>`);
                await playMusic(filePath, rawArgs[1], client);
            }
            else if (cmd === "shuffle") {
                const state = getState(client);
                if (state.shuffleMode) {
                    state.shuffleMode = false;
                    if (state.player) state.player.stop();
                    if (canSend()) await msg.channel.send("Da dung shuffle");
                    savePersistentState(client.user.id);
                    return;
                }
                if (rawArgs.length < 1) {
                    if (canSend()) await msg.channel.send("`.shuffle [token] <id_kenh>`");
                    return;
                }
                state.shuffleMode = true;
                if (canSend()) await msg.channel.send(`Shuffle <#${rawArgs[0]}>`);
                await startShuffle(rawArgs[0], client);
            }
            else if (cmd === "volume") {
                const val = parseInt(rawArgs[0]);
                if (isNaN(val) || val < 0 || val > 5000) {
                    if (canSend()) await msg.channel.send("0-5000%");
                    return;
                }
                const state = getState(client);
                state.volume = val / 100;
                if (state.currentResource?.volume) state.currentResource.volume.setVolume(state.volume);
                if (canSend()) await msg.channel.send(`Volume: ${val}%`);
                savePersistentState(client.user.id);
            }
            else if (cmd === "fx") {
                const state = getState(client);
                if (rawArgs.length < 1) {
                    if (canSend()) await msg.channel.send(
                        "`.fx [token] <loai> [cuong do]`\n" +
                        "bass | treble | echo | reverb | nightcore | slow | distortion | compressor | lowpass | highpass | stereo | volume | none"
                    );
                    return;
                }
                const type = rawArgs[0].toLowerCase();
                let value = 0;
                if (rawArgs.length > 1) {
                    value = parseFloat(rawArgs[1]);
                    if (isNaN(value)) value = 0;
                }
                const defaults = {
                    bass: 12, treble: 10, echo: 0.5, reverb: 0.4, distortion: 15,
                    lowpass: 1000, highpass: 500, stereo: 0, volume: 2
                };
                if (rawArgs.length === 1 && type !== 'none' && type !== 'nightcore' && type !== 'slow' && type !== 'compressor') {
                    value = defaults[type] || 0;
                }
                state.fxType = type;
                state.fxValue = value;
                const fxLabel = type === 'none' ? 'Tat FX' : `${type} (${value})`;
                if (canSend()) await msg.channel.send(`FX: **${fxLabel}**`);
                await applyFxNow(client);
            }
            else if (cmd === "stop") {
                const state = getState(client);
                state.shuffleMode = false;
                if (state.player) {
                    state.player.stop();
                    state.currentResource = null;
                    state.currentFile = null;
                    state.playStartTime = null;
                    state.pausedAt = null;
                    if (state.ffmpegProcess) {
                        try { state.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
                        state.ffmpegProcess = null;
                    }
                    if (canSend()) await msg.channel.send("Da dung");
                }
                savePersistentState(client.user.id);
            }
            else if (cmd === "pause") {
                const state = getState(client);
                if (state.player?.state.status === AudioPlayerStatus.Playing) {
                    state.player.pause();
                    state.pausedAt = Date.now();
                    if (canSend()) await msg.channel.send("Tam dung");
                }
            }
            else if (cmd === "resume") {
                const state = getState(client);
                if (state.player?.state.status === AudioPlayerStatus.Paused) {
                    state.player.unpause();
                    if (state.pausedAt && state.playStartTime) {
                        state.playStartTime += Date.now() - state.pausedAt;
                        state.pausedAt = null;
                    }
                    if (canSend()) await msg.channel.send("Tiep tuc");
                }
            }
            else if (cmd === "exit") {
                const state = getState(client);
                state.shuffleMode = false;
                if (state.speakingInterval) clearInterval(state.speakingInterval);
                if (state.connection) {
                    state.connection.destroy();
                    state.connection = null;
                    state.activeVoiceChannel = null;
                }
                if (state.player) {
                    state.player.removeAllListeners();
                    state.player.stop();
                    state.player = null;
                }
                if (state.ffmpegProcess) {
                    try { state.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
                    state.ffmpegProcess = null;
                }
                state.currentResource = null;
                state.currentFile = null;
                state.playStartTime = null;
                state.pausedAt = null;
                state.restored = false;
                if (canSend()) await msg.channel.send("Da roi voice");
                savePersistentState(client.user.id);
            }
            else if (cmd === "list") {
                if (!canSend()) return;
                const files = fs.readdirSync(process.cwd()).filter(f => /\.(mp3|wav)$/i.test(f));
                await msg.channel.send(files.length ? `\`\`\`\n${files.map((f,i)=>`${i+1}. ${f}`).join("\n")}\n\`\`\`` : "Khong co file");
            }
            else if (cmd === "token") {
                if (client.tokenIndex !== 0) return;
                const lines = clients.map(c => {
                    const s = getState(c);
                    const vc = s.activeVoiceChannel ? `<#${s.activeVoiceChannel}>` : "-";
                    const fx = s.fxType === 'none' ? 'Tat' : `${s.fxType} (${s.fxValue})`;
                    const vol = Math.round(s.volume * 100);
                    let status = "Dung";
                    if (s.player) {
                        const st = s.player.state.status;
                        if (st === AudioPlayerStatus.Playing) status = "Dang phat";
                        else if (st === AudioPlayerStatus.Paused) status = "Tam dung";
                    }
                    const file = s.currentFile ? path.basename(s.currentFile) : "-";
                    return `Token${c.tokenIndex+1}: ${status} | File: ${file} | Voice: ${vc} | FX: ${fx} | Vol: ${vol}%`;
                });
                await msg.channel.send(`**Trang thai Token**\n${lines.join("\n")}`);
            }
            else if (cmd === "help") {
                if (!canSend()) return;
                await msg.channel.send(`
**Arashy-X Audio Injector**
\`.xa [token] <file> <channel>\` - Phat file
\`.shuffle [token] <channel>\` - Shuffle
\`.volume [token] <0-5000>\` - Am luong
\`.fx [token] <loai> [cuong do]\` - Hieu ung
\`.pause / .resume / .stop / .exit\`
\`.list\` - Danh sach file
\`.token\` - Trang thai
\`.help\` - Menu
\t\t\t\t`);
            }
        } catch (err) {
            log(`Loi lenh ${cmd}: ${err.message}`, client.tokenIndex);
            if (canSend()) await msg.channel.send(`Loi: ${err.message}`).catch(() => {});
        }
    });

    clients.push(client);
}

// ================= LOGIN =================
(async () => {
    for (let i = 0; i < clients.length; i++) {
        try {
            await clients[i].login(tokens[i]);
            log(`Login OK`, i);
        } catch (err) {
            log(`Login FAILED: ${err.message}`, i);
        }
    }
})();

process.on('unhandledRejection', (err) => {
    log(`Unhandled: ${err?.message}`, null);
});