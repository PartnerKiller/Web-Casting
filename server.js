const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const multer = require('multer');
const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// Enable CORS for cross-origin local casting (localhost vs network IP)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

// Configure Multer for local file uploads
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let STB_IP = '192.168.0.165';
let client = null;
let currentReceiverStatus = null;
let tvPlayerStatus = null;
let jioPlayerStatus = null;
let currentMediaController = null;
let isConnected = false;
let reconnectTimer = null;
let lastKnownProgressTime = 0;
let jioPollInterval = null;
let isTvStandby = false;
let lastTransitionTime = 0;

function startJioPolling() {
  if (jioPollInterval) return;
  console.log('Starting JioSTB Castv2 status polling interval...');
  jioPollInterval = setInterval(() => {
    if (isConnected && currentMediaController) {
      currentMediaController.getStatus((err, status) => {
        if (!err && status) {
          jioPlayerStatus = status;
          if (status && typeof status.currentTime === 'number') {
            lastKnownProgressTime = status.currentTime;
            syncTvToJio();
          }
          broadcastStatus();
        }
      });
    }
  }, 2000);
}

function stopJioPolling() {
  if (jioPollInterval) {
    console.log('Stopping JioSTB Castv2 status polling interval.');
    clearInterval(jioPollInterval);
    jioPollInterval = null;
  }
}

// Playlist Queue State
let playlist = [];
let currentPlayingIndex = -1;

// TV Web Receiver State
let isTvConnected = false;
let tvSocket = null;
let tvVolume = { level: 1.0, muted: false };

// Get the PC's Local Network IP Address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIp();
console.log(`Auto-detected local PC network IP address: ${LOCAL_IP}`);

// Handle WebSocket connection
wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const role = parsedUrl.searchParams.get('role') || 'dashboard';
  ws.role = role;
  
  if (role === 'tv') {
    console.log('TV Receiver client connected.');
    isTvConnected = true;
    tvSocket = ws;
    isTvStandby = false;
    
    // Auto-resume active stream if mid-stream reload occurred
    if (currentPlayingIndex >= 0 && currentPlayingIndex < playlist.length) {
      const activeTrack = playlist[currentPlayingIndex];
      
      // Determine the target resume timestamp (prefer Set-Top Box's current playing time)
      let resumeTime = 0;
      if (jioPlayerStatus && typeof jioPlayerStatus.currentTime === 'number') {
        resumeTime = jioPlayerStatus.currentTime;
      } else if (lastKnownProgressTime > 0) {
        resumeTime = lastKnownProgressTime;
      }
      
      console.log(`Re-casting active stream on TV reconnect: ${activeTrack.title} starting at ${resumeTime.toFixed(1)}s`);
      let tvMediaUrl = activeTrack.url;
      if (activeTrack.url.includes(LOCAL_IP)) {
        tvMediaUrl = activeTrack.url.replace(LOCAL_IP, 'localhost');
      }
      try {
        ws.send(JSON.stringify({
          type: 'LOAD',
          url: tvMediaUrl,
          title: activeTrack.title,
          contentType: activeTrack.contentType,
          poster: activeTrack.poster,
          startTime: resumeTime
        }));
        
        // Backup seek in case player metadata loader needs a nudge
        if (resumeTime > 2) {
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: 'SEEK', value: resumeTime }));
            } catch (e) {
              console.error('Failed to send auto-resume seek:', e);
            }
          }, 1200);
        }
      } catch (e) {
        console.error('Failed to send auto-resume command to TV Receiver:', e);
      }
    }
    
    broadcastStatus();
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleTvMessage(data);
      } catch (e) {
        console.error('Error handling TV message:', e);
      }
    });
    
    ws.on('close', () => {
      console.log('TV Receiver client disconnected.');
      isTvConnected = false;
      tvSocket = null;
      tvPlayerStatus = null;
      broadcastStatus();
    });
  } else {
    // Dashboard client
    console.log('Dashboard client connected to real-time status feed.');
    ws.send(JSON.stringify(getCurrentState()));
    
    ws.on('close', () => {
      console.log('Dashboard client disconnected.');
    });
  }
});

