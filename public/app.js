// WebSocket state feed connection
let socket = null;
let lastKnownState = null;
let progressInterval = null;
let currentProgressSeconds = 0;
let totalDurationSeconds = 0;
let isPlaying = false;

// DOM Elements
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const activeApp = document.getElementById('active-app');
const mediaArt = document.getElementById('media-art');
const mediaArtContainer = document.getElementById('media-art-container');
const mediaTitle = document.getElementById('media-title');
const mediaArtist = document.getElementById('media-artist');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const progressFill = document.getElementById('progress-fill');
const progressTrack = document.getElementById('progress-track');
const btnStop = document.getElementById('btn-stop');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnSkipBack = document.getElementById('btn-skip-back');
const btnSkipForward = document.getElementById('btn-skip-forward');
const progressTooltip = document.getElementById('progress-tooltip');
const btnPowerOn = document.getElementById('btn-power-on');
const btnPowerOff = document.getElementById('btn-power-off');
const svgPlay = document.getElementById('svg-play');
const svgPause = document.getElementById('svg-pause');
const btnMute = document.getElementById('btn-mute');
const svgVolUp = document.getElementById('svg-vol-up');
const svgVolMute = document.getElementById('svg-vol-mute');
const volSlider = document.getElementById('vol-slider');
const volLabel = document.getElementById('vol-label');
const castForm = document.getElementById('cast-form');
const mediaUrlInput = document.getElementById('media-url');
const mediaTitleInput = document.getElementById('media-title-input');
const mediaTypeSelect = document.getElementById('media-type');
const mediaPosterInput = document.getElementById('media-poster');
const btnCastSubmit = document.getElementById('btn-cast-submit');

// Target IP Selection elements
const targetIpInput = document.getElementById('target-ip-input');
const btnUpdateIp = document.getElementById('btn-update-ip');
const btnRestartServer = document.getElementById('btn-restart-server');
let ipInputInitialized = false;

// New Upload & Playlist Elements
const fileInput = document.getElementById('file-input');
const uploadZone = document.getElementById('upload-zone');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressFill = document.getElementById('upload-progress-fill');
const uploadProgressPercent = document.getElementById('upload-progress-percent');
const uploadStatusText = document.getElementById('upload-status-text');
const playlistQueue = document.getElementById('playlist-queue');
const btnClearQueue = document.getElementById('btn-clear-queue');

