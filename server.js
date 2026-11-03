// Discord Bot Dashboard — official bot tokens only
// Run: npm install && ANTHROPIC_API_KEY=xxx DASH_PASS=yourpass node server.js
const express = require('express');
const fs = require('fs');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const PASS = process.env.DASH_PASS || 'changeme';
const MODEL = 'claude-haiku-5-5';
const DB = './data.json';
const ai = new Anthropic(); // reads ANTHROPIC_API_KEY

let accounts = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : [];
const save = () => fs.writeFileSync(DB, JSON.stringify(accounts, null, 2));
const clients = {}; // id -> {client, timer, last}

const DEFAULT_PERSONA =
  'You are a chill, friendly member of this Discord server. Write short casual English like a normal person texting: lowercase ok, 1-2 sentences, light slang, occasional emoji. Match the vibe of the chat. Never use hashtags or long paragraphs. If someone sincerely asks whether you are a bot or AI, say yes honestly.';

async function think(acc, history, mode) {
  const sys = acc.persona || DEFAULT_PERSONA;
  const task = mode === 'start'
    ? 'Read the recent chat and post ONE natural message that fits the current topic or starts a light new topic. Output only the message.'
    : 'Reply naturally to the latest message. Output only the reply.';
  const r = await ai.messages.create({
    model: MODEL, max_tokens: 150, system: sys + '\n\n' + task,
    messages: [{ role: 'user', content: history || '(channel is quiet)' }],
  });
  return r.content.map(c => c.text || '').join('').trim();
}

async function transcript(channel, n = 12) {
  const msgs = await channel.messages.fetch({ limit: n });
  return [...msgs.values()].reverse().map(m => `${m.author.username}: ${m.content}`).join('\n');
}

async function start(acc) {
  stop(acc.id);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const state = { client, timer: null, lastReply: {}, status: 'connecting' };
  clients[acc.id] = state;

  client.on('messageCreate', async (m) => {
    try {
      if (m.author.bot || !acc.enabled || !acc.channels.includes(m.channelId)) return;
      const me = client.user.id;
      const mentioned = m.mentions.users.has(me);
      let isReplyToMe = false;
      if (m.reference?.messageId) {
        const ref = await m.channel.messages.fetch(m.reference.messageId).catch(() => null);
        isReplyToMe = ref?.author.id === me;
      }
      const greeting = /^(yo|hey|hi|sup|hello|gm)\b/i.test(m.content.trim()) && Math.random() < 0.5;
      if (!(mentioned || isReplyToMe || greeting)) return;
      const now = Date.now();
      if (now - (state.lastReply[m.channelId] || 0) < 20000) return; // 20s cooldown per channel
      state.lastReply[m.channelId] = now;
      await m.channel.sendTyping();
      const text = await think(acc, await transcript(m.channel), 'reply');
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
      if (text) await m.reply(text);
    } catch (e) { console.error('reply err', e.message); }
  });

  client.once('ready', () => {
    state.status = 'online';
    acc.name = client.user.tag; save();
    const mins = Math.max(10, acc.interval || 30); // min 10 min between starters
    state.timer = setInterval(async () => {
      try {
        if (!acc.enabled || !acc.channels.length) return;
        const id = acc.channels[Math.floor(Math.random() * acc.channels.length)];
        const ch = await client.channels.fetch(id);
        await ch.sendTyping();
        const text = await think(acc, await transcript(ch), 'start');
        if (text) await ch.send(text);
      } catch (e) { console.error('start err', e.message); }
    }, mins * 60000);
  });

  await client.login(acc.token);
}

function stop(id) {
  const s = clients[id];
  if (!s) return;
  clearInterval(s.timer);
  s.client.destroy();
  delete clients[id];
}

// ---------- web ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const [u, p] = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':');
  if (p === PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="dash"').status(401).send('Auth required');
});

const pub = a => ({ id: a.id, name: a.name, enabled: a.enabled, interval: a.interval,
  persona: a.persona || DEFAULT_PERSONA, channels: a.channels, status: clients[a.id]?.status || 'offline' });

app.get('/api/accounts', (_, res) => res.json(accounts.map(pub)));

app.post('/api/accounts', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token missing' });
  const acc = { id: Date.now().toString(36), token, name: 'connecting...', enabled: false,
    interval: 30, persona: '', channels: [] };
  try {
    accounts.push(acc); save();
    await start(acc);
    res.json(pub(acc));
  } catch (e) {
    accounts = accounts.filter(a => a.id !== acc.id); save(); stop(acc.id);
    res.status(400).json({ error: 'Login failed: ' + e.message });
  }
});

app.get('/api/accounts/:id/guilds', async (req, res) => {
  const s = clients[req.params.id];
  if (!s || s.status !== 'online') return res.status(400).json({ error: 'bot not online' });
  const out = [];
  for (const g of s.client.guilds.cache.values()) {
    const chans = (await g.channels.fetch()).filter(c => c && c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name }));
    out.push({ id: g.id, name: g.name, channels: [...chans.values ? chans.values() : chans] });
  }
  res.json(out);
});