// Process messages received from the TV Web Receiver page
function handleTvMessage(data) {
  switch (data.type) {
    case 'STATUS':
      // Synchronize playback state from the TV to dashboard status cache
      tvPlayerStatus = data.status;
      if (data.status && typeof data.status.currentTime === 'number') {
        lastKnownProgressTime = data.status.currentTime;
        syncTvToJio();
      }
      if (data.status && data.status.volume) {
        tvVolume = data.status.volume;
      }
      broadcastStatus();
      break;
      
    case 'VOLUME':
      tvVolume = data.volume;
      broadcastStatus();
      break;
      
    case 'ENDED':
      if (currentPlayingIndex !== -1) {
        console.log('TV Media ended playing. Advancing queue...');
        playNextTrack();
      }
      break;
      
    case 'ERROR':
      console.error('TV Client reported error:', data.message);
      break;
      
    default:
      console.warn('Unknown TV message type:', data.type);
  }
}
let lastTvSyncTime = 0;

function syncTvToJio() {
  if (isTvStandby) return;
  if (!isTvConnected || !tvSocket || !jioPlayerStatus || !tvPlayerStatus) return;
  
  // Mirror Play/Pause states
  if (jioPlayerStatus.playerState === 'PAUSED' && tvPlayerStatus.playerState === 'PLAYING') {
    console.log('Mirroring JioSTB PAUSE to TV Web Receiver...');
    try {
      tvSocket.send(JSON.stringify({ type: 'PAUSE' }));
    } catch(e) {}
  } else if (jioPlayerStatus.playerState === 'PLAYING' && tvPlayerStatus.playerState === 'PAUSED') {
    console.log('Mirroring JioSTB PLAY to TV Web Receiver...');
    try {
      tvSocket.send(JSON.stringify({ type: 'PLAY' }));
    } catch(e) {}
  }
  
  // Mirror current time seek positions
  if (typeof jioPlayerStatus.currentTime !== 'number' || typeof tvPlayerStatus.currentTime !== 'number') return;
  
  const now = Date.now();
  if (now - lastTvSyncTime > 4000) { // 4 seconds cool down
    const drift = Math.abs(tvPlayerStatus.currentTime - jioPlayerStatus.currentTime);
    if (drift > 3) {
      lastTvSyncTime = now;
      console.log(`Syncing TV Web Receiver to JioSTB (Drift: ${drift.toFixed(1)}s) to match Jio Cast`);
      try {
        tvSocket.send(JSON.stringify({ type: 'SEEK', value: jioPlayerStatus.currentTime }));
      } catch (e) {
        console.error('Failed to send sync seek to TV Receiver:', e.message);
      }
    }
  }
}

// Broadcast state to all connected dashboards and/or TV receivers
function broadcastStatus() {
  const state = getCurrentState();
  const message = JSON.stringify(state);
  wss.clients.forEach((clientWs) => {
    if (clientWs.role === 'dashboard' && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(message);
    }
  });
}

// Assemble unified state payload
function getCurrentState() {
  const finalVolume = isTvConnected ? tvVolume : (currentReceiverStatus?.volume || null);
  const activeAppDisplayName = isTvConnected ? 'Web Receiver' : (currentReceiverStatus?.applications?.[0]?.displayName || 'None');
  
  const connectedTargets = [];
  if (isTvConnected) connectedTargets.push('Web Receiver');
  if (isConnected) connectedTargets.push('JioSTB');
  const targetLabel = connectedTargets.join(' & ') || 'None';
  
  return {
    connected: isTvConnected || isConnected,
    deviceIp: targetLabel,
    localIp: LOCAL_IP,
    stbIp: STB_IP,
    isTvReceiver: isTvConnected,
    receiver: isTvConnected ? { applications: [{ displayName: 'Web Receiver' }] } : currentReceiverStatus,
    player: tvPlayerStatus || jioPlayerStatus,
    volume: finalVolume,
    activeApp: activeAppDisplayName,
    playlist: playlist,
    currentPlayingIndex: currentPlayingIndex
  };
}