// Connect to WebSocket Server for Real-Time Status Updates
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?role=dashboard`;
  
  console.log(`Connecting to status feed at ${wsUrl}...`);
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('Connected to local dashboard server feed.');
  };
  
  socket.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data);
      updateUI(state);
    } catch (e) {
      console.error('Failed to parse status payload:', e);
    }
  };
  
  socket.onclose = () => {
    console.warn('Dashboard server feed connection closed. Reconnecting in 3s...');
    updateOfflineState();
    setTimeout(connectWebSocket, 3000);
  };
  
  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Update the entire user interface based on the device state
function updateUI(state) {
  lastKnownState = state;
  
  // Connection status
  if (state.connected) {
    statusDot.className = 'status-dot online';
    statusLabel.textContent = 'Online';
    btnPowerOn.disabled = false;
    btnPowerOff.disabled = false;
  } else {
    statusDot.className = 'status-dot disconnected';
    statusLabel.textContent = 'Offline';
    btnPowerOn.disabled = true;
    btnPowerOff.disabled = true;
    updateOfflineState();
    
    // Keep setting IP on initial load even if offline
    if (!ipInputInitialized && state.stbIp) {
      targetIpInput.value = state.stbIp;
      ipInputInitialized = true;
    }
    return;
  }
  
  // Set Stb IP on initial load
  if (!ipInputInitialized && state.stbIp) {
    targetIpInput.value = state.stbIp;
    ipInputInitialized = true;
  }
  
  // Active application
  activeApp.textContent = state.activeApp || 'Idle';
  if (state.activeApp !== 'None' && state.activeApp !== 'Idle') {
    activeApp.className = 'active-app-badge';
  } else {
    activeApp.className = 'active-app-badge hidden';
  }
  
  // Volume controls
  if (state.volume) {
    const level = Math.round(state.volume.level * 100);
    volSlider.value = level;
    volLabel.textContent = `${level}%`;
    
    if (state.volume.muted) {
      svgVolUp.classList.add('hidden');
      svgVolMute.classList.remove('hidden');
    } else {
      svgVolUp.classList.remove('hidden');
      svgVolMute.classList.add('hidden');
    }
  }
  
  // Player state controls
  if (state.player) {
    btnStop.disabled = false;
    btnPlayPause.disabled = false;
    btnSkipBack.disabled = false;
    btnSkipForward.disabled = false;
    
    // Play/Pause icon toggling
    isPlaying = state.player.playerState === 'PLAYING';
    if (isPlaying) {
      svgPlay.classList.add('hidden');
      svgPause.classList.remove('hidden');
      
      const serverTime = state.player.currentTime || 0;
      const serverDuration = state.player.media?.duration || 0;
      const drift = Math.abs(currentProgressSeconds - serverTime);
      const durationChanged = Math.abs(totalDurationSeconds - serverDuration) > 1;
      
      if (!progressInterval || drift > 3 || durationChanged) {
        startProgressTicker(serverTime, serverDuration);
      }
    } else {
      svgPlay.classList.remove('hidden');
      svgPause.classList.add('hidden');
      stopProgressTicker();
      updateProgressDisplay(state.player.currentTime || 0, state.player.media?.duration || 0);
    }
    
    // Media Metadata
    const meta = state.player.media.metadata;
    mediaTitle.textContent = meta?.title || 'Active Stream';
    mediaArtist.textContent = meta?.subtitle || 'Casting';
    
    const posterUrl = meta?.images?.[0]?.url;
    if (posterUrl) {
      mediaArt.src = posterUrl;
      mediaArt.classList.remove('hidden');
      mediaArtContainer.querySelector('.music-icon').classList.add('hidden');
    } else {
      mediaArt.classList.add('hidden');
      mediaArtContainer.querySelector('.music-icon').classList.remove('hidden');
    }
  } else {
    // Idle / No Media
    btnStop.disabled = true;
    btnPlayPause.disabled = true;
    btnSkipBack.disabled = true;
    btnSkipForward.disabled = true;
    svgPlay.classList.remove('hidden');
    svgPause.classList.add('hidden');
    
    mediaTitle.textContent = 'No media active';
    mediaArtist.textContent = 'Idle';
    mediaArt.classList.add('hidden');
    mediaArtContainer.querySelector('.music-icon').classList.remove('hidden');
    
    stopProgressTicker();
    updateProgressDisplay(0, 0);
  }
  
  // Render playlist items
  renderPlaylist(state.playlist || [], state.currentPlayingIndex);
}

// Fallback interface values when server/box is disconnected
function updateOfflineState() {
  statusDot.className = 'status-dot disconnected';
  statusLabel.textContent = 'Offline';
  activeApp.textContent = 'None';
  activeApp.className = 'active-app-badge hidden';
  btnStop.disabled = true;
  btnPlayPause.disabled = true;
  btnSkipBack.disabled = true;
  btnSkipForward.disabled = true;
  btnPowerOn.disabled = true;
  btnPowerOff.disabled = true;
  mediaTitle.textContent = 'No media active';
  mediaArtist.textContent = 'Idle';
  mediaArt.classList.add('hidden');
  mediaArtContainer.querySelector('.music-icon').classList.remove('hidden');
  stopProgressTicker();
  updateProgressDisplay(0, 0);
  renderPlaylist([], -1);
}

// Render the Playlist Queue component
function renderPlaylist(playlistItems, currentIndex) {
  playlistQueue.innerHTML = '';
  
  if (playlistItems.length === 0) {
    playlistQueue.innerHTML = '<div class="empty-queue-msg">Queue is empty</div>';
    return;
  }
  
  playlistItems.forEach((item, index) => {
    const isActive = index === currentIndex;
    
    const itemEl = document.createElement('div');
    itemEl.className = `playlist-item ${isActive ? 'active' : ''}`;
    
    // Play/Pause icon depending on active track playback state
    let playIconSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
    `;
    
    if (isActive && isPlaying) {
      playIconSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>
      `;
    }
    
    itemEl.innerHTML = `
      <button class="btn-playlist-play" data-index="${index}" title="Play Track">
        ${playIconSvg}
      </button>
      <div class="playlist-item-details">
        <div class="playlist-title">${item.title}</div>
        <div class="playlist-subtitle">${item.contentType}</div>
      </div>
      <button class="btn-playlist-remove" data-id="${item.id}" title="Remove Track">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;
    
    // Event bindings for inline playlist actions
    itemEl.querySelector('.btn-playlist-play').addEventListener('click', () => {
      if (isActive) {
        // Toggle play/pause
        sendCommand(isPlaying ? 'pause' : 'play');
      } else {
        playPlaylistItem(index);
      }
    });
    
    itemEl.querySelector('.btn-playlist-remove').addEventListener('click', () => {
      removePlaylistItem(item.id);
    });
    
    playlistQueue.appendChild(itemEl);
  });
}

