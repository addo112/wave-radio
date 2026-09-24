# Wave Radio - Feel The Frequency

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Netlify Status](https://api.netlify.com/api/v1/badges/your-site-id/deploy-status)
![Version](https://img.shields.io/badge/version-1.0.0-brightgreen)

Wave Radio is a modern, responsive Progressive Web App (PWA) for 24/7 internet radio streaming. Built with a serverless architecture on Netlify, it provides real-time track metadata, live schedules, and listener statistics.

## Features

- 🎧 **Live Audio Streaming**: High-quality uninterrupted audio playback
- 📱 **Progressive Web App**: Installable on desktop and mobile devices
- 🎵 **Real-time Metadata**: Synchronized "Now Playing" track information
- 📅 **Dynamic Schedule**: Weekly programming guide with live indicator
- 👥 **Listener Stats**: Live concurrent viewer simulation
- 🎨 **Responsive Design**: Beautiful UI that adapts to all screen sizes

## Screenshots

*(Add screenshots here)*
- Desktop View
- Mobile View
- PWA Installed

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Netlify CLI (`npm install -g netlify-cli`)

## Quick Start (Local Development)

1. Clone the repository:
   ```bash
   git clone <your-repo-url>
   cd wave-radio
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the local development server:
   ```bash
   npm run dev
   ```
   The site will be available at `http://localhost:8888`.

## Deployment to Netlify

### Option 1: Using Netlify CLI (Fastest)

1. Login to Netlify:
   ```bash
   netlify login
   ```

2. Initialize the site:
   ```bash
   netlify init
   ```

3. Deploy to production:
   ```bash
   npm run deploy
   ```

### Option 2: Git-based Deployment (Recommended for CI/CD)

1. Push your code to GitHub, GitLab, or Bitbucket.
2. Go to [Netlify Dashboard](https://app.netlify.com).
3. Click "Add new site" -> "Import an existing project".
4. Connect your Git provider and select the repository.
5. Build settings will be automatically populated from `netlify.toml`.
6. Click "Deploy site".

## Configuration

### Changing the Stream URL
To point the app to your own radio stream, edit the `CONFIG` object in your `app.js` (or similar frontend file):
```javascript
const CONFIG = {
  streamUrl: 'YOUR_STREAM_URL_HERE'
};
```

### Setting up a Backend Stream Server
Wave Radio provides the frontend and metadata APIs, but you need a dedicated streaming server for the audio.

**Free/Easy Option:**
- **Zeno.fm**: Create a free station, get the stream URL, and paste it into the config. Handles thousands of listeners for free.

**Self-Hosted/Professional Options:**
- **Azuracast**: A free, self-hosted web radio management suite (Docker-based).
- **Icecast/Shoutcast**: Traditional streaming servers. Install on a VPS (DigitalOcean, Linode) along with a source client like Liquidsoap or Mixxx.

## Architecture Overview

Wave Radio uses a Jamstack architecture:
- **Frontend**: HTML/CSS/JS with Service Worker for PWA capabilities. Served globally via Netlify Edge CDN.
- **Backend APIs**: Netlify Serverless Functions (Node.js) for metadata (`now-playing.mjs`), schedules (`get-schedule.mjs`), and stats (`track-listener.mjs`).
- **Audio Stream**: Hosted independently (e.g., Icecast, Zeno.fm).

## Scaling to 300+ Concurrent Listeners

The frontend of Wave Radio is highly scalable:
- The website and APIs are hosted on Netlify and can easily handle thousands of concurrent users because static assets are cached at the CDN level.

**The Bottleneck: Audio Streaming**
Each listener opens a persistent HTTP connection to download the audio stream. 300 listeners = 300 open connections. This does *not* hit Netlify; it hits your streaming server.

**Recommendations for High Traffic:**
1. **Zeno.fm**: Highly recommended as they absorb the bandwidth costs and handle massive scale for free.
2. **CDN-Backed Stream**: If self-hosting Icecast, put it behind a CDN or load balancer designed for streaming audio.
3. **Paid Services**: Use Radio.co or Live365 which guarantee bandwidth for large audiences.

## Customization

- **Branding**: Update logos in the `public` or root directory and `manifest.json`.
- **Functions**: Modify `netlify/functions/*.mjs` to connect to your real database (e.g., Supabase, Firebase) instead of using the built-in simulations.

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS
- **Hosting**: Netlify
- **Serverless Functions**: Node.js (v18)
- **PWA**: Service Worker API

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