// Connect to JioSTB Castv2 Service (Fallback destination)
function connectToSTB() {
  if (client) {
    try { client.close(); } catch (e) {}
  }
  
  console.log(`Connecting to JioSTB Cast Service at ${STB_IP}:8009...`);
  client = new Client();
  
  client.on('error', (err) => {
    console.error('JioSTB Connection Error:', err.message);
    isConnected = false;
    jioPlayerStatus = null;
    currentReceiverStatus = null;
    currentMediaController = null;
    stopJioPolling();
    broadcastStatus();
    scheduleReconnect();
  });
  
  client.on('status', (status) => {
    console.log('Receiver status updated.');
    currentReceiverStatus = status;
    
    const app = status?.applications?.[0];
    if (!app || app.appId !== 'CC1AD845') {
      jioPlayerStatus = null;
      currentMediaController = null;
      stopJioPolling();
    } else if (app && app.appId === 'CC1AD845' && !currentMediaController) {
      joinActiveSession(app);
    }
    
    broadcastStatus();
  });
  
  client.connect(STB_IP, () => {
    console.log('Connected to JioSTB Cast Service.');
    isConnected = true;
    
    client.getStatus((err, status) => {
      if (!err && status) {
        currentReceiverStatus = status;
        const app = status?.applications?.[0];
        if (app && app.appId === 'CC1AD845') {
          joinActiveSession(app);
        } else {
          stopJioPolling();
        }
      }
      broadcastStatus();
    });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('Scheduling reconnection in 10 seconds...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToSTB();
  }, 10000);
}

// Join active Cast media player session
function joinActiveSession(appDetails) {
  if (!client || !isConnected) return;
  
  console.log('Joining active media session...');
  client.join(appDetails, DefaultMediaReceiver, (err, player) => {
    if (err) {
      console.warn('Could not join media session:', err.message);
      return;
    }
    
    console.log('Joined media session.');
    currentMediaController = player;
    
    player.on('status', (status) => {
      jioPlayerStatus = status;
      if (status && typeof status.currentTime === 'number') {
        lastKnownProgressTime = status.currentTime;
        syncTvToJio();
      }
      if (status.playerState === 'PLAYING') {
        startJioPolling();
      } else {
        stopJioPolling();
      }
      if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED' && currentPlayingIndex !== -1) {
        console.log('Media finished playing. Advancing queue...');
        playNextTrack();
      }
      broadcastStatus();
    });
    
    player.getStatus((err, status) => {
      if (!err && status) {
        jioPlayerStatus = status;
        if (status && typeof status.currentTime === 'number') {
          lastKnownProgressTime = status.currentTime;
          syncTvToJio();
        }
        if (status.playerState === 'PLAYING') {
          startJioPolling();
        } else {
          stopJioPolling();
        }
        broadcastStatus();
      }
    });
  });
}

// Play next track in playlist queue
function playNextTrack() {
  const now = Date.now();
  if (now - lastTransitionTime < 3500) {
    console.log('Ignoring duplicate track advance request (cooldown active).');
    return;
  }
  
  if (currentPlayingIndex + 1 < playlist.length) {
    lastTransitionTime = now;
    currentPlayingIndex++;
    lastKnownProgressTime = 0;
    const nextTrack = playlist[currentPlayingIndex];
    console.log(`Auto-playing next track [Index ${currentPlayingIndex}]: ${nextTrack.title}`);
    castMediaItem(nextTrack.url, nextTrack.contentType, nextTrack.title, nextTrack.poster);
  } else {
    console.log('Playlist queue finished.');
    currentPlayingIndex = -1;
    tvPlayerStatus = null;
    jioPlayerStatus = null;
    currentMediaController = null;
    if (isTvConnected && tvSocket) {
      tvSocket.send(JSON.stringify({ type: 'STOP' }));
    }
    broadcastStatus();
  }
}

