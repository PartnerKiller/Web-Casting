let socket = null;
let activePlayer = null;
let currentMedia = null;
let lastTimeReport = 0;
let bannerTimeout = null;
let currentVolume = 1.0;
let currentMuted = false;
let activeHls = null;

// DOM Elements
const unmuteToast = document.getElementById('unmute-toast');
const videoPlayer = document.getElementById('video-player');
const audioPlayer = document.getElementById('audio-player');
const splashScreen = document.getElementById('splash-screen');
const connWarning = document.getElementById('conn-warning');
const mediaBanner = document.getElementById('media-banner');
const bannerPoster = document.getElementById('banner-poster');
const bannerTitle = document.getElementById('banner-title');
const bannerType = document.getElementById('banner-type');

// Connect to WebSocket Server with 'tv' role
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?role=tv`;
  
  console.log(`Connecting to server at ${wsUrl}...`);
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('Connected to server as TV Receiver.');
    connWarning.classList.remove('visible');
    sendState(); // Report initial idle state
  };
  
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleCommand(data);
    } catch (e) {
      console.error('Failed to parse command payload:', e);
    }
  };
  
  socket.onclose = () => {
    console.warn('Connection to server lost. Reconnecting in 3s...');
    connWarning.classList.add('visible');
    setTimeout(connect, 3000);
  };
  
  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Handle control commands sent by the PC dashboard
function handleCommand(cmd) {
  console.log('Received command:', cmd);
  
  if (cmd.type !== 'OFF' && cmd.type !== 'ON') {
    const powerOverlay = document.getElementById('power-overlay');
    if (powerOverlay) {
      powerOverlay.style.display = 'none';
    }
  }
  
  if (cmd.type === 'OFF') {
    if (activePlayer) {
      activePlayer.pause();
    }
    splashScreen.classList.add('hidden');
    let powerOverlay = document.getElementById('power-overlay');
    if (!powerOverlay) {
      powerOverlay = document.createElement('div');
      powerOverlay.id = 'power-overlay';
      powerOverlay.style.position = 'absolute';
      powerOverlay.style.top = '0';
      powerOverlay.style.left = '0';
      powerOverlay.style.width = '100%';
      powerOverlay.style.height = '100%';
      powerOverlay.style.backgroundColor = '#000';
      powerOverlay.style.zIndex = '99';
      powerOverlay.style.display = 'flex';
      powerOverlay.style.flexDirection = 'column';
      powerOverlay.style.alignItems = 'center';
      powerOverlay.style.justifyContent = 'center';
      powerOverlay.style.transition = 'opacity 0.5s ease';
      powerOverlay.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>
        </svg>
        <p style="margin-top: 1rem; color: #9ca3af; font-family: 'Inter', sans-serif; font-size: 1.1rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;">Receiver Turned Off</p>
      `;
      document.body.appendChild(powerOverlay);
    }
    powerOverlay.style.display = 'flex';
    sendState();
    return;
  }
  
  if (cmd.type === 'ON') {
    const powerOverlay = document.getElementById('power-overlay');
    if (powerOverlay) {
      powerOverlay.style.display = 'none';
    }
    if (currentMedia) {
      if (activePlayer && activePlayer.paused) {
        attemptPlay();
      }
    } else {
      splashScreen.classList.remove('hidden');
    }
    sendState();
    return;
  }
  
  if (cmd.type === 'LOAD') {
    loadMedia(cmd);
    return;
  }
  
  if (cmd.type === 'VOLUME') {
    currentVolume = parseFloat(cmd.value);
    if (activePlayer) {
      activePlayer.volume = currentVolume;
    }
    sendVolumeUpdate();
    return;
  }
  
  if (cmd.type === 'MUTE') {
    currentMuted = cmd.value === true;
    if (activePlayer) {
      activePlayer.muted = currentMuted;
    }
    sendVolumeUpdate();
    return;
  }
  
  if (!activePlayer) return;
  
  switch (cmd.type) {
    case 'PLAY':
      attemptPlay();
      break;
    case 'PAUSE':
      activePlayer.pause();
      break;
    case 'STOP':
      stopMedia();
      break;
    case 'SEEK':
      activePlayer.currentTime = parseFloat(cmd.value);
      break;
    default:
      console.warn('Unknown command type:', cmd.type);
  }
}

function sendVolumeUpdate() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'VOLUME',
    volume: {
      level: currentVolume,
      muted: currentMuted
    }
  }));
}

