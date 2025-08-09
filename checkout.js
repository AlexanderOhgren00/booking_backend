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
export { WebSocket };

// Track connections per IP to prevent abuse
const connectionsByIP = new Map();
const MAX_CONNECTIONS_PER_IP = 50;

// Track blocked IPs with timestamp
const blockedIPs = new Map(); // IP -> blockedUntil timestamp
const BLOCK_DURATION = 5 * 60 * 1000; // 5 minutes

// Clean up expired blocks every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, blockedUntil] of blockedIPs.entries()) {
    if (now > blockedUntil) {
      blockedIPs.delete(ip);
      console.log(`Unblocked IP: ${ip}`);
    }
  }
}, 60 * 1000);

// Track all active connections for cleanup
const activeConnections = new Set();

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

wss.on("connection", (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Check if IP is currently blocked
  const blockedUntil = blockedIPs.get(clientIP);
  if (blockedUntil && Date.now() < blockedUntil) {
    console.log(`Blocked IP attempted connection: ${clientIP}`);
    ws.close(1008, "IP temporarily blocked");
    return;
  }
  
  // Check connection limit per IP
  const currentConnections = connectionsByIP.get(clientIP) || 0;
  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    console.log(`Connection limit exceeded for IP: ${clientIP} - blocking for 5 minutes`);
    
    // Block this IP for 5 minutes
    const blockUntil = Date.now() + BLOCK_DURATION;
    blockedIPs.set(clientIP, blockUntil);
    
    ws.close(1008, "Too many connections - IP blocked");
    return;
  }
  
  // Track this connection
  connectionsByIP.set(clientIP, currentConnections + 1);
  activeConnections.add(ws);
  
  console.log(`Client connected from ${clientIP} (${currentConnections + 1} total)`);

  // Send a welcome message
  ws.send(JSON.stringify({ message: "Connected to WebSocket server" }));

  // Set connection timeout (close after 10 minutes of inactivity)
  let connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
          console.log("Closing idle WebSocket connection");
          ws.close(1000, "Connection timeout");
      }
  }, 10 * 60 * 1000); // 10 minutes

  // Function to reset the timeout on activity
  const resetTimeout = () => {
    clearTimeout(connectionTimeout);
    connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log("Closing idle WebSocket connection");
        ws.close(1000, "Connection timeout");
      }
    }, 10 * 60 * 1000); // Reset to 10 minutes
  };

  // Keep connection alive with ping/pong (reduced to 20 seconds)
  const keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
          ws.ping(); // Use built-in ping instead of custom message
      } else {
          clearInterval(keepAliveInterval);
          clearTimeout(connectionTimeout);
      }
  }, 20000); // Every 20 seconds instead of 30

  // Handle messages from clients
  ws.on("message", (message) => {
    // Reset timeout on any message activity
    resetTimeout();
    
    // Handle incoming messages here if needed
    try {
      const parsedMessage = JSON.parse(message);
      if (parsedMessage.type === "ping") {
        // Respond to client ping with pong
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (parsedMessage.type === "pong") {
        // Client responded to our ping - connection is alive
        // Timeout already reset by the resetTimeout() call above
      }
    } catch (error) {
      // Ignore non-JSON messages
    }
  });
  
  // Handle pong responses
  ws.on("pong", () => {
    // Connection is alive - reset timeout
    resetTimeout();
  });
  
  // Handle errors
  ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      clearInterval(keepAliveInterval);
      clearTimeout(connectionTimeout);
  });

  // Handle disconnection - SINGLE handler only
  ws.on("close", (code, reason) => {
      console.log(`Client disconnected from ${clientIP}: ${code} ${reason}`);
      clearInterval(keepAliveInterval);
      clearTimeout(connectionTimeout);
      
      // Remove from active connections
      activeConnections.delete(ws);
      
      // Decrement connection count for the IP
      const currentConnections = connectionsByIP.get(clientIP) || 0;
      if (currentConnections > 0) {
          connectionsByIP.set(clientIP, currentConnections - 1);
          if (currentConnections === 1) {
              connectionsByIP.delete(clientIP); // Clean up if no more connections
          }
      }
  });

  // Clear timeout on close (handled in main close handler above)
});

// Periodic cleanup of stale connections every 2 minutes
setInterval(() => {
    let staleClosed = 0;
    activeConnections.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) {
            activeConnections.delete(ws);
            staleClosed++;
        }
    });
    
    if (staleClosed > 0) {
        console.log(`Cleaned up ${staleClosed} stale WebSocket connections`);
    }
    
    console.log(`Active WebSocket connections: ${activeConnections.size}`);
}, 2 * 60 * 1000); // Every 2 minutes

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

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing WebSocket connections...');
  
  activeConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Server shutdown');
    }
  });
  
  setTimeout(() => {
    console.log('Server shutting down...');
    process.exit(0);
  }, 5000); // Give 5 seconds for connections to close
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing WebSocket connections...');
  
  activeConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Server shutdown');
    }
  });
  
  setTimeout(() => {
    console.log('Server shutting down...');
    process.exit(0);
  }, 5000); // Give 5 seconds for connections to close
});