// Cast implementation (bridges between TV WebSocket or JioSTB Castv2)
function castMediaItem(mediaUrl, contentType, title, poster, callback = null) {
  lastKnownProgressTime = 0;
  isTvStandby = false;
  let castSuccess = false;
  let castError = null;
  let pendingCasts = 0;
  
  const handleCastDone = (err) => {
    pendingCasts--;
    if (err) {
      castError = err;
    } else {
      castSuccess = true;
    }
    if (pendingCasts === 0) {
      if (callback) {
        if (castSuccess) callback(null);
        else callback(castError || new Error('Casting failed on all targets'));
      }
    }
  };

  if (isTvConnected && tvSocket) {
    pendingCasts++;
    console.log(`Sending LOAD command to TV Receiver: ${title}`);
    
    // Replace local network IP with localhost for local TV Web Receiver to bypass router/firewall loopback blocks
    let tvMediaUrl = mediaUrl;
    if (mediaUrl.includes(LOCAL_IP)) {
      tvMediaUrl = mediaUrl.replace(LOCAL_IP, 'localhost');
    }
    
    try {
      tvSocket.send(JSON.stringify({
        type: 'LOAD',
        url: tvMediaUrl,
        title: title || 'Local Stream',
        contentType: contentType || 'video/mp4',
        poster: poster || ''
      }));
      handleCastDone(null);
    } catch (e) {
      console.error('Failed to send LOAD command to TV Web socket:', e);
      handleCastDone(e);
    }
  }
  
  if (isConnected && client) {
    pendingCasts++;
    console.log(`Launching and casting on JioSTB: ${title}`);
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) {
        console.error('Launch JioSTB Error:', err);
        handleCastDone(err);
        return;
      }
      
      currentMediaController = player;
      
      player.on('status', (status) => {
        jioPlayerStatus = status;
        if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
          console.log('JioSTB Media finished playing. Advancing queue...');
          playNextTrack();
        }
        broadcastStatus();
      });
      
      const media = {
        contentId: mediaUrl,
        contentType: contentType || 'video/mp4',
        streamType: 'BUFFERED',
        metadata: {
          metadataType: 0,
          title: title || 'Local Media Stream',
          images: poster ? [{ url: poster }] : []
        }
      };
      
      player.load(media, { autoplay: true }, (err, status) => {
        if (err) {
          console.error('JioSTB Media Load Error:', err);
          handleCastDone(err);
          return;
        }
        console.log(`Successfully casted on JioSTB: ${title}`);
        jioPlayerStatus = status;
        broadcastStatus();
        handleCastDone(null);
      });
    });
  }
  
  if (pendingCasts === 0) {
    if (callback) callback(new Error('No active casting targets connected'));
  }
}

// REST API Endpoints

// File upload handler
app.post('/api/upload', upload.single('mediaFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media file uploaded' });
  }
  
  const fileUrl = `http://${LOCAL_IP}:${PORT}/uploads/${req.file.filename}`;
  const fileTitle = req.body.title || req.file.originalname;
  
  res.json({
    success: true,
    file: {
      url: fileUrl,
      title: fileTitle,
      contentType: req.file.mimetype,
      filename: req.file.filename
    }
  });
});

// Configuration Endpoints
app.post('/api/config/ip', (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  console.log(`Updating Cast device Target IP from ${STB_IP} to ${ip}...`);
  STB_IP = ip;
  
  // Clean up and restart connection
  isConnected = false;
  stopJioPolling();
  if (client) {
    try { client.close(); } catch(e){}
    client = null;
  }
  
  tvPlayerStatus = null;
  jioPlayerStatus = null;
  currentReceiverStatus = null;
  currentMediaController = null;
  
  // Reconnect immediately to new IP
  connectToSTB();
  
  broadcastStatus();
  res.json({ success: true, stbIp: STB_IP });
});