// Load and autoplay media
function loadMedia(data) {
  stopMedia();
  
  currentMedia = data;
  const isAudio = data.contentType.startsWith('audio/');
  
  activePlayer = isAudio ? audioPlayer : videoPlayer;
  
  let pendingStartTime = parseFloat(data.startTime) || 0;
  
  const seekToStart = () => {
    if (pendingStartTime > 0 && activePlayer) {
      console.log(`Seeking player to pending start time: ${pendingStartTime}s`);
      try {
        activePlayer.currentTime = pendingStartTime;
        pendingStartTime = 0; // reset to prevent double seeking
      } catch (e) {
        console.warn('Seek on metadata load failed, will retry on play:', e);
      }
    }
  };
  
  // Register listeners on metadata and playback start to ensure seek succeeds
  if (activePlayer.readyState >= 1) {
    seekToStart();
  } else {
    const onMetadataLoaded = () => {
      seekToStart();
      activePlayer.removeEventListener('loadedmetadata', onMetadataLoaded);
    };
    activePlayer.addEventListener('loadedmetadata', onMetadataLoaded);
  }
  
  const onPlaying = () => {
    seekToStart();
    activePlayer.removeEventListener('playing', onPlaying);
  };
  activePlayer.addEventListener('playing', onPlaying);
  
  // Show active player, hide inactive one
  if (isAudio) {
    audioPlayer.classList.remove('hidden');
    videoPlayer.classList.add('hidden');
    videoPlayer.src = '';
  } else {
    videoPlayer.classList.remove('hidden');
    audioPlayer.classList.add('hidden');
    audioPlayer.src = '';
  }
  
  activePlayer.volume = currentVolume;
  activePlayer.muted = currentMuted;
  splashScreen.classList.add('hidden');
  
  // Display Toast Notification Banner
  showMediaBanner(data.title, data.contentType, data.poster);
  
  // Check if HLS stream (.m3u8)
  const isHls = data.url.includes('.m3u8') || 
                data.contentType === 'application/x-mpegURL' || 
                data.contentType === 'application/vnd.apple.mpegurl';
                
  if (isHls && !isAudio) {
    if (Hls.isSupported()) {
      console.log('Loading HLS stream via hls.js...');
      activeHls = new Hls();
      activeHls.loadSource(data.url);
      activeHls.attachMedia(activePlayer);
      activeHls.on(Hls.Events.MANIFEST_PARSED, () => {
        attemptPlay();
      });
      activeHls.on(Hls.Events.ERROR, (event, errData) => {
        if (errData.fatal) {
          console.error('HLS Fatal Error:', errData);
          reportError('HLS stream error');
        }
      });
    } else if (activePlayer.canPlayType('application/vnd.apple.mpegurl')) {
      console.log('Loading HLS stream natively...');
      activePlayer.src = data.url;
      activePlayer.load();
      attemptPlay();
    } else {
      console.error('HLS is not supported by this browser.');
      reportError('HLS streams not supported');
    }
  } else {
    console.log('Loading standard media stream...');
    activePlayer.src = data.url;
    activePlayer.load();
    attemptPlay();
  }
  
  // Send state update immediately
  setTimeout(sendState, 200);
}

// Stop playback and return to idle splash screen
function stopMedia() {
  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
  
  if (activePlayer) {
    activePlayer.pause();
    activePlayer.src = '';
    activePlayer.classList.add('hidden');
    activePlayer = null;
  }
  
  currentMedia = null;
  splashScreen.classList.remove('hidden');
  hideMediaBanner();
  hideMuteOverlay();
  sendState();
}

// Display full screen layout overlay notification
function showMediaBanner(title, type, poster) {
  if (bannerTimeout) clearTimeout(bannerTimeout);
  
  bannerTitle.textContent = title || 'Media Stream';
  bannerType.textContent = type || 'Video Feed';
  
  if (poster) {
    bannerPoster.style.backgroundImage = `url('${poster}')`;
    bannerPoster.style.display = 'block';
  } else {
    bannerPoster.style.display = 'none';
  }
  
  mediaBanner.classList.add('visible');
  
  // Fade out banner after 5 seconds
  bannerTimeout = setTimeout(hideMediaBanner, 5000);
}

function hideMediaBanner() {
  mediaBanner.classList.remove('visible');
}