// Format duration seconds to human-readable (M:SS)
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Check if user is currently dragging seek bar
let isDraggingProgress = false;

// Update the seek bar fill and labels
function updateProgressDisplay(current, total) {
  if (isDraggingProgress) return;
  currentProgressSeconds = current;
  totalDurationSeconds = total || 0;
  
  currentTimeEl.textContent = formatTime(current);
  totalTimeEl.textContent = formatTime(total);
  
  const percentage = total > 0 ? (current / total) * 100 : 0;
  progressFill.style.width = `${percentage}%`;
}

// Tick the client-side seek progress bar locally during playback
function startProgressTicker(initialTime, duration) {
  stopProgressTicker();
  currentProgressSeconds = initialTime || 0;
  totalDurationSeconds = duration || 0;
  
  if (!isDraggingProgress) {
    updateProgressDisplay(currentProgressSeconds, totalDurationSeconds);
  }
  
  progressInterval = setInterval(() => {
    if (currentProgressSeconds < totalDurationSeconds) {
      currentProgressSeconds += 1;
      if (!isDraggingProgress) {
        updateProgressDisplay(currentProgressSeconds, totalDurationSeconds);
      }
    } else {
      stopProgressTicker();
    }
  }, 1000);
}

function stopProgressTicker() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

// Local File Upload Ajax Logic
function uploadFile(file) {
  uploadProgressContainer.classList.remove('hidden');
  uploadStatusText.textContent = `Uploading "${file.name}"...`;
  
  const formData = new FormData();
  formData.append('mediaFile', file);
  formData.append('title', file.name.replace(/\.[^/.]+$/, "")); // Strip file extension for display title
  
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);
  
  // Track upload progress
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      uploadProgressFill.style.width = `${percentComplete}%`;
      uploadProgressPercent.textContent = `${percentComplete}%`;
    }
  };
  
  xhr.onload = async () => {
    if (xhr.status === 200) {
      try {
        const responseData = JSON.parse(xhr.responseText);
        uploadStatusText.textContent = 'Upload complete! Adding to queue...';
        
        // Auto-add the uploaded file to playlist queue
        const addResponse = await fetch('/api/playlist/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: responseData.file.url,
            title: responseData.file.title,
            contentType: responseData.file.contentType
          })
        });
        
        if (addResponse.ok) {
          setTimeout(() => {
            uploadProgressContainer.classList.add('hidden');
            uploadProgressFill.style.width = '0%';
          }, 1500);
        } else {
          alert('Failed to add uploaded file to playlist.');
        }
      } catch (err) {
        console.error('Upload JSON parsing failed:', err);
      }
    } else {
      alert(`Upload failed: ${xhr.statusText}`);
      uploadProgressContainer.classList.add('hidden');
    }
  };
  
  xhr.onerror = () => {
    alert('Network error occurred during file upload.');
    uploadProgressContainer.classList.add('hidden');
  };
  
  xhr.send(formData);
}

// REST API Request Wrappers