app.post('/api/restart', (req, res) => {
  console.log('User initiated server restart from dashboard. Spawning new process...');
  res.json({ success: true, message: 'Server is restarting...' });
  
  setTimeout(() => {
    if (client) {
      try { client.close(); } catch(e){}
    }
    
    // Spawn detached node instance of server.js
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: 'inherit'
    });
    child.unref();
    process.exit(0);
  }, 500);
});

// Playlist Endpoints
app.get('/api/playlist', (req, res) => {
  res.json(playlist);
});

app.post('/api/playlist/add', (req, res) => {
  const { url, title, contentType, poster } = req.body;
  if (!url || !title) {
    return res.status(400).json({ error: 'url and title are required' });
  }
  
  const newItem = {
    id: Date.now() + '-' + Math.round(Math.random() * 1000),
    url,
    title,
    contentType: contentType || 'video/mp4',
    poster: poster || ''
  };
  
  playlist.push(newItem);
  console.log(`Added playlist item: ${title}`);
  
  if (currentPlayingIndex === -1 && playlist.length === 1) {
    currentPlayingIndex = 0;
    castMediaItem(newItem.url, newItem.contentType, newItem.title, newItem.poster, (err) => {
      if (err) currentPlayingIndex = -1;
    });
  }
  
  broadcastStatus();
  res.json({ success: true, playlist });
});

app.post('/api/playlist/remove', (req, res) => {
  const { id } = req.body;
  const index = playlist.findIndex(item => item.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Item not found in playlist' });
  }
  
  console.log(`Removing playlist item [Index ${index}]: ${playlist[index].title}`);
  playlist.splice(index, 1);
  
  if (index === currentPlayingIndex) {
    if (playlist.length > 0) {
      currentPlayingIndex = Math.min(index, playlist.length - 1);
      const nextTrack = playlist[currentPlayingIndex];
      castMediaItem(nextTrack.url, nextTrack.contentType, nextTrack.title, nextTrack.poster, (err) => {
        if (err) currentPlayingIndex = -1;
      });
    } else {
      currentPlayingIndex = -1;
      if (isTvConnected && tvSocket) {
        tvSocket.send(JSON.stringify({ type: 'STOP' }));
      } else if (currentMediaController) {
        currentMediaController.stop(() => {
          currentMediaController = null;
          tvPlayerStatus = null;
          jioPlayerStatus = null;
          broadcastStatus();
        });
      }
    }
  } else if (index < currentPlayingIndex) {
    currentPlayingIndex--;
  }
  
  broadcastStatus();
  res.json({ success: true, playlist });
});

app.post('/api/playlist/play-index', (req, res) => {
  const { index } = req.body;
  const idx = parseInt(index);
  
  if (isNaN(idx) || idx < 0 || idx >= playlist.length) {
    return res.status(400).json({ error: 'Invalid playlist index' });
  }
  
  currentPlayingIndex = idx;
  const item = playlist[currentPlayingIndex];
  console.log(`Playing selected playlist track [Index ${idx}]: ${item.title}`);
  
  castMediaItem(item.url, item.contentType, item.title, item.poster, (err, status) => {
    if (err) {
      currentPlayingIndex = -1;
      return res.status(500).json({ error: 'Failed to cast media item' });
    }
    res.json({ success: true, status });
  });
});

app.post('/api/playlist/clear', (req, res) => {
  playlist = [];
  currentPlayingIndex = -1;
  console.log('Playlist queue cleared.');
  
  if (isTvConnected && tvSocket) {
    tvSocket.send(JSON.stringify({ type: 'STOP' }));
  } else if (currentMediaController) {
    currentMediaController.stop(() => {
      currentMediaController = null;
      tvPlayerStatus = null;
      jioPlayerStatus = null;
      broadcastStatus();
    });
  } else {
    broadcastStatus();
  }
  res.json({ success: true });
});

