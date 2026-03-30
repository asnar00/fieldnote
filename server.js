const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');

const app = express();
const PORT = 8083;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VERSION_PATH = path.join(__dirname, 'version.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---- Version counter ----
function getVersion() {
  try { return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8')).version; }
  catch { return 0; }
}
function incrementVersion() {
  const v = getVersion() + 1;
  fs.writeFileSync(VERSION_PATH, JSON.stringify({ version: v }));
  return v;
}
const APP_VERSION = incrementVersion();

// ---- Logging ----
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  console.error(`[${new Date().toISOString()}] ERROR`, ...args);
}

// Log all requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Catch uncaught errors
process.on('uncaughtException', (err) => {
  logErr('Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  logErr('Unhandled rejection:', err.stack || err.message);
});

// ---- Reverse geocoding ----
function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    if (!lat || !lon) return resolve(null);
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    https.get(url, { headers: { 'User-Agent': 'selfie-app/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function buildAddress(geo) {
  if (!geo || !geo.address) return null;
  return geo.address.road || null;
}

function buildWhisperPrompt(geo) {
  if (!geo || !geo.address) return '';
  const a = geo.address;
  const parts = [a.road, a.quarter, a.suburb, a.city, a.state, a.country].filter(Boolean);
  return `Recording near ${parts.join(', ')}.`;
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${ts}.webm`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Main page (map + recording)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  index: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.use(express.json());

// Pre-upload: create a pending record so we know if the upload gets lost
app.post('/api/pre-upload', (req, res) => {
  const { lat, lon, duration, size, timestamp } = req.body;
  const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-').replace('Z', '') + 'Z';
  const pendingPath = path.join(UPLOADS_DIR, `pending-${ts}.json`);
  fs.writeFileSync(pendingPath, JSON.stringify({
    status: 'pending',
    lat: lat || null,
    lon: lon || null,
    duration: duration || null,
    expectedSize: size || null,
    timestamp: timestamp || new Date().toISOString()
  }, null, 2));
  log(`Pre-upload registered: ${duration}s, ${(size/1024/1024).toFixed(1)}MB, lat=${lat} lon=${lon}`);
  res.json({ ok: true });
});

app.post('/upload', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      logErr('Upload error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    next();
  });
}, (req, res) => {
  const { lat, lon, recorded_at } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No video file' });

  const videoPath = req.file.path;
  const metaPath = req.file.path.replace(/\.webm$/, '.json');

  // Write metadata — use client's recording timestamp if available
  fs.writeFileSync(metaPath, JSON.stringify({
    lat: parseFloat(lat) || null,
    lon: parseFloat(lon) || null,
    timestamp: recorded_at || new Date().toISOString(),
    uploaded_at: new Date().toISOString(),
    filename: req.file.filename,
    size: req.file.size,
    ip: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip
  }, null, 2));

  log(`Upload received: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(1)}MB) lat=${lat} lon=${lon}`);

  // Clear any pending records
  fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith('pending-')).forEach(f => {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {}
  });

  // Extract thumbnail
  const thumbPath = videoPath.replace(/\.webm$/, '.jpg');
  execFile('ffmpeg', ['-i', videoPath, '-ss', '0.5', '-vframes', '1', '-q:v', '4', thumbPath, '-y'], { timeout: 30000 }, (err) => {
    if (err) {
      logErr(`Thumbnail error for ${req.file.filename}:`, err.message);
    } else {
      log(`Thumbnail created for ${req.file.filename}`);
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.thumbnail = req.file.filename.replace(/\.webm$/, '.jpg');
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch {}
    }
  });

  // Reverse geocode then transcribe
  reverseGeocode(parseFloat(lat), parseFloat(lon)).then(geo => {
    const address = buildAddress(geo);
    const prompt = buildWhisperPrompt(geo);

    // Save address to metadata
    if (address) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.address = address;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        log(`Geocoded ${req.file.filename}: ${address}`);
      } catch {}
    }

    // Transcribe with location context
    const transcribeScript = path.join(__dirname, 'transcribe.py');
    const python = path.join(__dirname, 'venv', 'bin', 'python3');
    const args = [transcribeScript, videoPath];
    if (prompt) args.push(prompt);
    log(`Transcribing ${req.file.filename} (prompt: "${prompt}")...`);
    execFile(python, args, { timeout: 600000 }, (err, stdout) => {
      if (err) {
        logErr(`Transcription error for ${req.file.filename}:`, err.message);
        return;
      }
      try {
        const { text } = JSON.parse(stdout);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.transcript = text;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        log(`Transcribed ${req.file.filename}: "${text}"`);
        broadcast('new-upload', { filename: req.file.filename });
        generateReport();
      } catch (e) {
        logErr(`Failed to parse transcription for ${req.file.filename}:`, e.message);
      }
    });
  });

  broadcast('new-upload', { filename: req.file.filename });
  res.json({ ok: true, filename: req.file.filename });
});

// Install page
app.get('/install', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

app.get('/map', (_req, res) => res.redirect('/'));

// Report page
app.get('/report', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Serve uploaded videos
app.use('/videos', express.static(UPLOADS_DIR));

// API: list all uploads with metadata
app.get('/api/uploads', (_req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.json'));
  const entries = files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf8'));
    } catch { return null; }
  }).filter(e => e && e.lat != null && e.lon != null);
  res.json(entries);
});

// ---- Report generation ----
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();
const REPORT_PATH = path.join(__dirname, 'report.json');

function getEntries() {
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(e => e && e.transcript).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function formatTranscripts(entries) {
  return entries.map(e => {
    const d = new Date(e.timestamp);
    const time = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `[${time}, ${e.address || 'unknown location'}]\n${e.transcript}`;
  }).join('\n\n');
}

function findLatestSession(entries) {
  if (!entries.length) return [];
  // Latest session = all entries from the most recent day
  const lastDate = new Date(entries[entries.length - 1].timestamp).toDateString();
  return entries.filter(e => new Date(e.timestamp).toDateString() === lastDate);
}

let reportGenerating = false;

async function generateReport() {
  if (reportGenerating) return;
  reportGenerating = true;
  try {
    const allEntries = getEntries();
    if (!allEntries.length) return;
    const latestSession = findLatestSession(allEntries);

    const latestTranscripts = formatTranscripts(latestSession);
    const allTranscripts = formatTranscripts(allEntries);
    const singleSession = latestSession.length === allEntries.length;

    const sessionDate = new Date(latestSession[0].timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are analysing field recordings from political canvassing sessions. The recordings are selfie videos taken by canvassers as they go door-to-door. Some recordings contain actual voter feedback; others are just logistics, testing, or personal chatter — ignore those.

Important context:
- Canvassers only record when something is noteworthy. Not every voter contact results in a recording, so a small number of recordings does not imply a small number of contacts. Do not comment on the volume of recordings or suggest the data is limited.
- Read every transcript carefully. If a voter raises a concern (e.g. service charges, local issues), it MUST appear in the Voter Concerns section. Do not miss any.

${singleSession ? `
Produce a single report for this canvassing session:

# ${sessionDate}

Recordings:

${allTranscripts}

Report the following (omit any section heading if there is genuinely nothing for it):
- **Voter Concerns** — Each distinct issue raised by a voter, with location and brief detail.
- **Positive Responses** — Any positive interactions or support expressed.
- **Strategic Notes** — Patterns, recommended follow-ups, timing observations, areas to revisit.
- **Summary** — 2-3 sentence summary.
` : `
Produce a report with TWO sections:

# ${sessionDate}

These are the recordings from the most recent canvassing day:

${latestTranscripts}

Report the following (omit any section heading if there is genuinely nothing for it):
- **Voter Concerns** — Each distinct issue raised by a voter, with location and brief detail.
- **Positive Responses** — Any positive interactions or support expressed.
- **Strategic Notes** — Patterns, recommended follow-ups, timing observations, areas to revisit.
- **Session Summary** — 2-3 sentence summary.

---

# Cumulative Report — All Sessions

All recordings to date:

${allTranscripts}

Report the following:
- **All Voter Concerns** — Complete list of every issue raised by voters across all sessions.
- **All Positive Responses** — All positive interactions recorded.
- **Recurring Themes** — Issues or patterns that appear across multiple sessions or locations.
- **Strategic Recommendations** — Overall recommendations based on all data collected.
- **Overall Summary** — 2-3 sentence summary of all canvassing to date.
`}`
      }]
    });

    const report = message.content[0].text;
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      report,
      generatedAt: new Date().toISOString(),
      entryCount: allEntries.length
    }, null, 2));
    log(`Report generated and saved (${allEntries.length} entries)`);
  } catch (e) {
    logErr('Report generation error:', e.message);
  } finally {
    reportGenerating = false;
  }
}

