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
};

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Send a welcome message
  ws.send(JSON.stringify({ message: "Connected to WebSocket server" }));

  // Handle messages from clients
  ws.on("message", (message) => {
      console.log(`Received: ${message}`);
  });

  // Handle errors
  ws.on("error", (err) => {
      console.error("WebSocket error:", err);
  });

  // Handle disconnection
  ws.on("close", () => {
      console.log("Client disconnected");
  });

  // Keep connection alive
  const keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" })); // Send a keep-alive message
      }
  }, 30000); // Every 30 seconds

  ws.on("close", () => {
      clearInterval(keepAliveInterval);
  });
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