app.post('/api/accounts/:id', (req, res) => {
  const a = accounts.find(x => x.id === req.params.id);
  if (!a) return res.sendStatus(404);
  const { enabled, interval, persona, channels } = req.body;
  if (enabled !== undefined) a.enabled = !!enabled;
  if (interval) a.interval = Math.max(10, +interval);
  if (persona !== undefined) a.persona = persona;
  if (channels) a.channels = channels;
  save();
  start(a).catch(console.error); // restart with new settings
  res.json(pub(a));
});

app.delete('/api/accounts/:id', (req, res) => {
  stop(req.params.id);
  accounts = accounts.filter(a => a.id !== req.params.id); save();
  res.sendStatus(204);
});

app.get('/', (_, res) => res.send(PAGE));

accounts.forEach(a => start(a).catch(e => console.error('boot fail', a.id, e.message)));
app.listen(PORT, () => console.log('Dashboard on http://localhost:' + PORT));

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord Bot Dashboard</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--tx:#1b1d22;--mu:#6b7280;--ac:#5865f2;--bd:#e3e5e9}
@media(prefers-color-scheme:dark){:root{--bg:#14151a;--card:#1e2028;--tx:#eceef2;--mu:#9aa0ac;--bd:#2d303a}}
*{box-sizing:border-box}body{margin:0;padding:14px;background:var(--bg);color:var(--tx);font:15px system-ui,sans-serif}
h1{font-size:19px;margin:4px 0 12px}.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:12px;margin-bottom:12px}
input,textarea,select{width:100%;padding:10px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);font:inherit;margin:4px 0}
button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:10px 14px;font:inherit;margin:4px 4px 0 0}
button.g{background:transparent;color:var(--tx);border:1px solid var(--bd)}button.r{background:#d83c3e}
.mu{color:var(--mu);font-size:13px}.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.ch{display:flex;gap:8px;align-items:center;padding:6px 0}.ch input{width:auto;margin:0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
</style></head><body>
<h1>🤖 Discord Bot Dashboard</h1>
<div class="card"><b>Add account</b>
<input id="tok" type="password" placeholder="Bot token (Developer Portal → Bot → Token)">
<button onclick="add()">Login & add</button><div id="err" class="mu"></div></div>
<div id="list"></div>
<script>
const $=id=>document.getElementById(id);
const api=(p,o)=>fetch('/api'+p,o&&{...o,headers:{'Content-Type':'application/json'},body:o.body&&JSON.stringify(o.body)}).then(async r=>{if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.status);return r.status==204?null:r.json()});
async function add(){$('err').textContent='';try{await api('/accounts',{method:'POST',body:{token:$('tok').value}});$('tok').value='';load()}catch(e){$('err').textContent=e.message}}
async function load(){const a=await api('/accounts');$('list').innerHTML=a.map(x=>\`<div class="card" id="a\${x.id}">
<div class="row"><b>\${x.name}</b><span class="mu"><span class="dot" style="background:\${x.status=='online'?'#23a55a':'#999'}"></span>\${x.status}</span></div>
<div class="mu">Chat \${x.enabled?'ON':'OFF'} · \${x.channels.length} channels · starter every \${x.interval} min</div>
<button onclick="picker('\${x.id}')">Servers & channels</button>
<button class="g" onclick="settings('\${x.id}')">Personality</button>
<button class="g" onclick="toggle('\${x.id}',\${!x.enabled})">\${x.enabled?'Pause':'Start'}</button>
<button class="r" onclick="del('\${x.id}')">Remove</button><div class="body"></div></div>\`).join('')||'<p class="mu">No accounts yet.</p>';window.A=a}
async function picker(id){const box=document.querySelector('#a'+id+' .body'),acc=A.find(x=>x.id==id);box.innerHTML='Loading...';
try{const g=await api('/accounts/'+id+'/guilds');box.innerHTML=g.map(s=>'<p><b>'+s.name+'</b></p>'+s.channels.map(c=>'<label class="ch"><input type="checkbox" value="'+c.id+'" '+(acc.channels.includes(c.id)?'checked':'')+'> #'+c.name+'</label>').join('')).join('')+'<button onclick="saveCh(\\''+id+'\\')">Save channels</button>'}catch(e){box.textContent=e.message}}
async function saveCh(id){const ch=[...document.querySelectorAll('#a'+id+' .ch input:checked')].map(i=>i.value);await api('/accounts/'+id,{method:'POST',body:{channels:ch}});load()}
function settings(id){const acc=A.find(x=>x.id==id);document.querySelector('#a'+id+' .body').innerHTML='<textarea id="p'+id+'" rows="6">'+acc.persona+'</textarea><input id="i'+id+'" type="number" min="10" value="'+acc.interval+'"><div class="mu">Starter interval in minutes (min 10)</div><button onclick="saveSet(\\''+id+'\\')">Save</button>'}
async function saveSet(id){await api('/accounts/'+id,{method:'POST',body:{persona:$('p'+id).value,interval:$('i'+id).value}});load()}
async function toggle(id,v){await api('/accounts/'+id,{method:'POST',body:{enabled:v}});load()}
async function del(id){if(confirm('Remove?')){await api('/accounts/'+id,{method:'DELETE'});load()}}
load();
</script></body></html>`;
