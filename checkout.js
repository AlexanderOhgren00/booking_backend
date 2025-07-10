import express from 'express';
import routes from './routes/routes.js';
import cors from "cors";
import herokuSSLRedirect from "heroku-ssl-redirect";
import helmet from "helmet";
import cookieParser from 'cookie-parser';
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import timeout from "connect-timeout";

const sslRedirect = herokuSSLRedirect.default;
const app = express();
const server = http.createServer(app);
export const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

//origin:
    //"http://localhost:5173",
    //"http://89.46.83.171",
    //"https://89.46.83.171",
    //"http://77.81.6.112",
    ///^http:\/\/89\.46\.83\.\d{1,3}$/,
    ///^https:\/\/89\.46\.83\.\d{1,3}$/,
    ///^http:\/\/103\.57\.74\.\d{1,3}$/,
    ///^https:\/\/103\.57\.74\.\d{1,3}$/
//,

const corsOptions = {
    origin: [
        "https://zesty-eclair-5d4eaa.netlify.app",
        "https://enchanting-longma-db94e4.netlify.app",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
        "http://89.46.83.171",
        "https://89.46.83.171",
        "http://77.81.6.112",
        "https://mintescaperoom.se",
        "https://www.mintescaperoom.se",
        "https://admin.mintescaperoom.se",
        /^https:\/\/admin\.mintescaperoom\.se(\/.*)?$/,
        /^http:\/\/89\.46\.83\.\d{1,3}$/,
        /^https:\/\/89\.46\.83\.\d{1,3}$/,
        /^http:\/\/103\.57\.74\.\d{1,3}$/,
        /^https:\/\/103\.57\.74\.\d{1,3}$/
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 600
};

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Send a welcome message
  ws.send(JSON.stringify({ message: "Connected to WebSocket server" }));

  // Set connection timeout (close after 1 hour of inactivity)
  const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
          console.log("Closing idle WebSocket connection");
          ws.close(1000, "Connection timeout");
      }
  }, 60 * 60 * 1000); // 1 hour

  // Keep connection alive with ping/pong
  const keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
          ws.ping(); // Use built-in ping instead of custom message
      } else {
          clearInterval(keepAliveInterval);
          clearTimeout(connectionTimeout);
      }
  }, 30000); // Every 30 seconds

  // Handle messages from clients
  ws.on("message", (message) => {
    // Handle incoming messages here if needed
  });
  
  // Handle pong responses
  ws.on("pong", () => {
    // Connection is alive
  });
  
  // Handle errors
  ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      clearInterval(keepAliveInterval);
      clearTimeout(connectionTimeout);
  });

  // Handle disconnection - SINGLE handler only
  ws.on("close", (code, reason) => {
      console.log(`Client disconnected: ${code} ${reason}`);
      clearInterval(keepAliveInterval);
      clearTimeout(connectionTimeout);
  });

  // Clear timeout on close (handled in main close handler above)
});

app.set('wss', wss);
app.use(timeout("20s"));
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
