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

  // Handle messages from clients
  ws.on("message", (message) => {
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
