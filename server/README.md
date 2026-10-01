# Wave Radio Relay Server

A lightweight, production-ready Node.js relay server for Wave Radio. This server ingests live audio from a DJ via a WebSocket connection and efficiently rebroadcasts it to listeners using HTTP Chunked Streaming.

## Architecture

```text
  [ DJ / Broadcaster ] 
           |
           | (WebSocket w/ Auth, Binary Audio Chunks)
           v
  +------------------+
  |  Wave Radio      |
  |  Relay Server    |  <-- Buffers Init Segment + Recent Chunks
  +------------------+
           |
           | (HTTP Chunked Transfer-Encoding: audio/webm;codecs=opus)
           +------------+------------+
           |            |            |
           v            v            v
      [Listener 1] [Listener 2] [Listener 3] ... (up to 500+)
```

## Quick Start (Local Development)

1. Clone or download the repository, then navigate to this folder:
   ```bash
   cd server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the server:
   ```bash
   npm start
   # or for development with auto-restart:
   # npm run dev
   ```
   The server will run on `http://localhost:3000`.

## Environment Variables

- `PORT`: Port to run the server on (default: `3000`)
- `DJ_PASSWORD`: The secret token required for a DJ to start a broadcast (default: `waveradio2024`)
- `MAX_LISTENERS`: The maximum number of concurrent HTTP listener connections (default: `500`)

## API Endpoints

### `GET /stream`
The main audio entrypoint for listeners. 
- Returns HTTP streaming response (`audio/webm;codecs=opus`).
- Returns `503 Service Unavailable` if the DJ is not live.

### `GET /status`
Returns real-time server JSON metadata.
```json
{
  "isLive": true,
  "djName": "DJ Awesome",
  "showTitle": "Morning Vibes",
  "listeners": 42,
  "startedAt": "2024-05-12T10:00:00Z",
  "uptime": 3600,
  "peakListeners": 120
}
```

### `GET /health`
For load balancer health checks. Returns HTTP `200 OK` with JSON `{ "status": "ok", "uptime": 1234 }`.

### `WebSocket /ws`
The WebSocket entrypoint for the DJ.
- **Auth Phase**: Client sends JSON: `{ "type": "auth", "token": "waveradio2024", "djName": "DJ Name" }`
- **Control Phase**: Client sends JSON to update state:
  - `{ "type": "start", "showTitle": "My Show" }`
  - `{ "type": "metadata", "showTitle": "New Song - Artist" }`
  - `{ "type": "stop" }`
- **Data Phase**: Client sends binary WebM Opus chunks. The first chunk should be the WebM init segment.

## Deployment

### Render.com (Recommended)
1. Fork or push this code to a GitHub repository.
2. Sign up/Log in to [Render](https://render.com).
3. Click **New +** -> **Blueprint**.
4. Connect your repository. Render will automatically detect the `render.yaml` file in this directory and configure the service.
5. In the Render Dashboard, go to the newly created Web Service, navigate to **Environment**, and set your own secure `DJ_PASSWORD`.

### Railway.app (One-Click)
1. Go to [Railway.app](https://railway.app/).
2. Create a New Project -> "Deploy from GitHub repo".
3. Add an Environment Variable for `DJ_PASSWORD`.
4. Railway will automatically build and deploy using the provided `Dockerfile` or standard Node.js buildpack.

### Docker
To build and run with Docker locally or on a VPS:
```bash
docker build -t wave-radio-relay .
docker run -p 3000:3000 -e DJ_PASSWORD=your_secure_password wave-radio-relay
```

### VPS (DigitalOcean, AWS, Linode)
1. SSH into your VPS.
2. Install Node.js (18+) and PM2 (`npm install -g pm2`).
3. Clone this repository.
4. `npm install --only=production`
5. `DJ_PASSWORD=supersecret pm2 start server.js --name "wave-radio"`
6. Use Nginx as a reverse proxy, and be sure to disable proxy buffering for the `/stream` endpoint:
   ```nginx
   location /stream {
       proxy_pass http://localhost:3000;
       proxy_buffering off;
       proxy_set_header Connection keep-alive;
   }
   ```

## Scaling Considerations

Out of the box, this single Node.js instance can handle ~500 to 1,000 concurrent listeners efficiently, depending on CPU.
If you need to scale to 3000+ listeners:
1. **Increase `MAX_LISTENERS`**: Update the ENV variable.
2. **Reverse Proxy Caching**: Use an Edge CDN (like Cloudflare or Fastly) configured to multiplex streaming requests, or Icecast for edge distribution. (Note: pure chunked encoding can be tricky to cache via standard CDNs without proper media server software).
3. **Ulimits**: Ensure your OS allows enough open file descriptors (sockets). Check with `ulimit -n`.

## Troubleshooting

- **Listeners connect but hear silence**: Make sure the DJ app sends the absolute FIRST chunk (the WebM init segment) immediately after the `"start"` message. If listeners join midway and don't receive this segment, browsers cannot decode the Opus audio.
- **DJ connection rejected**: Another socket might be hanging open. Check `/status` to see if `isLive` is true, or restart the server.
- **Listeners dropping**: Check reverse proxy settings (like Nginx `proxy_read_timeout` or `proxy_buffering off`) ensuring HTTP Keep-Alive allows indefinite long-lived connections.
