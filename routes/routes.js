import express from "express";
import { ObjectId } from "mongodb";
import db from "../db/connections.js";
import rateLimit from 'express-rate-limit';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = express.Router();
const key = process.env.NETS_KEY;
const jwt_key = process.env.JWT_SECRET;

router.post("/v1/payments", async (req, res) => {
  try {
    const product = req.body;
    const response = await fetch("https://test.api.dibspayment.eu/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
      body: JSON.stringify(product)
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/eventCreated", async (req, res) => {
  try {
    const event = req.body;

    // Log the event for debugging purposes
    console.log("Webhook event received:", event);

    // Process the event (you can add your custom logic here)
    // For example, you might want to handle different event types differently
    switch (event.eventname) {
      case "payment.created":
        // Handle payment created event
        console.log("Payment created event:", event);
        break;
      // Add more cases as needed for different event types
      default:
        console.log("Unhandled event type:", event.eventname);
    }

    // Respond to the webhook request
    res.status(200).send("Event received");
  } catch (error) {
    console.error("Error processing webhook event:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/v1/payments/:paymentId", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const response = await fetch(`https://test.api.dibspayment.eu/v1/payments/${paymentId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts, please try again later",
});

router.post("/login", loginLimiter, async (req, res) => {
  const collections = db.collection("users");
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const user = await collections.findOne({ username })
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "Lax",
      //secure
    })

    res.status(200).json({ message: "Login successful", token });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }

});

function authenticateToken(req, res, next) {
  // Get the token from cookies
  const token = req.cookies.token;
  console.log("Token from cookies:", token); // Add this line for debugging
  if (!token) {
    return res.status(401).json({ message: 'Access Denied. No token provided.' });
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Add decoded user info to the request
    next(); // Proceed to the next middleware or route
  } catch (err) {
    console.error('Token verification failed:', err);
    res.status(403).json({ message: 'Invalid or expired token.' });
  }
}

router.get("/checkAuth", authenticateToken, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false });
  }

  res.status(200).json({ authenticated: true, user: req.user });
});

router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const userExist = await db.collection("users").findOne({ username });
    if (userExist) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await db.collection("users").insertOne({ username, passwordHash });

    res.status(201).json({ message: "User created" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/months", async (req, res) => {
  let collections = db.collection("months")
  let result = await collections.find({}).toArray();
  res.json(result);
});

router.patch("/checkout", async (req, res) => {
  const { month, day, category, time, cost, players, payed, available, bookedBy, number, email, info, paymentId } = req.body;

  try {
    let collections = db.collection("months");
    let result = await collections.updateOne(
      { "month": month, "days.day": day, "days.categories.name": category, "days.categories.times.time": time },
      {
        $set: {
          "days.$[day].categories.$[category].times.$[time].available": available,
          "days.$[day].categories.$[category].times.$[time].players": players,
          "days.$[day].categories.$[category].times.$[time].payed": payed,
          "days.$[day].categories.$[category].times.$[time].cost": cost,
          "days.$[day].categories.$[category].times.$[time].bookedBy": bookedBy,
          "days.$[day].categories.$[category].times.$[time].number": number,
          "days.$[day].categories.$[category].times.$[time].email": email,
          "days.$[day].categories.$[category].times.$[time].info": info,
          "days.$[day].categories.$[category].times.$[time].paymentId": paymentId
        }
      },
      { arrayFilters: [{ "day.day": day }, { "category.name": category }, { "time.time": time }] }
    );
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

// const order = {
//   order: {
//     items: [
//         ...items
//     ],
//     amount: totalCost,
//     currency: "SEK",
//     reference: Math.random().toString(36).substring(2, 15),
// },
// checkout: {
//     integrationType: "HostedPaymentPage",
//     returnUrl: "localhost:5173/",
//     cancelUrl: "localhost:5173/",
//     termsUrl: "localhost:5173/terms",
// },
// notifications: {
//     webHooks: [
//     {
//         eventname: "payment.created",
//         url: "https://mintbackend-0066444807ba.herokuapp.com/eventCreated"
//     }
// ]
// }
// }