// Send current media state back to the server
function sendState() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  
  const payload = {
    type: 'STATUS',
    status: activePlayer ? {
      playerState: activePlayer.paused ? 'PAUSED' : 'PLAYING',
      currentTime: activePlayer.currentTime,
      volume: {
        level: activePlayer.volume,
        muted: activePlayer.muted
      },
      media: {
        metadata: {
          title: currentMedia?.title || 'Unknown',
          subtitle: currentMedia?.contentType || 'Casting',
          images: currentMedia?.poster ? [{ url: currentMedia.poster }] : []
        },
        duration: activePlayer.duration || 0
      }
    } : null
  };
  
  socket.send(JSON.stringify(payload));
}

// Attach HTML5 Media event listeners to synchronize state
function attachEventListeners(player) {
  player.addEventListener('playing', sendState);
  player.addEventListener('pause', sendState);
  player.addEventListener('volumechange', () => {
    if (!activePlayer || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'VOLUME',
      volume: {
        level: activePlayer.volume,
        muted: activePlayer.muted
      }
    }));
  });
  
  // Throttle timeupdate to avoid network flood (every 1 second)
  player.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastTimeReport > 1000) {
      lastTimeReport = now;
      sendState();
    }
  });
  
  // Auto-advance queue triggers
  player.addEventListener('ended', () => {
    console.log('Playback ended. Reporting to server...');
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ENDED' }));
    }
  });
  
  player.addEventListener('error', (e) => {
    const errorDetails = player.error ? `Code ${player.error.code}: ${player.error.message}` : 'Unknown HTML5 media error';
    console.error('Player error occurred:', errorDetails, e);
    reportError(`Playback error: ${errorDetails}`);
  });
}

// Setup listeners on both media tags
attachEventListeners(videoPlayer);
attachEventListeners(audioPlayer);



// Screen Rotation Auto-Fullscreen Handler
function handleOrientationChange() {
  const isLandscape = window.innerWidth > window.innerHeight;
  
  if (isLandscape) {
    if (!document.fullscreenElement) {
      console.log('Rotation to landscape detected. Activating auto-fullscreen...');
      document.documentElement.requestFullscreen()
        .catch(err => {
          console.warn('Auto-fullscreen request failed (requires user gesture interaction):', err.message);
        });
    }
  } else {
    if (document.fullscreenElement) {
      console.log('Rotation to portrait detected. Exiting fullscreen...');
      document.exitFullscreen()
        .catch(err => {
          console.warn('Error exiting fullscreen on portrait rotation:', err.message);
        });
    }
  }
}

// Bind orientation listeners
if (screen.orientation) {
  screen.orientation.addEventListener('change', handleOrientationChange);
} else {
  window.addEventListener('orientationchange', handleOrientationChange);
}

// Fallback resize detection for aspect ratio flips
let lastHeight = window.innerHeight;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth !== lastWidth || window.innerHeight !== lastHeight) {
    lastWidth = window.innerWidth;
    lastHeight = window.innerHeight;
    handleOrientationChange();
  }
});

// Helper methods for error reporting, autoplay unblocking, and mute overlays
function attemptPlay() {
  if (!activePlayer) return;
  
  activePlayer.play().then(() => {
    console.log('Playback started successfully.');
    hideMuteOverlay();
  }).catch(err => {
    console.warn('Autoplay blocked. Retrying with muted audio fallback...', err);
    activePlayer.muted = true;
    activePlayer.play().then(() => {
      console.log('Muted autoplay succeeded.');
      showMuteOverlay();
      sendVolumeUpdate();
    }).catch(e => {
      console.error('Muted playback also failed:', e);
      const reason = e.message || e.name || 'Unknown play error';
      reportError(`Playback error: ${reason}`);
    });
  });
}

function reportError(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'STATUS',
    status: {
      playerState: 'ERROR',
      currentTime: 0,
      volume: { level: currentVolume, muted: currentMuted },
      media: {
        metadata: {
          title: 'Playback Error',
          subtitle: msg
        },
        duration: 0
      }
    }
  }));
}

function showMuteOverlay() {
  unmuteToast.classList.add('visible');
}

function hideMuteOverlay() {
  unmuteToast.classList.remove('visible');
}

// Tap anywhere on screen to unmute if video is playing muted
document.addEventListener('click', () => {
  if (activePlayer && activePlayer.muted) {
    activePlayer.muted = false;
    currentMuted = false;
    hideMuteOverlay();
    sendVolumeUpdate();
  }
});

// Initialize on load
window.addEventListener('load', () => {
  connect();
});