// Playlist management APIs
async function addPlaylistItem(item) {
  try {
    const response = await fetch('/api/playlist/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await response.json();
  } catch (err) {
    console.error(err);
  }
}

async function removePlaylistItem(id) {
  try {
    await fetch('/api/playlist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
  } catch (err) {
    console.error(err);
  }
}

async function playPlaylistItem(index) {
  try {
    await fetch('/api/playlist/play-index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
  } catch (err) {
    console.error(err);
  }
}

async function clearPlaylistQueue() {
  try {
    await fetch('/api/playlist/clear', { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
}

async function sendCommand(action, value = null) {
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, value })
    });
    
    const data = await response.json();
    if (!response.ok) {
      alert(`Command Error: ${data.error || 'Request failed'}`);
    }
    return data;
  } catch (err) {
    console.error('Command request failed:', err);
  }
}

// Drag & Drop event bindings
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    uploadFile(files[0]);
  }
});

// Click upload zone trigger
uploadZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files.length > 0) {
    uploadFile(files[0]);
  }
});

// Playlist operations bindings
btnClearQueue.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear the playlist queue?')) {
    clearPlaylistQueue();
  }
});

// Event Bindings
btnPlayPause.addEventListener('click', () => {
  btnPlayPause.style.transform = 'scale(0.9)';
  setTimeout(() => btnPlayPause.style.transform = '', 120);
  const action = isPlaying ? 'pause' : 'play';
  sendCommand(action);
});

btnStop.addEventListener('click', () => {
  btnStop.style.transform = 'scale(0.9)';
  setTimeout(() => btnStop.style.transform = '', 120);
  sendCommand('stop');
});

btnMute.addEventListener('click', () => {
  const isMuted = !svgVolMute.classList.contains('hidden');
  sendCommand(isMuted ? 'unmute' : 'mute');
});

volSlider.addEventListener('input', (e) => {
  const value = e.target.value;
  volLabel.textContent = `${value}%`;
});

volSlider.addEventListener('change', (e) => {
  const level = parseFloat(e.target.value) / 100;
  sendCommand('volume', level);
});

// Helper to get time and percentage from event
function getProgressInfo(e) {
  const rect = progressTrack.getBoundingClientRect();
  let clientX;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
  } else {
    clientX = e.clientX;
  }
  let clickX = clientX - rect.left;
  clickX = Math.max(0, Math.min(clickX, rect.width));
  const percentage = clickX / rect.width;
  const seekTime = Math.round(percentage * totalDurationSeconds);
  return { percentage, seekTime };
}

function handleDragMove(e) {
  if (!isDraggingProgress || totalDurationSeconds <= 0) return;
  const { percentage, seekTime } = getProgressInfo(e);
  progressFill.style.width = `${percentage * 100}%`;
  currentTimeEl.textContent = formatTime(seekTime);
}

function handleDragEnd(e) {
  if (!isDraggingProgress) return;
  isDraggingProgress = false;
  progressTrack.classList.remove('dragging');
  const { seekTime } = getProgressInfo(e);
  sendCommand('seek', seekTime);
}

// Click and start dragging
progressTrack.addEventListener('mousedown', (e) => {
  if (!lastKnownState || !lastKnownState.player || totalDurationSeconds <= 0) return;
  isDraggingProgress = true;
  progressTrack.classList.add('dragging');
  const { percentage, seekTime } = getProgressInfo(e);
  progressFill.style.width = `${percentage * 100}%`;
  currentTimeEl.textContent = formatTime(seekTime);
});

document.addEventListener('mousemove', handleDragMove);
document.addEventListener('mouseup', handleDragEnd);

// Touch support for mobile devices
progressTrack.addEventListener('touchstart', (e) => {
  if (!lastKnownState || !lastKnownState.player || totalDurationSeconds <= 0) return;
  isDraggingProgress = true;
  progressTrack.classList.add('dragging');
  const { percentage, seekTime } = getProgressInfo(e);
  progressFill.style.width = `${percentage * 100}%`;
  currentTimeEl.textContent = formatTime(seekTime);
}, { passive: true });

document.addEventListener('touchmove', handleDragMove, { passive: true });
document.addEventListener('touchend', handleDragEnd);