// Casting direct endpoint
app.post('/api/cast', (req, res) => {
  const { mediaUrl, contentType, title, poster } = req.body;
  if (!mediaUrl) {
    return res.status(400).json({ error: 'mediaUrl is required' });
  }
  
  playlist = [{
    id: 'direct-cast-' + Date.now(),
    url: mediaUrl,
    title: title || 'Direct Cast',
    contentType: contentType || 'video/mp4',
    poster: poster || ''
  }];
  currentPlayingIndex = 0;
  
  castMediaItem(mediaUrl, contentType, title, poster, (err, status) => {
    if (err) {
      playlist = [];
      currentPlayingIndex = -1;
      return res.status(500).json({ error: 'Failed to cast media' });
    }
    res.json({ success: true, status });
  });
});

// Control API (Routes command to TV web socket and JioSTB Castv2 concurrently)
app.post('/api/control', (req, res) => {
  const { action, value } = req.body;
  
  if (!isTvConnected && (!isConnected || !client)) {
    return res.status(503).json({ error: 'No display targets (TV or JioSTB) connected.' });
  }
  
  console.log(`Unified control action: ${action} with value:`, value);
  
  let commandExecuted = false;
  
  // Forward to TV Web Receiver if connected
  if (isTvConnected && tvSocket) {
    try {
      tvSocket.send(JSON.stringify({ type: action.toUpperCase(), value }));
      if (action === 'stop' || action === 'off') {
        tvPlayerStatus = null;
        lastKnownProgressTime = 0;
        if (action === 'off') {
          isTvStandby = true;
        }
      }
      if (action === 'seek') {
        lastKnownProgressTime = parseFloat(value);
      }
      if (action === 'on') {
        isTvStandby = false;
        lastTvSyncTime = 0; // force immediate sync check
        setTimeout(() => {
          syncTvToJio();
        }, 1000);
      }
      commandExecuted = true;
    } catch (e) {
      console.error('Failed to forward command to TV socket:', e);
    }
  }
  
  // Forward to JioSTB if connected
  if (isConnected && client) {
    if (action === 'volume') {
      const val = parseFloat(value);
      if (!isNaN(val) && val >= 0 && val <= 1) {
        client.setVolume({ level: val }, (err, vol) => {});
        commandExecuted = true;
      }
    } else if (action === 'mute') {
      client.setVolume({ muted: true }, (err, vol) => {});
      commandExecuted = true;
    } else if (action === 'unmute') {
      client.setVolume({ muted: false }, (err, vol) => {});
      commandExecuted = true;
    } else if (currentMediaController) {
      switch (action) {
        case 'play':
          if (jioPlayerStatus) jioPlayerStatus.playerState = 'PLAYING';
          broadcastStatus();
          currentMediaController.play((err, status) => {});
          commandExecuted = true;
          break;
        case 'pause':
          if (jioPlayerStatus) jioPlayerStatus.playerState = 'PAUSED';
          broadcastStatus();
          currentMediaController.pause((err, status) => {});
          commandExecuted = true;
          break;
        case 'stop':
          stopJioPolling();
          const targetController = currentMediaController;
          // Optimistic state updates for instant response times
          currentMediaController = null;
          jioPlayerStatus = null;
          lastKnownProgressTime = 0;
          currentPlayingIndex = -1;
          broadcastStatus();
          
          if (targetController) {
            targetController.stop((err, status) => {});
          }
          commandExecuted = true;
          break;
        case 'seek':
          const time = parseFloat(value);
          if (!isNaN(time)) {
            lastKnownProgressTime = time;
            currentMediaController.seek(time, (err, status) => {});
            commandExecuted = true;
          }
          break;
      }
    }
  }
  
  broadcastStatus();
  
  if (commandExecuted) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Command could not be executed on any connected targets.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard web server listening on http://localhost:${PORT} (bound to 0.0.0.0)`);
  connectToSTB();
});
