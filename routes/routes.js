import express from "express";
import { ObjectId } from "mongodb";
import db from "../db/connections.js";
import rateLimit from 'express-rate-limit';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { wss } from "../checkout.js";
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();
const key = process.env.NETS_KEY;
const jwt_key = process.env.JWT_SECRET;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const paymentStates = {};

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

function haltOnTimedout(req, res, next) {
  if (!req.timedout) next()
}

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

async function cleanUpPaymentStates() {
  const currentDate = new Date();
  console.log("Cleaning up payment states...", paymentStates);
  const collections = db.collection("years");

  for (const paymentId in paymentStates) {
    const paymentDate = new Date(paymentStates[paymentId].date);
    const timeDifference = (currentDate - paymentDate) / 1000 / 60;

    if (timeDifference > 5) {
      for (const item of paymentStates[paymentId].data) {
        await collections.updateOne(
          { "year": item.year, "months.month": item.month, "months.days.day": item.day, "months.days.categories.name": item.category, "months.days.categories.times.time": item.time },
          {
            $set: {
              "months.$[month].days.$[day].categories.$[category].times.$[time].available": true,
              "months.$[month].days.$[day].categories.$[category].times.$[time].players": 0,
              "months.$[month].days.$[day].categories.$[category].times.$[time].payed": null,
              "months.$[month].days.$[day].categories.$[category].times.$[time].cost": 0,
              "months.$[month].days.$[day].categories.$[category].times.$[time].bookedBy": null,
              "months.$[month].days.$[day].categories.$[category].times.$[time].number": null,
              "months.$[month].days.$[day].categories.$[category].times.$[time].email": null,
              "months.$[month].days.$[day].categories.$[category].times.$[time].info": null,
              "months.$[month].days.$[day].categories.$[category].times.$[time].paymentId": null
            }
          },
          { arrayFilters: [{ "month.month": item.month }, { "day.day": item.day }, { "category.name": item.category }, { "time.time": item.time }] }
        );
        console.log("Payment state cleaned up:", item);
      }
      const response = await fetch(`https://test.api.dibspayment.eu/v1/payments/${paymentId}/terminate`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": key,
        },
      });
      const data = { message: "Payment terminated", paymentId };
      console.log(data);
    }
  }
}

setInterval(cleanUpPaymentStates, 300 * 1000);

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

router.post("/v1/payments/:paymentId/initialize", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const currentDate = new Date();
    const body = req.body

    for (const existingPaymentId in paymentStates) {
      const existingData = paymentStates[existingPaymentId].data;
      const hasConflict = body.combinedData.some(newItem =>
        existingData.some(existingItem =>
          existingItem.year === newItem.year &&
          existingItem.month === newItem.month &&
          existingItem.day === newItem.day &&
          existingItem.time.time === newItem.time.time
        )
      );

      if (hasConflict) {
        delete paymentStates[existingPaymentId];
        console.log(`Removed conflicting payment state: ${existingPaymentId}`);
      }
    }

    paymentStates[paymentId] = { date: currentDate, data: body.combinedData };
    console.log("Payment states:", paymentStates);

    res.status(200).json({ message: "Payment initialized", paymentId, date: currentDate });
    broadcast({
      type: "initialize",
      message: "Update"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/v1/payments/:paymentId/session-complete", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    if (!paymentStates[paymentId]) {
      return res.status(404).json({ error: "Payment session not found" });
    }
    delete paymentStates[paymentId];
    res.status(200).json({ message: "Payment session completed and removed from state", paymentId });

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

router.post("/v1/payments/:paymentId/refunds", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    console.log("Payment ID:", paymentId);
    const response = await fetch(`https://test.api.dibspayment.eu/v1/payments/${paymentId}/refunds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
})

router.post("/v1/payments/:paymentId/charges", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    console.log("Payment ID:", paymentId);
    const response = await fetch(`https://test.api.dibspayment.eu/v1/payments/${paymentId}/charges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/v1/payments/:paymentId/terminate", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const response = await fetch(`https://test.api.dibspayment.eu/v1/payments/${paymentId}/terminate`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
    });

    delete paymentStates[paymentId];

    const data = { message: "Payment terminated", paymentId };
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
    const privilage = user.privilage;

    res.cookie("token", token, {
      path: "/",
      maxAge: 3 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "none",
      secure: true,
    })

    res.status(200).json({ message: "Login successful", token, privilage, username });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }

});