app.post('/api/report/generate', async (_req, res) => {
  await generateReport();
  res.json({ ok: true });
});

app.get('/api/report', (_req, res) => {
  if (fs.existsSync(REPORT_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      return res.json(cached);
    } catch {}
  }
  res.json({ report: 'No report available yet. Record a video and a report will be generated automatically.' });
});

// SSE for live updates
const sseClients = new Map(); // res -> { id, lat, lon, lastSeen }
let clientIdCounter = 0;

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();
  const clientId = ++clientIdCounter;
  sseClients.set(res, { id: clientId, lat: null, lon: null, lastSeen: Date.now() });
  res.write(`event: welcome\ndata: ${JSON.stringify({ id: clientId })}\n\n`);
  log(`SSE client ${clientId} connected (${sseClients.size} total)`);
  req.on('close', () => {
    sseClients.delete(res);
    log(`SSE client ${clientId} disconnected (${sseClients.size} total)`);
    broadcastLocations();
  });
});

// Client location updates
app.post('/api/location', (req, res) => {
  const { id, lat, lon } = req.body;
  for (const [sseRes, info] of sseClients) {
    if (info.id === id) {
      info.lat = lat;
      info.lon = lon;
      info.lastSeen = Date.now();
      break;
    }
  }
  broadcastLocations();
  res.json({ ok: true });
});

function broadcastLocations() {
  const locations = [];
  for (const [, info] of sseClients) {
    if (info.lat != null && info.lon != null) {
      locations.push({ id: info.id, lat: info.lat, lon: info.lon });
    }
  }
  broadcast('locations', locations);
}

function broadcast(event, data) {
  for (const [client] of sseClients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// Version endpoint
app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

// Restart endpoint
app.post('/@restart', (_req, res) => {
  res.json({ ok: true, restarting: true });
  log('Broadcasting reload to clients...');
  broadcast('reload', { timestamp: Date.now() });
  // Give clients a moment to receive the message
  setTimeout(() => {
    log('Restarting server...');
    // Close SSE connections so server.close() doesn't hang
    for (const [client] of sseClients) { client.end(); }
    sseClients.clear();
    server.close(() => {
      const { spawn } = require('child_process');
      spawn(process.argv[0], process.argv.slice(1), {
        stdio: 'inherit',
        detached: true
      }).unref();
      process.exit(0);
    });
  }, 500);
});

const server = app.listen(PORT, () => {
  log(`Selfie server running on http://localhost:${PORT}`);
});
