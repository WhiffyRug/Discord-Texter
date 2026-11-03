const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');

const PORT = process.env.PORT || 3000;
const DASH_PASS = process.env.DASH_PASS || 'opencord2026';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const DB = path.join(__dirname, 'data.json');
let accounts = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : [];
const saveAccounts = () => fs.writeFileSync(DB, JSON.stringify(accounts, null, 2));

const activeClients = {}; // id -> { client, timer, lastReply }

// Intelligent Gemini text generator supporting multiple language/vibe styles
async function generateGeminiMessage(acc, transcriptHistory, mode) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY environment variable is missing!");

  const languagePromptStyle = acc.langMode === 'hinglish' 
    ? "Mix casual Hindi and English words naturally (Hinglish texting style like 'bhai', 'sahi hai', 'kya scene hai')."
    : acc.langMode === 'hindi'
    ? "Write in casual conversational Hindi using Roman script."
    : "Write in casual, natural English text.";

  const DEFAULT_PERSONA = "You are a genuine, chill person chatting naturally in a Discord channel. Write short, casual responses (1-2 sentences). Use natural phrasing, lowercase style, light slang, or Hinglish/Hindi mix depending on context. Never sound like a robot or AI. If asked, act like a regular human user.";

  const systemInstructions = `${acc.persona || DEFAULT_PERSONA}\nLanguage Style: ${languagePromptStyle}\n\nRule: Keep it 100% human, casual, and context-aware. Output ONLY the message text without quotes or labels.`;

  const taskPrompt = mode === 'start'
    ? "Review the recent chat context above. Send ONE natural opening statement or reply that fits right into the current vibe or starts a light conversation."
    : "Read the recent chat transcript and write a direct, genuine reply to the latest messages like a real user in chat.";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstructions }] },
        contents: [{ role: 'user', parts: [{ text: transcriptHistory || '(chat is quiet)' + '\n\nTask: ' + taskPrompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.85 },
      }),
    }
  );

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Gemini API Error ' + response.status);
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
}

async function fetchChannelTranscript(channel, limit = 10) {
  try {
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()].reverse().map(m => `${m.author.username}: ${m.content}`).join('\n');
  } catch {
    return '';
  }
}

// Initialize Selfbot Client connection
async function startAccountClient(acc) {
  stopAccountClient(acc.id);
  
  const client = new Client({ checkUpdate: false });
  const state = { client, timer: null, lastReply: {}, status: 'connecting' };
  activeClients[acc.id] = state;

  client.on('ready', async () => {
    state.status = 'online';
    acc.name = client.user.tag;
    acc.avatar = client.user.displayAvatarURL();
    saveAccounts();
    console.log(`[OpenCord] Account online: ${client.user.tag}`);

    // Automated 24/7 background conversation starter loop
    const intervalMinutes = Math.max(5, acc.interval || 20);
    state.timer = setInterval(async () => {
      try {
        if (!acc.enabled || !acc.channels || acc.channels.length === 0) return;
        const randomChanId = acc.channels[Math.floor(Math.random() * acc.channels.length)];
        const channel = await client.channels.fetch(randomChanId).catch(() => null);
        if (!channel) return;

        await channel.sendTyping();
        const history = await fetchChannelTranscript(channel, 12);
        const replyText = await generateGeminiMessage(acc, history, 'start');
        
        if (replyText) {
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000)); // Natural human typing lag
          await channel.send(replyText);
        }
      } catch (err) {
        console.error(`[TokenTexter Start Error - ${acc.name}]:`, err.message);
      }
    }, intervalMinutes * 60000);
  });

  // Listen for incoming messages to reply organically
  client.on('messageCreate', async (message) => {
    try {
      if (!acc.enabled || !acc.channels.includes(message.channelId)) return;
      if (message.author.id === client.user.id) return; // Ignore self

      const meId = client.user.id;
      const isMentioned = message.mentions.has(meId);
      const isReplyToMe = message.reference && (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === meId;
      const randomEngage = Math.random() < 0.35; // 35% chance to participate in active chat context naturally

      if (!isMentioned && !isReplyToMe && !randomEngage) return;

      const now = Date.now();
      const channelCooldown = state.lastReply[message.channelId] || 0;
      if (now - channelCooldown < 30000) return; // 30s cooldown per channel to look genuine
      state.lastReply[message.channelId] = now;

      await message.channel.sendTyping();
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 3000)); // lag delay

      const history = await fetchChannelTranscript(message.channel, 10);
      const responseText = await generateGeminiMessage(acc, history, 'reply');

      if (responseText) {
        if (Math.random() > 0.5) {
          await message.reply(responseText); // reply directly dragging context
        } else {
          await message.channel.send(responseText);
        }
      }
    } catch (err) {
      console.error('[TokenTexter Reply Error]:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error(`[Client Error ${acc.id}]:`, err.message);
    state.status = 'error';
  });

  try {
    await client.login(acc.token);
  } catch (err) {
    state.status = 'failed';
    console.error(`[Login Failed for Account ${acc.id}]:`, err.message);
  }
}