// Hover tooltip preview logic
progressTrack.addEventListener('mousemove', (e) => {
  if (totalDurationSeconds <= 0) return;
  
  const rect = progressTrack.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percentage = Math.max(0, Math.min(clickX / rect.width, 1));
  const hoveredTime = Math.round(percentage * totalDurationSeconds);
  
  progressTooltip.textContent = formatTime(hoveredTime);
  progressTooltip.style.left = `${percentage * 100}%`;
  progressTooltip.classList.remove('hidden');
});

progressTrack.addEventListener('mouseleave', () => {
  progressTooltip.classList.add('hidden');
});

// Skip buttons click handlers
btnSkipBack.addEventListener('click', () => {
  if (!lastKnownState || !lastKnownState.player || totalDurationSeconds <= 0) return;
  let seekTime = Math.max(0, currentProgressSeconds - 10);
  currentProgressSeconds = seekTime;
  updateProgressDisplay(currentProgressSeconds, totalDurationSeconds);
  sendCommand('seek', seekTime);
});

btnSkipForward.addEventListener('click', () => {
  if (!lastKnownState || !lastKnownState.player || totalDurationSeconds <= 0) return;
  let seekTime = Math.min(totalDurationSeconds, currentProgressSeconds + 10);
  currentProgressSeconds = seekTime;
  updateProgressDisplay(currentProgressSeconds, totalDurationSeconds);
  sendCommand('seek', seekTime);
});

// Stream url casting submit
castForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const mediaUrl = mediaUrlInput.value.trim();
  const title = mediaTitleInput.value.trim() || 'Custom Media Stream';
  const contentType = mediaTypeSelect.value;
  const poster = mediaPosterInput.value.trim();
  
  if (!mediaUrl) return;
  
  btnCastSubmit.disabled = true;
  btnCastSubmit.querySelector('span').textContent = 'Adding to queue...';
  
  // Submit via queue add so it works through our queue system
  await addPlaylistItem({ url: mediaUrl, title, contentType, poster });
  
  btnCastSubmit.disabled = false;
  btnCastSubmit.querySelector('span').textContent = 'Cast';
  
  // Reset inputs
  mediaUrlInput.value = '';
  mediaTitleInput.value = '';
  mediaPosterInput.value = '';
});

// Handle Target IP updates
btnUpdateIp.addEventListener('click', async () => {
  const ip = targetIpInput.value.trim();
  if (!ip) return;
  
  btnUpdateIp.disabled = true;
  btnUpdateIp.textContent = 'Saving...';
  
  try {
    const res = await fetch('/api/config/ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    
    if (res.ok) {
      console.log(`Successfully updated target IP to ${ip}`);
    } else {
      console.error('Failed to update target IP');
    }
  } catch (err) {
    console.error('Network error updating target IP:', err);
  } finally {
    btnUpdateIp.disabled = false;
    btnUpdateIp.textContent = 'Update';
  }
});

// Handle Server Restart
btnRestartServer.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to restart the backend server process? (This will temporarily close dashboard feeds).')) return;
  
  btnRestartServer.disabled = true;
  btnRestartServer.style.opacity = '0.5';
  
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    if (res.ok) {
      console.log('Server restart command sent successfully.');
      statusDot.className = 'status-dot disconnected';
      statusLabel.textContent = 'Restarting...';
      
      // Reload page after 3 seconds
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      alert('Failed to send restart command');
      btnRestartServer.disabled = false;
      btnRestartServer.style.opacity = '1';
    }
  } catch (err) {
    console.error('Error sending restart command:', err);
    btnRestartServer.disabled = false;
    btnRestartServer.style.opacity = '1';
  }
});


// Power buttons click event binding
btnPowerOn.addEventListener('click', () => {
  btnPowerOn.style.transform = 'scale(0.85)';
  setTimeout(() => btnPowerOn.style.transform = '', 120);
  sendCommand('on');
});

btnPowerOff.addEventListener('click', () => {
  btnPowerOff.style.transform = 'scale(0.85)';
  setTimeout(() => btnPowerOff.style.transform = '', 120);
  sendCommand('off');
});

// Initialize WebSocket Status Feed Connection on page load
window.addEventListener('load', () => {
  connectWebSocket();
});
