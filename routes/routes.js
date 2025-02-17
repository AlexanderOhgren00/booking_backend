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
      { timeSlotId: `${year}-${month}-${day}-${category}-${time}` },
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
    let collections = db.collection("years");

    // First check if time slot exists
    const existingDoc = await collections.findOne({
      "year": year,
      "months.month": month,
      "months.days.day": day,
      "months.days.categories.name": category,
      "months.days.categories.times.time": oldTime
    });

    if (!existingDoc) {
      return res.status(404).json({ error: "Time slot not found" });
    }

    // Update the time slot
    let result = await collections.updateOne(
      {
        "year": year,
        "months.month": month,
        "months.days.day": day,
        "months.days.categories.name": category,
        "months.days.categories.times.time": oldTime
      },
      {
        $set: {
          "months.$[month].days.$[day].categories.$[category].times.$[time].time": newTime
        }
      },
      {
        arrayFilters: [
          { "month.month": month },
          { "day.day": day },
          { "category.name": category },
          { "time.time": oldTime }
        ]
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

    res.json({ message: "Time updated successfully", result });

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
    const collections = db.collection("years");
    const results = [];

    for (const update of updates) {
      const { year, month, day, category, oldTime, newTime } = update;

      const result = await collections.updateOne(
        {
          "year": year,
          "months.month": month,
          "months.days.day": day,
          "months.days.categories.name": category,
          "months.days.categories.times.time": oldTime
        },
        {
          $set: {
            "months.$[month].days.$[day].categories.$[category].times.$[time].time": newTime
          }
        },
        {
          arrayFilters: [
            { "month.month": month },
            { "day.day": day },
            { "category.name": category },
            { "time.time": oldTime }
          ]
        }
      );

      results.push({
        oldTime,
        newTime,
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
      results
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating times" });
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

router.post("/swish/payment/:instructionUUID", async (req, res) => {

  const instructionUUID = req.params;

  const agent = new https.Agent({
    cert: fs.readFileSync(join(__dirname, '../ssl/public.pem'), { encoding: 'utf8' }),
    key: fs.readFileSync(join(__dirname, '../ssl/private.key'), { encoding: 'utf8' }),
    ca: fs.readFileSync(join(__dirname, '../ssl/Swish_TLS_RootCA.pem'), { encoding: 'utf8' }),
  });

  const paymentRequest = {
    payeeAlias: req.body.payeeAlias,
    amount: req.body.amount,
    currency: req.body.currency,
    callbackUrl: req.body.callbackUrl,
  };

  try {
    const response = await fetch(`https://mss.cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/${instructionUUID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentRequest),
      agent: agent
    });

    if (response.status === 201) {
      broadcast({
        type: 'swishPayment',
        status: 'created',
        paymentId: response.headers.get('location')
      });

      res.status(201).json({
        success: true,
        paymentId: response.headers.get('location'),
        paymentRequest: paymentRequest
      });
    } else {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Payment initialization failed');
    }

  } catch (error) {
    console.error('Swish payment error:', error);
    res.status(500).json({ 
      error: "Payment initialization failed",
      details: error.message
    });
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