function stopAccountClient(id) {
  if (activeClients[id]) {
    if (activeClients[id].timer) clearInterval(activeClients[id].timer);
    try { activeClients[id].client.destroy(); } catch {}
    delete activeClients[id];
  }
}

// Express App Setup
const app = express();
app.use(express.json());

// Basic HTTP Authentication Middleware for safety
app.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [, token] = authHeader.split(' ');
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Basic realm="OpenCord Console"');
    return res.status(401).send('Authentication required.');
  }
  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
  if (pass === DASH_PASS || user === 'admin') return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="OpenCord Console"');
  return res.status(401).send('Invalid credentials.');
});

// Public account serializer helper
const sanitizeAccount = (a) => ({
  id: a.id,
  name: a.name || 'Account',
  avatar: a.avatar || '',
  enabled: a.enabled,
  interval: a.interval || 20,
  langMode: a.langMode || 'hinglish',
  persona: a.persona || "You are a genuine, chill person chatting naturally in a Discord channel. Write short, casual responses (1-2 sentences). Use natural phrasing, lowercase style, light slang, or Hinglish/Hindi mix depending on context. Never sound like a robot or AI. If asked, act like a regular human user.",
  channels: a.channels || [],
  status: activeClients[a.id]?.status || 'offline'
});

// API Routes
app.get('/api/accounts', (req, res) => {
  res.json(accounts.map(sanitizeAccount));
});

app.post('/api/accounts', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Discord Token is required!' });

  const newAcc = {
    id: Date.now().toString(36),
    token,
    name: 'Connecting...',
    avatar: '',
    enabled: false,
    interval: 20,
    langMode: 'hinglish',
    persona: "You are a genuine, chill person chatting naturally in a Discord channel. Write short, casual responses (1-2 sentences). Use natural phrasing, lowercase style, light slang, or Hinglish/Hindi mix depending on context. Never sound like a robot or AI. If asked, act like a regular human user.",
    channels: []
  };

  accounts.push(newAcc);
  saveAccounts();

  try {
    await startAccountClient(newAcc);
    res.json(sanitizeAccount(newAcc));
  } catch (e) {
    accounts = accounts.filter(x => x.id !== newAcc.id);
    saveAccounts();
    res.status(400).json({ error: 'Token login failed: ' + e.message });
  }
});

app.get('/api/accounts/:id/guilds', async (req, res) => {
  const state = activeClients[req.params.id];
  if (!state || state.status !== 'online') {
    return res.status(400).json({ error: 'Account is not online/connected yet.' });
  }
  const guildsData = [];
  try {
    for (const guild of state.client.guilds.cache.values()) {
      const textChannels = guild.channels.cache
        .filter(c => c.type === 'GUILD_TEXT' || c.type === 0)
        .map(c => ({ id: c.id, name: c.name }));
      guildsData.push({ id: guild.id, name: guild.name, channels: textChannels });
    }
    res.json(guildsData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch servers: ' + err.message });
  }
});

app.post('/api/accounts/:id', async (req, res) => {
  const acc = accounts.find(x => x.id === req.params.id);
  if (!acc) return res.sendStatus(404);

  const { enabled, interval, langMode, persona, channels } = req.body;
  if (enabled !== undefined) acc.enabled = !!enabled;
  if (interval) acc.interval = parseInt(interval);
  if (langMode) acc.langMode = langMode;
  if (persona !== undefined) acc.persona = persona;
  if (channels) acc.channels = channels;

  saveAccounts();
  await startAccountClient(acc).catch(console.error);
  res.json(sanitizeAccount(acc));
});

app.delete('/api/accounts/:id', (req, res) => {
  stopAccountClient(req.params.id);
  accounts = accounts.filter(x => x.id !== req.params.id);
  saveAccounts();
  res.sendStatus(204);
});

// Serve frontend interface
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Boot up saved accounts on startup
accounts.forEach(acc => {
  startAccountClient(acc).catch(err => console.error(`Failed booting ${acc.id}:`, err.message));
});

app.listen(PORT, () => {
  console.log(`[OpenCord] Server running live on port ${PORT}`);
});