import express from 'express';
import routes from './routes/routes.js';
import cors from "cors";
import herokuSSLRedirect from "heroku-ssl-redirect";
import helmet from "helmet";
import cookieParser from 'cookie-parser';
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const sslRedirect = herokuSSLRedirect.default;
const app = express();
const server = http.createServer(app);
export const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin: "http://localhost:5173",
  credentials: true,
}

class heartbeat {
  constructor() {
    this.isAlive = true;
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // Send initial connection message
  ws.send(JSON.stringify({ type: 'connection', message: 'Connected to server' }));

  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      console.log('Received:', data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Check for stale connections every 30 seconds
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

app.set('wss', wss);
app.use(sslRedirect());
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(routes);

server.listen(PORT, (err) => {
  if (err) console.log(err);
  console.log("Server listening on PORT", PORT);
});
