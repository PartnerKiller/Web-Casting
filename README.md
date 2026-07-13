# SmartCast: Dual-Target Local Media Casting Dashboard

SmartCast is a high-performance, unified media casting remote control dashboard built with Node.js and Express. It allows you to concurrently cast local media items, stream links, and uploaded files to **both** a physical Jio Set-Top Box (Jio Cast) and a TV Web Receiver (Web Cast) in real-time.

---

## Key Features

### 1. Dual-Target Unified Control
- Cast media streams concurrently to both your physical JioSTB and TV Web Receiver.
- Synchronized controls across all devices (Play, Pause, Stop, Seek, Volume, Mute, Power ON, Power OFF).

### 2. Premium Remote Dashboard Layout
- **Glassmorphic UI**: High-fidelity translucent interfaces using CSS backdrop-filtering.
- **Draggable Seek Bar**: Interactive progress bar with local drag updates and a glassmorphic time preview tooltip on hover.
- **10s Jump Buttons**: Rotate SVGs to skip 10 seconds forward or backward.
- **Diagnostics & Status Dot**: View network IPs (STB, TV Receiver, Local PC), active application titles, connection status, and server diagnostic logs.

### 3. TV Web Receiver (`/client`)
- Fully-featured custom web player that processes commands sent from the dashboard via WebSockets.
- **Auto-resumption on Reload**: If you refresh the web client mid-stream, it automatically reconnects and resumes playback from the Set-Top Box's exact real-time playback position.
- **Drift Synchronization Backend**: Server monitors both receivers and issues automatic seek alignment commands if the TV receiver drifts by more than 3 seconds.
- **Auto-Fullscreen Rotation**: Detects screen aspect-ratio rotations on mobile displays to launch fullscreen mode on landscape and exit on portrait orientation changes.

### 4. Power Controls
- **ON**: Launches the `DefaultMediaReceiver` application on the Set-Top Box or wakes the TV Web Receiver page.
- **OFF**: Shuts down the cast applications on the Set-Top Box (returning it to the STB homepage) and appends a premium dark standby power overlay to the TV Web Receiver.

---

## Project Structure

```
├── server.js               # Backend Node.js server (Express & WebSocket)
├── package.json            # Node project configuration
├── .gitignore              # Files ignored from Git tracking
└── public/                 # Static assets folder
    ├── index.html          # Remote dashboard markup
    ├── style.css           # Premium glassmorphic interface styles
    ├── app.js              # Dashboard client logic (REST & WebSockets)
    ├── tv.html             # TV Web Receiver client layout
    └── tv.js               # TV Web Receiver video/audio player controllers
```

---

## Installation & Setup

### Prerequisites
- Node.js (v14 or higher recommended)
- Git (optional, for versioning)
- A Jio Set-Top Box (ensure casting is enabled, on the same Wi-Fi network)

### 1. Clone the repository
```bash
git clone https://github.com/PartnerKiller/Web-Casting.git
cd Web-Casting
```

### 2. Install dependencies
```bash
npm install
```

### 3. Launch the Server
```bash
npm start
# or
node server.js
```

Upon launching, the console logs the auto-detected local network IP and connection status for the JioSTB:
```text
Auto-detected local PC network IP address: 192.168.0.11
Dashboard web server listening on http://localhost:3000
Connecting to JioSTB Cast Service at 192.168.0.165:8009...
Connected to JioSTB Cast Service.
```

---

## How to Use

1. **Open the Remote Dashboard**: Go to `http://localhost:3000` (or `http://<your-pc-ip>:3000`) on your computer or smartphone.
2. **Launch the TV Web Receiver (Optional)**: Open `http://localhost:3000/client` on any screen (such as a smart TV browser, tablet, or secondary display) you want to cast to.
3. **Configure JioSTB IP**: In the target configuration panel of the dashboard, confirm/update your Set-Top Box's IP address.
4. **Select or Upload Media**: Select a preset video stream from the list or upload a custom media file.
5. **Start Casting**: Click **Cast** or select a track. The video starts playing simultaneously on your TV Web Receiver and the JioSTB!
6. **Playback Controls**: Use the remote buttons to play, pause, seek, volume control, or power standby target displays.