function authenticateToken(req, res, next) {
  // Get the token from the request body
  const token = req.body.token;
  console.log("Token from body:", token); // Add this line for debugging
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

router.post("/checkAuth", authenticateToken, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false });
  }

  res.status(200).json({ authenticated: true, user: req.user });
});

router.post("/register", async (req, res) => {
  const { username, password, privilage } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const userExist = await db.collection("users").findOne({ username });
    if (userExist) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await db.collection("users").insertOne({ username, passwordHash, privilage });

    res.status(201).json({ message: "User created" });
    broadcast({
      type: "updateUsers",
      message: "Update",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/users", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    const collections = db.collection("users");

    // Check if user exists
    const user = await collections.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await collections.deleteOne({ username });

    if (result.deletedCount === 1) {
      // Broadcast user deletion
      broadcast({
        type: "updateUsers",
        message: "Update",
      });

      res.json({ message: "User deleted successfully" });
    } else {
      res.status(400).json({ error: "Failed to delete user" });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await db.collection("users").find({}).toArray();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/users", async (req, res) => {
  const { id, username, password, privilage } = req.body;

  try {
    const user_id = ObjectId.createFromHexString(id);
    const collections = db.collection("users");
    const user = await collections.findOne({ _id: user_id });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    let passwordHash = user.passwordHash;

    if (password !== "") {
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        passwordHash = await bcrypt.hash(password, 10);
      }
    }

    const result = await collections.updateOne(
      { _id: user_id },
      {
        $set: {
          username: username,
          passwordHash: passwordHash,
          privilage: privilage
        }
      }
    );

    res.json(result);
    broadcast({
      type: "updateUsers",
      message: "Update",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/roomDiscounts", async (req, res) => {
  try {
    const discounts = await db.collection("roomDiscounts").find({}).toArray();
    res.json(discounts);
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/bulkRoomDiscount", async (req, res) => {
  const { updates, bulk } = req.body;

  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: "Updates array is required" });
  }

  try {
    const collections = db.collection("bookings");
    const results = [];
    const currentYear = new Date().getFullYear();

    // Get all years from current year up to 2030
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    for (const update of updates) {
      const { time, category, discount, weekday, month } = update;

      // Update specific month for all years
      for (const year of years) {
        // Get the number of days in this month
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();

        // Check each day in the month
        for (let day = 1; day <= daysInMonth; day++) {
          // Check if this day matches the selected weekday
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            const result = await collections.updateOne(
              {
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true // Only update if available is true
              },
              {
                $set: {
                  discount: discount
                }
              }
            );

            if (result.modifiedCount > 0) {
              results.push({
                timeSlotId: `${year}-${month}-${day}-${category}-${time}`,
                success: true
              });
            }
          }
        }
      }
    }

    // Broadcast the update via WebSocket
    broadcast({
      type: "bulkDiscountUpdate",
      data: { updates }
    });

    res.json({
      message: "Bulk discount update completed",
      results,
      modifiedCount: results.length
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating discounts" });
  }
});

router.delete("/deleteRoomDiscount", async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Discount key is required" });
  }

  try {
    const collections = db.collection("roomDiscounts");
    const result = await collections.deleteOne({ key });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Discount not found" });
    }

    res.status(200).json({ message: "Discount deleted" });

    broadcast({
      type: "updateRoomDiscounts",
      message: "Update",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/roomDiscounts", async (req, res) => {
  const { key, PersonCost, color } = req.body;

  try {
    const collections = db.collection("roomDiscounts");

    const discountExist = await collections.findOne({ key });
    if (discountExist) {
      return res.status(400).json({ error: "Discount code already exists" });
    }

    await collections.insertOne({ key, PersonCost, color });

    res.status(201).json({ message: "Discount created" });

    broadcast({
      type: "updateRoomDiscounts",
      message: "Update",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/discounts", async (req, res) => {
  try {
    const discounts = await db.collection("discounts").find({}).toArray();
    res.json(discounts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.delete("/deleteDiscount", async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Discount key is required" });
  }

  try {
    const collections = db.collection("discounts");
    const result = await collections.deleteOne({ key });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Discount not found" });
    }

    res.status(200).json({ message: "Discount deleted" });

    broadcast({
      type: "updateDiscount",
      message: "Update",
    })

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/createDiscount", async (req, res) => {
  const { key, sale, currency, expiryDate } = req.body;

  if (!key || !sale || !currency || !expiryDate) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const collections = db.collection("discounts");

    const discountExist = await collections.findOne({ key });
    if (discountExist) {
      return res.status(400).json({ error: "Discount code already exists" });
    }

    await collections.insertOne({ key, sale, currency, expiryDate });

    res.status(201).json({ message: "Discount created" });

    broadcast({
      type: "updateDiscount",
      message: "Update",
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/discounts", async (req, res) => {
  const { discount } = req.body;

  try {
    const collections = db.collection("discounts");

    const discountDoc = await collections.findOne({ key: discount });
    if (!discountDoc) {
      return res.status(400).json({ error: "Invalid discount code" });
    }
    res.status(200).json({ message: "Discount applied", discount: discountDoc });

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

router.get("/years", haltOnTimedout, async (req, res) => {
  let collections = db.collection("years")
  let result = await collections.find({}).toArray();
  res.json(result);
});

router.patch("/checkout", async (req, res) => {
  const { year, month, day, category, time, ...updateData } = req.body;
  try {
    const result = await db.collection("bookings").updateOne(
      { timeSlotId: `${year}-${month}-${day}-${category.trim()}-${time}` },
      { $set: updateData }
    );
    res.json(result);
    broadcast({ type: "timeUpdate", message: "Update" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/changeTime", async (req, res) => {
  const { year, month, day, category, oldTime, newTime } = req.body;

  try {
    const collections = db.collection("bookings");

    // Check if the old time slot exists
    const oldTimeSlot = await collections.findOne({
      timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`
    });

    if (!oldTimeSlot) {
      return res.status(404).json({ error: "Time slot not found" });
    }

    // Check if the new time slot already exists
    const newTimeSlot = await collections.findOne({
      timeSlotId: `${year}-${month}-${day}-${category}-${newTime}`
    });

    if (newTimeSlot) {
      return res.status(400).json({ error: "New time slot already exists" });
    }

    // Update the time slot
    const result = await collections.updateOne(
      { timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}` },
      {
        $set: {
          time: newTime,
          timeSlotId: `${year}-${month}-${day}-${category}-${newTime}`
        }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(400).json({ error: "Time slot could not be updated" });
    }

    // Broadcast update via WebSocket
    broadcast({
      type: "timeUpdate",
      data: { year, month, day, category, oldTime, newTime }
    });

    res.json({
      message: "Time updated successfully",
      oldTimeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`,
      newTimeSlotId: `${year}-${month}-${day}-${category}-${newTime}`,
      result
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating time" });
  }
});

router.patch("/bulkChangeTime", async (req, res) => {
  const { updates } = req.body;

  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: "Invalid updates format" });
  }

  try {
    const collections = db.collection("bookings");
    const results = [];

    for (const update of updates) {
      const { year, month, day, category, oldTime, newTime } = update;

      // First check if the old time slot exists
      const oldTimeSlot = await collections.findOne({
        timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`
      });

      if (!oldTimeSlot) {
        results.push({
          timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`,
          success: false,
          error: "Original time slot not found"
        });
        continue;
      }

      // Check if the new time slot already exists
      const newTimeSlot = await collections.findOne({
        timeSlotId: `${year}-${month}-${day}-${category}-${newTime}`
      });

      if (newTimeSlot) {
        results.push({
          timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`,
          success: false,
          error: "New time slot already exists"
        });
        continue;
      }

      // Update the time slot
      const result = await collections.updateOne(
        { timeSlotId: `${year}-${month}-${day}-${category}-${oldTime}` },
        {
          $set: {
            time: newTime,
            timeSlotId: `${year}-${month}-${day}-${category}-${newTime}`
          }
        }
      );

      results.push({
        oldTimeSlotId: `${year}-${month}-${day}-${category}-${oldTime}`,
        newTimeSlotId: `${year}-${month}-${day}-${category}-${newTime}`,
        success: result.modifiedCount > 0
      });
    }

    // Broadcast updates via WebSocket
    broadcast({
      type: "bulkTimeUpdate",
      data: updates
    });

    res.json({
      message: "Bulk time update completed",
      results,
      modifiedCount: results.filter(r => r.success).length
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating times" });
  }
});

router.patch("/singleRoomDiscount", async (req, res) => {
  const { year, month, category, time, discount } = req.body;

  if (!year || !month || !category || !time || discount === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const collections = db.collection("bookings");
    const results = [];

    // Update all matching time slots
    const result = await collections.updateMany(
      {
        year: parseInt(year),
        month: month,
        category: category,
        time: time,
        available: true // Only update if available is true
      },
      {
        $set: {
          discount: discount
        }
      }
    );

    // Broadcast the update via WebSocket
    broadcast({
      type: "singleDiscountUpdate",
      data: { year, month, category, time, discount }
    });

    res.json({
      message: "Single time discount update completed",
      modifiedCount: result.modifiedCount,
      timeSlotPattern: `${year}-${month}-*-${category}-${time}`
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating discount" });
  }
});

// Get all bookings for a specific day
router.get("/bookings/:year/:month/:day", async (req, res) => {
  const { year, month, day } = req.params;
  try {
    const bookings = await db.collection("bookings").find({
      year: parseInt(year),
      month: month,
      day: parseInt(day)
    }).toArray();
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/swish/callback", async (req, res) => {
  try {
    const { 
      id,
      payeePaymentReference,
      paymentReference,
      status,
      amount,
      datePaid,
      message,
      payerAlias
    } = req.body;

    console.log('Swish callback received:', req.body);

    if (status === 'PAID') {
      try {
        const collections = db.collection("bookings");
        
        // Parse message format: "SUBMARINE 26/February 21:30"
        const mainBookingMatch = message.match(/([A-Z\s]+)\s+(\d+)\/(\w+)\s+(\d{2}:\d{2})/);
        
        if (mainBookingMatch) {
          const [_, category, day, month, time] = mainBookingMatch;
          const year = new Date().getFullYear(); // Current year
          
          console.log('Parsed booking details:', {
            category: category.trim(),
            day,
            month,
            time,
            year
          });

          // Update the booking in database
          const result = await collections.updateOne(
            { 
              timeSlotId: `${year}-${month}-${day}-${category.trim()}-${time}`
            },
            {
              $set: {
                available: false,
                payed: "Swish",
                paymentId: id,
                number: payerAlias,
                cost: parseInt(amount),
                bookedBy: 'Pending'
              }
            }
          );

          try {
            await axios.post('http://localhost:5173/payment-confirmation', {
              status: 'success',
              paymentId: id,
              timeSlot: {
                category: category.trim(),
                day,
                month,
                time,
                year
              }
            });
          } catch (fetchError) {
            console.error('Error sending confirmation to client:', fetchError);
          }

          console.log('Database update result:', result);

        } else {
          console.error('Failed to parse message:', message);
        }
      } catch (dbError) {
        console.error('Error updating booking:', dbError, {
          message,
          parseResult: message.match(/([A-Z\s]+)\s+(\d+)\/(\w+)\s+(\d{2}:\d{2})/)
        });
      }
    }

    // Always return 200 OK to Swish
    res.status(200).json({ 
      message: 'Callback received',
      receivedData: req.body
    });

  } catch (error) {
    console.error('Swish callback error:', error);
    res.status(200).json({ 
      error: 'Callback processing error',
      errorDetails: error.message
    });
  }
});

router.post('/swish/payment/:instructionUUID', async (req, res) => {
  try {
    const { instructionUUID } = req.params;
    const { payerAlias, amount, message, isMobile } = req.body;

    // Load certificates
    const cert = fs.readFileSync(join(__dirname, '../ssl/myCertificate.pem'), 'utf8');
    const key = fs.readFileSync(join(__dirname, '../ssl/PrivateKey.key'), 'utf8');
    const ca = fs.readFileSync(join(__dirname, '../ssl/Swish_TLS_RootCA.pem'), 'utf8');

    const httpsAgent = new https.Agent({
      cert,
      key,
      ca,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false
    });

    // Set payerAlias only if it's not a mobile payment
    

    const client = axios.create({ httpsAgent });

    // Base payment data
    let paymentData = {
      payeePaymentReference: instructionUUID,
      callbackUrl: 'https://mintbackend-0066444807ba.herokuapp.com/swish/callback',
      payeeAlias: '1230606301',
      amount: amount,
      currency: 'SEK',
      message: message,
      payerAlias: undefined
    };

    if (!isMobile && payerAlias) {
      paymentData.payerAlias = payerAlias;
    }

    console.log('Making Swish request:', {
      type: isMobile ? 'Mobile payment' : 'QR code payment',
      paymentData
    });

    const response = await client.put(
      `https://staging.getswish.pub.tds.tieto.com/swish-cpcapi/api/v2/paymentrequests/${instructionUUID}`,
      paymentData,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: false
      }
    );

    // Add detailed logging for 422 errors
    if (response.status === 422) {
      console.log('Validation Error Details:', {
        status: response.status,
        data: response.data,
        requestData: paymentData,
        headers: response.headers,
        errorCode: response.data?.errorCode,
        errorMessage: response.data?.errorMessage
      });
    }

    // For QR code payments, make an additional request to get payment status
    if (!isMobile && response.status === 201) {
      try {
        const statusResponse = await client.post(
          `https://staging.getswish.pub.tds.tieto.com/qrg-swish/api/v1/commerce`,
          {
            token: response.headers.location,
            format: "svg",
            transparent: true,
          },
          {
            headers: {
              'Content-Type': 'application/json'
            },
            validateStatus: false
          }
        );

        return res.status(response.status).json({
          status: response.status,
          paymentRequestToken: response.headers.location,
          instructionUUID,
          paymentType: 'qr',
          paymentStatus: statusResponse.data
        });
      } catch (statusError) {
        console.error('Error fetching payment status:', statusError);
      }
    }

    // For mobile payments or if status fetch fails
    res.status(response.status).json({
      status: response.status,
      paymentRequestToken: response.headers.location,
      instructionUUID,
      paymentType: isMobile ? 'mobile' : 'qr'
    });

  } catch (error) {
    console.error('Error processing Swish payment:', {
      message: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({
      error: 'Payment processing error',
      message: error.message,
      code: error.code,
      details: error.response?.data
    });
  }
});

router.get("/search/bookings", async (req, res) => {
  const { searchTerm } = req.query;

  if (!searchTerm) {
    return res.status(400).json({ error: "Search term is required" });
  }

  try {
    const collections = db.collection("bookings");

    // Create case-insensitive search with index
    const result = await collections.find({
      bookedBy: {
        $regex: searchTerm,
        $options: 'i' // case-insensitive
      },
      available: false // Only search booked slots
    })
      .project({
        year: 1,
        month: 1,
        day: 1,
        time: 1,
        category: 1,
        bookedBy: 1,
        email: 1,
        number: 1,
        timeSlotId: 1,
        _id: 1
      })
      .sort({ year: 1, month: 1, day: 1, time: 1 })
      .limit(20)
      .toArray();

    res.json({
      results: result,
      count: result.length
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: "Error performing search" });
  }
});

router.get("/stats/monthly-players/:year/:month", async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    const month = req.params.month;
    const collections = db.collection("bookings");
    
    // Define all possible categories
    const allCategories = [
      "SCHOOL OF MAGIC",
      "HAUNTED HOTEL",
      "ARK RAIDER",
      "SUBMARINE",
      "JURRASIC EXPERIMENT"
    ];

    // Aggregate pipeline for specific month's data
    const monthlyStats = await collections.aggregate([
      {
        $match: {
          year: year,
          month: month,
          available: false, // Only count booked slots
          cost: { $gt: 0 }  // Only include bookings with cost
        }
      },
      {
        $group: {
          _id: {
            category: "$category",
            time: "$time"
          },
          totalPlayers: { $sum: "$players" },
          totalBookings: { $sum: 1 },
          totalRevenue: { $sum: "$cost" }, // Add revenue calculation
          avgPerDay: { 
            $avg: "$players" 
          }
        }
      },
      {
        $group: {
          _id: null,
          categories: {
            $push: {
              category: "$_id.category",
              time: "$_id.time",
              totalPlayers: "$totalPlayers",
              totalBookings: "$totalBookings",
              totalRevenue: "$totalRevenue", // Include revenue per category
              averagePlayersPerBooking: {
                $round: [{ $divide: ["$totalPlayers", "$totalBookings"] }, 1]
              }
            }
          },
          monthTotal: { $sum: "$totalPlayers" },
          monthBookings: { $sum: "$totalBookings" },
          monthRevenue: { $sum: "$totalRevenue" } // Total revenue for month
        }
      },
      {
        $project: {
          _id: 0,
          year: year,
          month: month,
          totalPlayers: "$monthTotal",
          totalBookings: "$monthBookings",
          totalRevenue: "$monthRevenue", // Include in final projection
          averagePlayersPerBooking: {
            $round: [{ $divide: ["$monthTotal", "$monthBookings"] }, 1]
          },
          categories: 1
        }
      }
    ]).toArray();

    // Get the base stats or create empty object
    let stats = monthlyStats[0] || {
      year,
      month,
      totalPlayers: 0,
      totalBookings: 0,
      totalRevenue: 0,
      averagePlayersPerBooking: 0,
      categories: []
    };

    // Ensure all categories are represented
    const categoryStats = new Map(stats.categories.map(c => [c.category, c]));
    
    stats.categories = allCategories.map(category => 
      categoryStats.get(category) || {
        category,
        time: null,
        totalPlayers: 0,
        totalBookings: 0,
        totalRevenue: 0,
        averagePlayersPerBooking: 0
      }
    );

    res.json(stats);

  } catch (error) {
    console.error('Error calculating monthly stats:', error);
    res.status(500).json({ error: "Error calculating monthly statistics" });
  }
});

router.get("/stats/daily-revenue/:year/:month", async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    const month = req.params.month;
    const collections = db.collection("bookings");

    // Aggregate pipeline for daily revenue
    const dailyStats = await collections.aggregate([
      {
        $match: {
          year: year,
          month: month,
          available: false, // Only count booked slots
          cost: { $gt: 0 }  // Only include bookings with cost
        }
      },
      {
        $group: {
          _id: {
            day: "$day"
          },
          totalRevenue: { $sum: "$cost" },
          totalBookings: { $sum: 1 },
          categories: {
            $push: {
              category: "$category",
              time: "$time",
              cost: "$cost",
              players: "$players"
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          day: "$_id.day",
          totalRevenue: 1,
          totalBookings: 1,
          categories: 1
        }
      },
      {
        $sort: { day: 1 }
      }
    ]).toArray();

    // Get days in month
    const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();

    // Create array with all days, fill with zeros for days without bookings
    const allDays = Array.from({ length: daysInMonth }, (_, i) => {
      const existingDay = dailyStats.find(stat => stat.day === i + 1);
      return existingDay || {
        day: i + 1,
        totalRevenue: 0,
        totalBookings: 0,
        categories: []
      };
    });

    res.json({
      year,
      month,
      days: allDays,
      monthlyTotal: allDays.reduce((sum, day) => sum + day.totalRevenue, 0),
      totalBookings: allDays.reduce((sum, day) => sum + day.totalBookings, 0)
    });

  } catch (error) {
    console.error('Error calculating daily revenue:', error);
    res.status(500).json({ error: "Error calculating daily statistics" });
  }
});

// Email confirmation route
router.post('/send-confirmation', async (req, res) => {
    try {
        const { to, subject, bookingDetails } = req.body;

        // Create email HTML content
        const emailHtml = `
              <div style="
                  font-family: Arial, sans-serif;
                  max-width: 600px;
                  margin: 0 auto;
                  padding: 60px 20px 40px 20px;
              ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      text-align: center;
                      margin-bottom: 20px;
                  ">
                      <div style="
                          width: 150px;
                          height: 150px;
                          border-radius: 50%;
                          border: 2px solid rgb(154, 220, 198);
                          display: flex;
                          justify-content: center;
                          align-items: center;
                          margin-bottom: 20px;
                      ">
                          <svg width="100" height="100" viewBox="0 0 24 24" fill="none">
                              <path d="M20 6L9 17L4 12" stroke="rgb(154, 220, 198)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                      </div>
                      <h1 style="color: #333;">Din order är bekräftad</h1>
                  </div>

                  <div style="
                      background-color: rgb(17, 21, 22);
                      border-radius: 15px;
                      overflow: hidden;
                  ">
                      <div style="
                          padding: 30px 10px;
                          border-bottom: 1px solid rgb(29, 29, 29);
                      ">
                          <h2 style="
                              margin: 10px 0 5px 0;
                              color: white;
                          ">Kvitto - Orderbekräftelse</h2>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Bokningsnummer: ${bookingDetails.paymentId}</p>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Bokningsdatum: ${bookingDetails.bookingDate}</p>
                      </div>

                      <div style="
                          padding: 20px 10px;
                          color: rgb(160, 160, 160);
                      ">
                          <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                          <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                      </div>

                      <div style="padding: 5px 10px;">
                          ${bookingDetails.items.map(item => `
                              <div style="
                                  display: flex;
                                  justify-content: space-between;
                                  align-items: center;
                                  margin: 10px 0;
                                  color: white;
                              ">
                                  <div style="display: flex; align-items: center; gap: 10px;">
                                      <div style="
                                          width: 15px;
                                          height: 15px;
                                          border-radius: 50%;
                                          border: 2px solid rgb(154, 220, 198);
                                          display: flex;
                                          justify-content: center;
                                          align-items: center;
                                      ">
                                          <div style="
                                              width: 10px;
                                              height: 10px;
                                              border-radius: 50%;
                                              background-color: rgb(154, 220, 198);
                                          "></div>
                                      </div>
                                      <p style="margin: 0;">
                                          ${item.category} 
                                          <span style="color: rgb(160, 160, 160);">
                                              ${item.date} ${item.time} ${item.players} spelare
                                          </span>
                                      </p>
                                  </div>
                                  <p style="margin: 0;">SEK ${item.cost}</p>
                              </div>
                          `).join('')}
                      </div>

                      <div style="
                          display: flex;
                          justify-content: space-between;
                          padding: 5px 10px;
                          color: white;
                      ">
                          <p>Betalsätt</p>
                          <p>${bookingDetails.paymentMethod}</p>
                      </div>

                      <div style="
                          display: flex;
                          justify-content: space-between;
                          padding: 5px 10px;
                          color: white;
                      ">
                          <p>Skatt</p>
                          <p>SEK ${bookingDetails.tax}</p>
                      </div>

                      <div style="
                          display: flex;
                          justify-content: space-between;
                          padding: 5px 10px;
                          color: white;
                      ">
                          <p>Totalt</p>
                          <p>SEK ${bookingDetails.totalCost}</p>
                      </div>
                  </div>
              </div>
          `;

        // Send email
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: to,
          subject: subject,
          html: emailHtml
      });

        res.status(200).json({ message: 'Confirmation email sent successfully' });
    } catch (error) {
        console.error('Error sending confirmation email:', error);
        res.status(500).json({ error: 'Failed to send confirmation email' });
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