import express from "express";
import { ObjectId } from "mongodb";
import db from "../db/connections.js";
import rateLimit from 'express-rate-limit';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { wss, WebSocket } from "../checkout.js";
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

// GA4 Tracking Function
async function trackBookingCompleted() {
  try {
    const measurementId = process.env.GA4_MEASUREMENT_ID; // e.g., 'G-XXXXXXXXXX'
    const apiSecret = process.env.GA4_API_SECRET; // From GA4 > Admin > Data Streams > Measurement Protocol API secrets
    
    if (!measurementId || !apiSecret) {
      console.log('GA4 tracking not configured - skipping');
      return;
    }

    const clientId = `${Date.now()}.${Math.random()}`; // Generate unique client ID
    
    const eventData = {
      client_id: clientId,
      events: [{
        name: 'bokning_avslutad'
      }]
    };

    const response = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventData)
      }
    );

    if (response.ok) {
      console.log(`✅ GA4 bokning_avslutad event sent successfully`);
    } else {
      console.error(`❌ GA4 tracking failed:`, response.status, await response.text());
    }
  } catch (error) {
    console.error('Error sending GA4 tracking:', error);
  }
}

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  host: "mailcluster.loopia.se",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

function haltOnTimedout(req, res, next) {
  if (!req.timedout) next()
}

async function broadcast(data) {
  // Immediate WebSocket broadcast - never block critical flows
  try {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  } catch (error) {
    console.error("Failed to broadcast notification to WebSocket clients:", error);
  }
  
  // Database save in background - don't await this in critical flows
  if (data.type && data.type !== 'progress') {
    setImmediate(async () => {
      try {
        const notificationCollection = db.collection("notifications");
        const notification = {
          ...data,
          timestamp: new Date(),
          readBy: [] // Empty array - no one has read it yet
        };
        await notificationCollection.insertOne(notification);
      } catch (error) {
        console.error("Failed to save notification to database:", error);
        // Database failure doesn't affect real-time notifications
      }
    });
  }
}

async function cleanUpPaymentStates() {
  const currentDate = new Date();
  console.log("===== Starting cleanUpPaymentStates =====");
  console.log("Current paymentStates:", Object.keys(paymentStates).length > 0 ? Object.keys(paymentStates) : "No payment states");
  const collections = db.collection("bookings");

  for (const paymentId in paymentStates) {
    const paymentDate = new Date(paymentStates[paymentId].date);
    const timeDifference = (currentDate - paymentDate) / 1000 / 60;

    console.log(`Checking payment ${paymentId}, age: ${timeDifference.toFixed(2)} minutes`);

    if (timeDifference > 30) {
      console.log(`Payment ${paymentId} expired (${timeDifference.toFixed(2)} minutes old)`);

      for (const item of paymentStates[paymentId].data) {
        // Create timeSlotId from booking data
        const timeSlotId = `${item.year}-${item.month}-${item.day}-${item.category}-${item.time}`;

        console.log(`Processing timeSlotId: ${timeSlotId} for reset`);

        try {
          // First, retrieve the current booking to preserve its discount value
          console.log(`Retrieving current booking for timeSlotId: ${timeSlotId}`);
          const currentBooking = await collections.findOne({
            timeSlotId: timeSlotId,
            available: "occupied"
          });

          let originalDiscount = 0; // Default discount value
          if (currentBooking && currentBooking.discount !== undefined) {
            originalDiscount = currentBooking.discount;
            console.log(`Found original discount value: ${originalDiscount} for timeSlotId: ${timeSlotId}`);
          } else {
            console.log(`No original discount found for timeSlotId: ${timeSlotId}, using default: 0`);
          }

          // Update the booking directly using timeSlotId
          console.log(`Attempting to reset booking with timeSlotId: ${timeSlotId}`);
          console.log(`Query conditions: { timeSlotId: "${timeSlotId}", available: "occupied" }`);

          const updateResult = await collections.updateOne(
            {
              timeSlotId: timeSlotId,
              available: "occupied"
            },
            {
              $set: {
                available: true,
                players: 0,
                payed: null,
                cost: 0,
                bookedBy: null,
                number: null,
                email: null,
                info: null,
                discount: originalDiscount,
                bookingRef: null,
                updatedAt: new Date()
              }
            }
          );

          console.log(`Update result details for ${timeSlotId}:`);
          console.log(`- matchedCount: ${updateResult.matchedCount}`);
          console.log(`- modifiedCount: ${updateResult.modifiedCount}`);
          console.log(`- upsertedCount: ${updateResult.upsertedCount}`);
          console.log(`- acknowledged: ${updateResult.acknowledged}`);

          if (updateResult.matchedCount === 0) {
            console.log(`⚠️ No matching booking found for timeSlotId: ${timeSlotId}`);
            // Try an alternative query to check if the booking exists in a different state
            const bookingCheck = await collections.findOne({ timeSlotId: timeSlotId });
            if (bookingCheck) {
              console.log(`Found booking with different state: available=${bookingCheck.available}`);
            } else {
              console.log(`No booking found with timeSlotId: ${timeSlotId} at all`);
            }
          } else if (updateResult.modifiedCount === 0) {
            console.log(`⚠️ Booking found but not modified for timeSlotId: ${timeSlotId}`);
          } else {
            console.log(`✅ Successfully reset booking for timeSlotId: ${timeSlotId}`);
            try {
              console.log(`Attempting to terminate payment ${paymentId} on payment provider`);
              const response = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/terminate`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": key,
                },
              });
      
              if (response.ok) {
                console.log(`✅ Payment ${paymentId} terminated successfully on payment provider`);
              } else {
                console.error(`❌ Failed to terminate payment ${paymentId} on provider:`, await response.text());
              }
            } catch (error) {
              console.error(`❌ Error terminating payment ${paymentId}:`, error);
            }
          }
        } catch (updateError) {
          console.error(`❌ Error processing booking reset for ${timeSlotId}:`, updateError);
          console.error(`Error stack:`, updateError.stack);
        }
      }
      // Remove from paymentStates
      console.log(`Removing payment ${paymentId} from paymentStates`);
      delete paymentStates[paymentId];
      console.log(`✅ Removed payment ${paymentId} from paymentStates`);
      console.log(`Current paymentStates after removal:`, Object.keys(paymentStates).length > 0 ? Object.keys(paymentStates) : "No payment states");

      // Broadcast update to all clients
      await broadcast({
        type: "timeUpdate",
        message: "Expired payment slots reset"
      });
      console.log(`Broadcasted update for reset slots`);
    }
  }
  console.log("===== Finished cleanUpPaymentStates =====");
}

setInterval(cleanUpPaymentStates, 300 * 1000);

router.post("/checkPaymentStates", async (req, res) => {
  try {
    const { timeSlotId } = req.body;

    if (!timeSlotId) {
      return res.status(400).json({ error: "timeSlotId is required" });
    }

    console.log(`Checking payment status for timeSlotId: ${timeSlotId}`);

    // First, look up the booking in the bookings collection to get its paymentId
    const collections = db.collection("bookings");
    const booking = await collections.findOne({ timeSlotId: timeSlotId });

    if (!booking) {
      console.log(`No booking found for timeSlotId: ${timeSlotId}`);
      return res.json({
        status: "not_found",
        message: "No booking found with this timeSlotId"
      });
    }

    // Check if the booking has a paymentId
    if (!booking.paymentId) {
      console.log(`Booking found for timeSlotId: ${timeSlotId}, but it has no paymentId`);
      return res.json({
        status: "no_payment",
        message: "Booking exists but has no associated payment"
      });
    }

    // Now check if this paymentId is in the paymentStates
    const paymentId = booking.paymentId;
    const paymentState = paymentStates[paymentId];

    if (paymentState) {
      console.log(`Active payment found for timeSlotId: ${timeSlotId}, paymentId: ${paymentId}`);
      return res.json({
        status: "active",
        paymentId: paymentId,
        data: paymentState
      });
    } else {
      console.log(`Payment ${paymentId} not found in paymentStates for timeSlotId: ${timeSlotId}`);
      return res.json({
        status: "inactive",
        paymentId: paymentId,
        message: "Payment exists but is not in pending state"
      });
    }
  } catch (error) {
    console.error(`Error checking payment states:`, error);
    res.status(500).json({
      status: "error",
      message: "Server error while checking payment state",
      error: error.message
    });
  }
});

router.delete("/deleteBackup", async (req, res) => {
  const { timeSlotId } = req.body;
  const collections = db.collection("backup");
  const result = await collections.deleteOne({ timeSlotId });
  res.json({ message: "Backup deleted", result });
});

router.get("/getRecentBookings", async (req, res) => {
  try {
    const { lastDate } = req.query;
    const collections = db.collection("bookings");
    const backup = db.collection("backup");

    // Create query conditions based on lastDate
    const queryCondition = { available: false };
    const backupQueryCondition = { available: "occupied" };

    if (lastDate) {
      console.log(`Fetching bookings before or equal to date: ${lastDate}`);
      queryCondition.bookedAt = { $lte: lastDate };
      backupQueryCondition.backupCreatedAt = { $lte: lastDate };
    }

    // Get recent bookings from the bookings collection
    const recentBookings = await collections.find(queryCondition)
      .sort({ bookedAt: -1 })
      .limit(10)
      .toArray();

    // Get recent bookings from the backup collection
    console.log("Backup query condition:", JSON.stringify(backupQueryCondition, null, 2));

    // First, count total backup entries
    const totalBackups = await backup.countDocuments({});
    console.log(`Total backup entries in collection: ${totalBackups}`);

    // Check if our specific backup exists
    const specificBackup = await backup.findOne({ paymentId: "1bb3f37acc7747efac060e035653d52b" });
    console.log("Specific backup found:", specificBackup ? "YES" : "NO");
    if (specificBackup) {
      console.log("Specific backup backupCreatedAt:", specificBackup.backupCreatedAt);
    }

    // Get all backups first, then sort in JavaScript to handle mixed date formats
    const allBackups = await backup.find(backupQueryCondition).toArray();

    // Sort by actual date values, handling different formats
    const recentBackups = allBackups
      .sort((a, b) => {
        const dateA = new Date(a.backupCreatedAt).getTime() || 0;
        const dateB = new Date(b.backupCreatedAt).getTime() || 0;
        return dateB - dateA; // Sort descending (newest first)
      })
      .slice(0, 10);

    console.log(`Found ${recentBackups.length} backup entries after query`);
    if (recentBackups.length > 0) {
      console.log("Latest backup backupCreatedAt:", recentBackups[0].backupCreatedAt);
      console.log("All backup dates:", recentBackups.map(b => b.backupCreatedAt));
    }

    // Merge both arrays and remove duplicates based on _id
    const merged = [...recentBookings, ...recentBackups];
    const uniqueBookings = merged.filter((booking, index, self) => 
      index === self.findIndex(b => b._id.toString() === booking._id.toString())
    );
    
    const allRecentBookings = uniqueBookings
      .sort((a, b) => {
        // Handle case when date might be missing
        const timeA = a.bookedAt || a.backupCreatedAt ? new Date(a.bookedAt || a.backupCreatedAt).getTime() : 0;
        const timeB = b.bookedAt || b.backupCreatedAt ? new Date(b.bookedAt || b.backupCreatedAt).getTime() : 0;
        return timeB - timeA; // Sort descending (most recent first)
      })
      .slice(0, 10); // Take only the 10 most recent entries

    res.json(allRecentBookings);
  } catch (error) {
    console.error("Error fetching recent bookings:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/bulkBaseCost", async (req, res) => {
  const { baseCost } = req.body;
  const collections = db.collection("bookings");
  const result = await collections.updateMany({}, { $set: { baseCost } });
  res.json({ message: "Base cost updated", result });
});

router.post("/v1/payments", async (req, res) => {
  try {
    const product = req.body;
    console.log(product, "product");
    const response = await fetch("https://api.dibspayment.eu/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
      body: JSON.stringify(product)
    });

    const data = await response.json();
    console.log(data, "data");
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/addbackup", async (req, res) => {
  const { backupData } = req.body;
  const collections = db.collection("backup");

  const currentTime = new Date();
  const swedenTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(currentTime);

  const result = await collections.insertOne({
    backupData,
    backupCreatedAt: swedenTime,
    backupSource: "canceled",
    paymentId: backupData.paymentId
  });
  res.json({ message: "Backup added", result });
});

router.post("/v1/payments/:paymentId/initialize", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const currentDate = new Date();
    const body = req.body
    const { discountApplied } = req.body;

    // Add bookings to backup collection before processing
    try {
      const collections = db.collection("bookings");
      const backupCollection = db.collection("backup");
      const discountCollection = db.collection("discounts");

      console.log(`Creating backup for ${body.combinedData.length} booking items for paymentId: ${paymentId}`);

      for (const item of body.combinedData) {
        // Create timeSlotId from booking data
        const timeSlotId = `${item.year}-${item.month}-${item.day}-${item.category}-${item.time}`;

        console.log(`Looking for booking with timeSlotId: ${timeSlotId}`);

        // Find the booking to backup
        const bookingToBackup = await collections.findOne({
          timeSlotId: timeSlotId
        });

        if (bookingToBackup) {
          // Add timestamp and source info to the backup
          // Create a reliable Swedish timezone timestamp
          const currentTime = new Date();
          const swedenTime = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Stockholm',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).format(currentTime);

          await backupCollection.insertOne({
            ...bookingToBackup,
            backupCreatedAt: swedenTime,
            backupSource: "paymentInitialize",
            paymentId: paymentId
          });
          console.log(`✅ Backup created for timeSlotId: ${timeSlotId}`);
        } else {
          console.log(`⚠️ No booking found for timeSlotId: ${timeSlotId}`);
        }
      }
    } catch (backupError) {
      console.error(`❌ Error creating backup for paymentId ${paymentId}:`, backupError);
      // Continue processing even if backup fails
    }

    // Update discount usage if discountApplied is provided
    if (discountApplied && body.combinedData && body.combinedData.length > 0) {
      try {
        if (paymentId) {
          console.log(`Updating discount ${discountApplied} with usedBy: ${paymentId}`);
          
          const discountUpdateResult = await discountCollection.updateOne(
            { key: discountApplied },
            { $set: { usedBy: paymentId } }
          );
          
          if (discountUpdateResult.matchedCount > 0) {
            console.log(`✅ Successfully updated discount ${discountApplied} with payment ID ${paymentId}`);
          } else {
            console.log(`⚠️ No discount found with key: ${discountApplied}`);
          }
        } else {
          console.log(`⚠️ No paymentId available`);
        }
      } catch (discountError) {
        console.error(`❌ Error updating discount usage:`, discountError);
        // Continue processing even if discount update fails
      }
    }

    // Ensure paymentId is saved on the affected bookings so the webhook can update them later
    try {
      const bookingCollection = db.collection("bookings");
      const slotIds = body.combinedData.map(item =>
        `${item.year}-${item.month}-${item.day}-${item.category}-${item.time}`
      );
      console.log(slotIds, "slotIds");
      const updateResult = await bookingCollection.updateMany(
        { timeSlotId: { $in: slotIds } },
        { $set: { paymentId } }
      );

      console.log(`✅ Associated paymentId ${paymentId} with ${updateResult.modifiedCount} booking(s)`);
    } catch (associateError) {
      console.error(`❌ Error associating paymentId with bookings:`, associateError);
    }

    for (const existingPaymentId in paymentStates) {
      const existingData = paymentStates[existingPaymentId].data;
      console.log(existingData, "existingData");
      const hasConflict = body.combinedData.some(newItem =>
        existingData.some(existingItem =>
          existingItem.year === newItem.year &&
          existingItem.month === newItem.month &&
          existingItem.day === newItem.day &&
          existingItem.category === newItem.category &&
          existingItem.time.time === newItem.time.time
        )
      );
      console.log(hasConflict, "hasConflict");
      if (hasConflict) {
        delete paymentStates[existingPaymentId];
        console.log(`Removed conflicting payment state: ${existingPaymentId}`);
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

        const client = axios.create({ httpsAgent });
        try {
          console.log("Cancelling payment", existingPaymentId);
          const cancelResponse = await client.patch(
            `https://cpc.getswish.net/swish-cpcapi/api/v1/paymentrequests/${existingPaymentId}`,
            [{
              "op": "replace",
              "path": "/status",
              "value": "cancelled"
            }],
            {
              headers: {
                "Content-Type": "application/json-patch+json"
              }
            }
          );
          console.log(`Payment ${existingPaymentId} cancelled with status: ${cancelResponse.status}`);
        } catch (error) {
          console.error(`Error cancelling payment ${existingPaymentId}:`, error.message);
        }
      }
    }

    paymentStates[paymentId] = { date: currentDate, data: body.combinedData };
    console.log("Payment states:", paymentStates);

    res.status(200).json({ message: "Payment initialized", paymentId, date: currentDate });
    
    // Create combined booking details for single notification
    const bookingsCount = body.combinedData.length;
    
    // Different message format based on count
    let message;
    if (bookingsCount === 1) {
      const booking = body.combinedData[0];
      message = `${booking.year}-${booking.month}-${booking.day} ${booking.category} ${booking.time}`;
    } else {
      message = `${bookingsCount} bokningar`;
    }
    
    const timeSlotIds = body.combinedData.map(booking => 
      `${booking.year}-${booking.month}-${booking.day}-${booking.category}-${booking.time}`
    );
    
    // Single broadcast for all initialized bookings
    broadcast({ 
      type: "bookingInitialized", 
      title: "Boking påbörjad",
      message: message,
      bookingsCount: bookingsCount,
      bookings: body.combinedData.map(booking => ({
        year: booking.year,
        month: booking.month,
        day: booking.day,
        category: booking.category,
        time: booking.time,
        timeSlotId: `${booking.year}-${booking.month}-${booking.day}-${booking.category}-${booking.time}`
      })),
      timeSlotIds: timeSlotIds,
      paymentId: paymentId
    }); // Fire-and-forget - don't block payment initialization

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/send-paylink", async (req, res) => {
  try {

    const { order, email } = req.body;
    console.log(order, "order");

    // Create payment request
    const paymentResponse = await fetch("https://api.dibspayment.eu/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key,
      },
      body: JSON.stringify(order)
    });

    const paymentData = await paymentResponse.json();
    console.log(paymentData, "paymendDATA :DDDD");

    if (!paymentData.paymentId) {
      throw new Error("Failed to create payment");
    }

    // Send email with payment link
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Your Payment Link",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Payment Link for Your Booking</h2>
          <p>Click the link below to complete your payment:</p>
          <a href="${paymentData.hostedPaymentPageUrl}" 
             style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; 
                    text-decoration: none; border-radius: 5px; margin: 20px 0;">
            Complete Payment
          </a>
          <p>This payment link will expire in 24 hours.</p>
          <p>If you have any questions, please contact us.</p>
        </div>
      `
    });

    res.json({
      success: true,
      message: "Payment link sent successfully",
      paymentId: paymentData.paymentId,
      hostedPaymentPageUrl: paymentData.hostedPaymentPageUrl
    });

  } catch (error) {
    console.error("Error sending payment link:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to send payment link"
    });
  }
});

  router.post("/eventCreated", async (req, res) => {
    try {
      const event = req.body;

      // Log the event for debugging purposes
      console.log("Webhook event received:", event);

      // Process the event based on the event type
      switch (event.event) {
        case "payment.checkout.completed":
          // Handle payment created event
          console.log("Payment created event:", event.data);

          // Extract order details
          const orderData = event.data.order;
          const paymentId = event.data.paymentId;

          // Log the order details
          console.log("Order details:", {
            amount: orderData.amount.amount,
            reference: orderData.reference,
            orderItems: orderData.orderItems
          });

          console.log("PAYMENT ID:", paymentId);
          const amount = orderData.amount.amount;

          // Charge the payment
          const chargeResponse = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/charges`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": key,
            },
            body: JSON.stringify(
              {
                amount: amount,
              }
            )
          });

          const chargeData = await chargeResponse.json();
          console.log("Charge response:", chargeData);

          // Update all bookings with this paymentId in database
          const collections = db.collection("bookings");

          const bookings = await collections.find({ paymentId: paymentId }).toArray();
          const originalTotalCost = bookings.reduce((sum, b) => sum + (b.cost || 0), 0);
          const amountPaid = orderData.amount.amount / 100;   // SEK
          const giftCardUsed = originalTotalCost - amountPaid;
          await handleGiftCardUpdate(bookings, giftCardUsed);

          // Create a reliable Swedish timezone timestamp
          const currentTime = new Date();
          const swedenTime = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Stockholm',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).format(currentTime);

          const result = await collections.updateMany(
            { paymentId: paymentId },
            {
              $set: {
                available: false,
                payed: "Nets Easy",
                updatedAt: new Date(),
                bookedAt: swedenTime
              }
            }
          );

          console.log("Booking update result:", {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount
          });

          // Send GA4 tracking for completed booking
          if (result.modifiedCount > 0) {
            await trackBookingCompleted();
          }

          // Broadcast new booking notification (non-blocking)
          if (result.modifiedCount > 0 && bookings.length > 0) {
            const bookingsCount = bookings.length;
            
            // Different message format based on count
            let message;
            if (bookingsCount === 1) {
              const booking = bookings[0];
              message = `${booking.year}-${booking.month}-${booking.day} ${booking.category} ${booking.time}`;
            } else {
              message = `${bookingsCount} bokningar`;
            }
            
            broadcast({
              type: "bookingInitialized", 
              title: "Bokning slutförd",
              message: message,
              bookingsCount: bookingsCount,
              bookings: bookings.map(booking => ({
                year: booking.year,
                month: booking.month,
                day: booking.day,
                category: booking.category,
                time: booking.time,
                timeSlotId: booking.timeSlotId
              })),
              timeSlotIds: bookings.map(booking => booking.timeSlotId),
              paymentId: paymentId,
              paymentMethod: "Nets Easy"
            });
          }

          // Delete backup entries by timeSlotId for each booking
          try {
            const backupCollection = db.collection("backup");
            let totalDeleted = 0;
            for (const booking of bookings) {
              if (booking.timeSlotId) {
                const backupResult = await backupCollection.deleteMany({ timeSlotId: booking.timeSlotId });
                totalDeleted += backupResult.deletedCount;
                console.log(`✅ Deleted ${backupResult.deletedCount} backup entries for timeSlotId: ${booking.timeSlotId}`);
              }
            }
            console.log(`✅ Total deleted backup entries: ${totalDeleted}`);
          } catch (backupError) {
            console.error(`❌ Error deleting backup entries:`, backupError);
            // Continue processing even if backup deletion fails
          }

          // Delete discount usage after successful payment
          try {
            const discountCollection = db.collection("discounts");
            const discountDeleteResult = await discountCollection.deleteOne({ usedBy: paymentId });
            if (discountDeleteResult.deletedCount > 0) {
              console.log(`✅ Deleted discount with usedBy: ${paymentId}`);
            }
          } catch (discountError) {
            console.error(`❌ Error deleting discount for payment ${paymentId}:`, discountError);
          }

          try {
            const bookings = await collections.find({ paymentId: paymentId }).toArray();

            if (bookings.length > 0 && bookings[0].email) {
              // Prepare booking details for email
              const email = bookings[0].email;
              const bookingRef = bookings[0].bookingRef;
              const bookingDate = new Date().toISOString().split('T')[0];
              const totalCost = bookings.reduce((sum, booking) => sum + (booking.cost || 0), 0);
              const tax = Math.round(totalCost * 0.20);

              // Prepare items for the email
              const items = bookings.map(booking => ({
                category: booking.category,
                date: `${booking.day} ${booking.month} ${booking.year}`,
                time: booking.time,
                players: booking.players,
                cost: booking.cost
              }));

              // Send confirmation email using the exact same template as send-confirmation
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
                              ">Bokningsnummer: ${bookingRef}</p>
                              <p style="
                                  margin: 0;
                                  color: rgb(160, 160, 160);
                              ">Bokningsdatum: ${bookingDate}</p>
                          </div>

                          <div style="
                              padding: 20px 10px;
                              color: rgb(160, 160, 160);
                          ">
                              <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                              <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                          </div>

                          <div style="padding: 5px 10px;">
                              ${items.map(item => `
                                  <div style="
                                      display: flex;
                                      justify-content: space-between;
                                      align-items: center;
                                      margin: 10px 0;
                                      color: white;
                                  ">
                                      <div style="display: flex; align-items: center; gap: 10px;">
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

                          <div style="padding: 0 10px;">
                              <div style="
                                  display: grid;
                                  grid-template-columns: auto auto;
                                  justify-content: space-between;
                                  padding: 15px 0;
                                  color: white;
                                  border-top: 1px solid rgb(29, 29, 29);
                                  gap: 200px;
                              ">
                                  <p style="margin: 0;">Betalsätt</p>
                                  <p style="margin: 0;">Nets Easy</p>
                              </div>

                              <div style="
                                  display: grid;
                                  grid-template-columns: auto auto;
                                  justify-content: space-between;
                                  padding: 15px 0;
                                  color: white;
                                  gap: 200px;
                              ">
                                  <p style="margin: 0;">Moms</p>
                                  <p style="margin: 0;">SEK ${tax}</p>
                              </div>

                              <div style="
                                  display: grid;
                                  grid-template-columns: auto auto;
                                  justify-content: space-between;
                                  padding: 15px 0;
                                  color: white;
                                  border-top: 1px solid rgb(29, 29, 29);
                                  gap: 200px;
                              ">
                                  <p style="margin: 0; font-weight: bold;">Totalt</p>
                                  <p style="margin: 0; font-weight: bold;">SEK ${totalCost}</p>
                              </div>
                          </div>
                      </div>
                  </div>
              `;

              await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email,
                subject: "Bokningsbekräftelse - Din betalning har mottagits",
                html: emailHtml
              });

              console.log(`Confirmation email sent to ${email} for payment ${paymentId}`);
            } else {
              console.log(`No email found for payment ${paymentId} or no bookings associated`);
            }
          } catch (emailError) {
            console.error("Error sending confirmation email:", emailError);
            // Continue processing even if email fails
          }

          if (paymentStates[paymentId]) {
            delete paymentStates[paymentId];
            console.log("Payment terminated from paymentStates:", paymentId);
          }

          break;
        default:
          console.log("Unhandled event type:", event);
      }

      // Respond to the webhook request
      res.status(200).send("Event received");
    } catch (error) {
      console.error("Error processing webhook event:", error);
      res.status(500).json({ error: error.message });
    }
  });

// Add this route to your backend booking routes:

router.post("/verify-booking-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;

    if (!paymentId) {
      console.log("No paymentId provided in verification request");
      return res.status(400).json({ error: "Payment ID is required" });
    }

    console.log(`Verifying payment status for paymentId: ${paymentId}`);

    // Check the database to see if the booking is marked as paid
    const collections = db.collection("bookings");
    const bookings = await collections.find({ paymentId: paymentId }).toArray();

    if (bookings.length === 0) {
      console.log(`No bookings found for paymentId: ${paymentId}`);
      return res.json({
        status: "NOT PAID",
        message: "No bookings found for this payment ID"
      });
    }

    // Check if all bookings with this paymentId are marked as paid
    const allPaid = bookings.every(booking => 
      booking.payed && booking.payed !== false
    );

    if (allPaid) {
      console.log(`All bookings for paymentId ${paymentId} are marked as paid`);
      return res.json({
        status: "PAID",
        paymentMethod: bookings[0].payed,
        bookingCount: bookings.length,
        bookings: bookings.map(booking => ({
          category: booking.category,
          date: `${booking.day} ${booking.month} ${booking.year}`,
          time: booking.time,
          cost: booking.cost,
          bookingRef: booking.bookingRef
        }))
      });
    } else {
      console.log(`Some bookings for paymentId ${paymentId} are not yet marked as paid`);
      return res.json({
        status: "NOT PAID",
        message: "Payment not yet processed",
        bookingCount: bookings.length,
        paidCount: bookings.filter(booking => booking.payed && booking.payed !== false).length
      });
    }

  } catch (error) {
    console.error("Error verifying booking payment:", error);
    return res.status(500).json({ 
      status: "ERROR",
      error: error.message 
    });
  }
}); 

router.get("/v1/payments/:paymentId", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const response = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}`, {
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
    const response = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/refunds`, {
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

router.post("/v1/payments/:paymentId/charges", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    console.log("Payment ID:", paymentId);
    const response = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/charges`, {
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
    const response = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/terminate`, {
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
    // Use case-insensitive search with regex
    const user = await collections.findOne({
      username: { $regex: new RegExp(`^${username}$`, 'i') }
    });

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
  // Get the token from the request body or query parameters
  const token = req.body.token || req.query.token;
  console.log("Token from body:", req.body.token, "Token from query:", req.query.token); // Add this line for debugging
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
    await broadcast({
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
      await broadcast({
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
    await broadcast({
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

// Process offer updates in chunks to avoid timeouts
async function processOfferChunk(updates, offerValue) {
  const collections = db.collection("bookings");
  const currentYear = new Date().getFullYear();
  const years = Array.from(
    { length: 2030 - currentYear + 1 },
    (_, i) => currentYear + i
  );

  // Build bulk operations for efficient processing
  const allBulkOps = [];

  for (const update of updates) {
    const { time, category, weekday, month } = update;
    
    // Pre-calculate matching days for all years to build filter criteria
    const matchingDays = [];
    
    for (const year of years) {
      const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
      
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, MONTHS.indexOf(month), day);
        if (currentDate.getDay() === weekday) {
          matchingDays.push({ year, month, day });
        }
      }
    }

    // Create bulk write operations for this update
    if (matchingDays.length > 0) {
      const bulkOp = {
        updateMany: {
          filter: {
            $or: matchingDays.map(({ year, month, day }) => ({
              year: year,
              month: month,
              day: day,
              category: category,
              time: time,
              available: true
            }))
          },
          update: {
            $set: { offer: offerValue }
          }
        }
      };
      allBulkOps.push(bulkOp);
    }
  }

  // Execute all bulk operations with optimal batch size
  let totalModified = 0;
  const BATCH_SIZE = 20;
  
  for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
    const batch = allBulkOps.slice(i, i + BATCH_SIZE);
    const bulkResult = await collections.bulkWrite(batch, { 
      ordered: false,
      writeConcern: { w: 1, j: false }
    });
    totalModified += bulkResult.modifiedCount;
  }

  return { modifiedCount: totalModified };
}

// Process discount updates in chunks to avoid timeouts
async function processDiscountChunk(updates) {
  const collections = db.collection("bookings");
  const currentYear = new Date().getFullYear();
  const years = Array.from(
    { length: 2030 - currentYear + 1 },
    (_, i) => currentYear + i
  );

  const allBulkOps = [];

  for (const update of updates) {
    const { time, category, discount, weekday, month } = update;
    
    const matchingDays = [];
    for (const year of years) {
      const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
      
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, MONTHS.indexOf(month), day);
        if (currentDate.getDay() === weekday) {
          matchingDays.push({ year, month, day });
        }
      }
    }

    if (matchingDays.length > 0) {
      const bulkOp = {
        updateMany: {
          filter: {
            $or: matchingDays.map(({ year, month, day }) => ({
              year: year,
              month: month,
              day: day,
              category: category,
              time: time,
              available: true
            }))
          },
          update: { $set: { discount: discount } }
        }
      };
      allBulkOps.push(bulkOp);
    }
  }

  // Process with timeout protection
  let totalModified = 0;
  const BATCH_SIZE = 20;
  const startTime = Date.now();
  
  for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
    // Safety check for individual chunk timeout
    if (Date.now() - startTime > 20000) { // 20 seconds per chunk
      console.warn("Chunk timeout reached, stopping");
      break;
    }
    
    const batch = allBulkOps.slice(i, i + BATCH_SIZE);
    const bulkResult = await collections.bulkWrite(batch, { 
      ordered: false,
      writeConcern: { w: 1, j: false }
    });
    
    totalModified += bulkResult.modifiedCount;
  }

  return { modifiedCount: totalModified };
}

// Background processing function for large discount updates
async function processDiscountUpdatesInBackground(updates) {
  console.log("Starting background discount processing...");
  
  try {
    const collections = db.collection("bookings");
    const currentYear = new Date().getFullYear();
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    const allBulkOps = [];

    for (const update of updates) {
      const { time, category, discount, weekday, month } = update;
      
      const matchingDays = [];
      for (const year of years) {
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            matchingDays.push({ year, month, day });
          }
        }
      }

      if (matchingDays.length > 0) {
        const bulkOp = {
          updateMany: {
            filter: {
              $or: matchingDays.map(({ year, month, day }) => ({
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true
              }))
            },
            update: { $set: { discount: discount } }
          }
        };
        allBulkOps.push(bulkOp);
      }
    }

    // Process all operations without timeout constraints
    let totalModified = 0;
    const BATCH_SIZE = 50; // Larger batches for background processing
    
    for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
      const batch = allBulkOps.slice(i, i + BATCH_SIZE);
      const bulkResult = await collections.bulkWrite(batch, { 
        ordered: false,
        writeConcern: { w: 1, j: false }
      });
      
      totalModified += bulkResult.modifiedCount;
      console.log(`Background processing: ${totalModified} bookings updated so far`);
    }

    console.log(`Background discount processing completed. Total modified: ${totalModified}`);
    
    // Broadcast completion
    await broadcast({
      type: "bulkDiscountUpdateComplete",
      data: { totalModified, updates }
    });

  } catch (error) {
    console.error("Background processing error:", error);
    await broadcast({
      type: "bulkDiscountUpdateError",
      data: { error: error.message }
    });
  }
}

// Admin endpoint to create indexes on existing bookings collection
router.post("/admin/createIndexes", async (req, res) => {
  try {
    const collection = db.collection("bookings");
    
    // Create composite indexes for bulk discount operations
    await collection.createIndex({ year: 1, month: 1, day: 1, category: 1, time: 1, available: 1 });
    await collection.createIndex({ category: 1, time: 1, available: 1 });
    await collection.createIndex({ available: 1, category: 1, time: 1 });
    
    res.json({ message: "Indexes created successfully" });
  } catch (error) {
    console.error("Error creating indexes:", error);
    res.status(500).json({ error: error.message });
  }
});

router.patch("/bulkRoomDiscount", async (req, res) => {
  const { updates, bulk } = req.body;

  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: "Updates array is required" });
  }

  try {
    // For very large operations, process in chunks
    const estimatedOperations = updates.length * 6 * 4; // rough estimate
    if (estimatedOperations > 800) {
      // Process in multiple smaller requests to avoid timeout
      const chunkSize = Math.ceil(updates.length / 3); // Split into 3 chunks
      const totalChunks = Math.ceil(updates.length / chunkSize);
      let completedChunks = 0;
      let totalProcessed = 0;
      
      // Process chunks sequentially to avoid race conditions
      const processChunksSequentially = async () => {
        for (let i = 0; i < updates.length; i += chunkSize) {
          const chunk = updates.slice(i, i + chunkSize);
          
          try {
            // Add delay between chunks to avoid overwhelming the system
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const result = await processDiscountChunk(chunk);
            totalProcessed += result.modifiedCount;
            completedChunks++;
            
            // Broadcast progress
            await broadcast({
              type: "bulkDiscountProgress",
              data: { 
                processed: totalProcessed, 
                total: estimatedOperations,
                progress: Math.round((completedChunks / totalChunks) * 100),
                chunk: completedChunks,
                totalChunks: totalChunks
              }
            });
            
            // Broadcast completion when all chunks are done
            if (completedChunks === totalChunks) {
              await broadcast({
                type: "bulkDiscountComplete",
                data: { 
                  totalProcessed: totalProcessed,
                  message: "All discount updates completed successfully"
                }
              });
            }
          } catch (error) {
            console.error("Chunk processing error:", error);
            await broadcast({
              type: "bulkDiscountError",
              data: { 
                error: error.message,
                chunk: completedChunks + 1
              }
            });
          }
        }
      };
      
      // Start processing in background
      processChunksSequentially().catch(console.error);
      
      return res.json({
        message: "Large discount update started in chunks",
        estimatedOperations,
        chunks: totalChunks,
        status: "processing"
      });
    }
    const collections = db.collection("bookings");
    const currentYear = new Date().getFullYear();
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    // Build bulk operations for efficient processing
    const allBulkOps = [];

    for (const update of updates) {
      const { time, category, discount, weekday, month } = update;
      
      // Pre-calculate matching days for all years to build filter criteria
      const matchingDays = [];
      
      for (const year of years) {
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            matchingDays.push({ year, month, day });
          }
        }
      }

      // Create bulk write operations for this update
      if (matchingDays.length > 0) {
        const bulkOp = {
          updateMany: {
            filter: {
              $or: matchingDays.map(({ year, month, day }) => ({
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true
              }))
            },
            update: {
              $set: { discount: discount }
            }
          }
        };
        allBulkOps.push(bulkOp);
      }
    }

    // Execute all bulk operations with timeout protection
    let totalModified = 0;
    const results = [];

    if (allBulkOps.length > 0) {
      // Larger batch size for better performance, with timeout protection
      const BATCH_SIZE = 20;
      const startTime = Date.now();
      
      for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
        // Check if we're approaching the 30-second Heroku timeout
        if (Date.now() - startTime > 25000) { // 25 seconds safety margin
          console.warn("Approaching timeout, stopping batch processing");
          break;
        }
        
        const batch = allBulkOps.slice(i, i + BATCH_SIZE);
        const bulkResult = await collections.bulkWrite(batch, { 
          ordered: false,
          // Add write concern for faster processing
          writeConcern: { w: 1, j: false }
        });
        
        totalModified += bulkResult.modifiedCount;
        results.push({
          batchIndex: Math.floor(i / BATCH_SIZE),
          modifiedCount: bulkResult.modifiedCount,
          upsertedCount: bulkResult.upsertedCount
        });
      }
    }

    // Broadcast the update via WebSocket
    await broadcast({
      type: "bulkDiscountUpdate",
      data: { updates }
    });

    res.json({
      message: "Bulk discount update completed",
      results,
      totalModified,
      operationsProcessed: allBulkOps.length
    });

  } catch (error) {
    console.error("Bulk discount update error:", error);
    res.status(500).json({ error: "Server error while updating discounts" });
  }
});

router.patch("/bulkDiscardDiscount", async (req, res) => {
  const { updates, bulk } = req.body;

  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: "Updates array is required" });
  }

  try {
    // For very large operations, process in chunks
    const estimatedOperations = updates.length * 6 * 4; // rough estimate
    if (estimatedOperations > 800) {
      // Process in multiple smaller requests to avoid timeout
      const chunkSize = Math.ceil(updates.length / 3); // Split into 3 chunks
      const totalChunks = Math.ceil(updates.length / chunkSize);
      let completedChunks = 0;
      let totalProcessed = 0;
      
      // Process chunks sequentially to avoid race conditions
      const processChunksSequentially = async () => {
        for (let i = 0; i < updates.length; i += chunkSize) {
          const chunk = updates.slice(i, i + chunkSize);
          
          try {
            // Add delay between chunks to avoid overwhelming the system
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const result = await processDiscardChunk(chunk);
            totalProcessed += result.modifiedCount;
            completedChunks++;
            
            // Broadcast progress
            await broadcast({
              type: "bulkDiscardProgress",
              data: { 
                processed: totalProcessed, 
                total: estimatedOperations,
                progress: Math.round((completedChunks / totalChunks) * 100),
                chunk: completedChunks,
                totalChunks: totalChunks
              }
            });
            
            // Broadcast completion when all chunks are done
            if (completedChunks === totalChunks) {
              await broadcast({
                type: "bulkDiscardComplete",
                data: { 
                  totalProcessed: totalProcessed,
                  message: "All discount removals completed successfully"
                }
              });
            }
          } catch (error) {
            console.error("Chunk processing error:", error);
            await broadcast({
              type: "bulkDiscardError",
              data: { 
                error: error.message,
                chunk: completedChunks + 1
              }
            });
          }
        }
      };
      
      // Start processing in background
      processChunksSequentially().catch(console.error);
      
      return res.json({
        message: "Large discount removal started in chunks",
        estimatedOperations,
        chunks: totalChunks,
        status: "processing"
      });
    }
    const collections = db.collection("bookings");
    const currentYear = new Date().getFullYear();
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    // Build bulk operations for efficient processing
    const allBulkOps = [];

    for (const update of updates) {
      const { time, category, weekday, month } = update;
      
      // Pre-calculate matching days for all years to build filter criteria
      const matchingDays = [];
      
      for (const year of years) {
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            matchingDays.push({ year, month, day });
          }
        }
      }

      // Create bulk write operations for this update - set discount to 0
      if (matchingDays.length > 0) {
        const bulkOp = {
          updateMany: {
            filter: {
              $or: matchingDays.map(({ year, month, day }) => ({
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true
              }))
            },
            update: {
              $set: { discount: 0 }
            }
          }
        };
        allBulkOps.push(bulkOp);
      }
    }

    // Execute all bulk operations with timeout protection
    let totalModified = 0;
    const results = [];

    if (allBulkOps.length > 0) {
      // Larger batch size for better performance, with timeout protection
      const BATCH_SIZE = 20;
      const startTime = Date.now();
      
      for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
        // Check if we're approaching the 30-second Heroku timeout
        if (Date.now() - startTime > 25000) { // 25 seconds safety margin
          console.warn("Approaching timeout, stopping batch processing");
          break;
        }
        
        const batch = allBulkOps.slice(i, i + BATCH_SIZE);
        const bulkResult = await collections.bulkWrite(batch, { 
          ordered: false,
          // Add write concern for faster processing
          writeConcern: { w: 1, j: false }
        });
        
        totalModified += bulkResult.modifiedCount;
        results.push({
          batchIndex: Math.floor(i / BATCH_SIZE),
          modifiedCount: bulkResult.modifiedCount,
          upsertedCount: bulkResult.upsertedCount
        });
      }
    }

    // Broadcast the update via WebSocket
    await broadcast({
      type: "bulkDiscardUpdate",
      data: { updates }
    });

    res.json({
      message: "Bulk discount removal completed",
      results,
      totalModified,
      operationsProcessed: allBulkOps.length
    });

  } catch (error) {
    console.error("Bulk discount removal error:", error);
    res.status(500).json({ error: "Server error while removing discounts" });
  }
});

// Helper function for processing discard chunks
async function processDiscardChunk(updates) {
  const collections = db.collection("bookings");
  const currentYear = new Date().getFullYear();
  const years = Array.from(
    { length: 2030 - currentYear + 1 },
    (_, i) => currentYear + i
  );

  const allBulkOps = [];

  for (const update of updates) {
    const { time, category, weekday, month } = update;
    
    const matchingDays = [];
    
    for (const year of years) {
      const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
      
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, MONTHS.indexOf(month), day);
        if (currentDate.getDay() === weekday) {
          matchingDays.push({ year, month, day });
        }
      }
    }

    if (matchingDays.length > 0) {
      const bulkOp = {
        updateMany: {
          filter: {
            $or: matchingDays.map(({ year, month, day }) => ({
              year: year,
              month: month,
              day: day,
              category: category,
              time: time,
              available: true
            }))
          },
          update: {
            $set: { discount: 0 }
          }
        }
      };
      allBulkOps.push(bulkOp);
    }
  }

  // Process all operations without timeout constraints
  let totalModified = 0;
  const BATCH_SIZE = 50; // Larger batches for background processing
  
  for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
    const batch = allBulkOps.slice(i, i + BATCH_SIZE);
    const bulkResult = await collections.bulkWrite(batch, { 
      ordered: false,
      writeConcern: { w: 1, j: false }
    });
    
    totalModified += bulkResult.modifiedCount;
    console.log(`Background processing: ${totalModified} bookings updated so far`);
  }

  console.log(`Background discard processing completed. Total modified: ${totalModified}`);
  
  // Broadcast completion
  await broadcast({
    type: "bulkDiscardUpdateComplete",
    data: { totalModified, updates }
  });

  return { modifiedCount: totalModified };
}

// Process time change updates in chunks to avoid timeouts
async function processTimeChangeChunk(updates, minutesToAdd) {
  const collections = db.collection("bookings");
  const currentYear = new Date().getFullYear();
  const years = Array.from(
    { length: 2030 - currentYear + 1 },
    (_, i) => currentYear + i
  );

  // Build bulk operations for efficient processing
  const allBulkOps = [];

  for (const update of updates) {
    const { time, category, weekday, month } = update;
    
    // Parse the original time and calculate new time
    const [hours, minutes] = time.split(':').map(Number);
    const tempDate = new Date(2000, 0, 1, hours, minutes);
    tempDate.setMinutes(tempDate.getMinutes() + parseInt(minutesToAdd));
    const newTime = `${String(tempDate.getHours()).padStart(2, '0')}:${String(tempDate.getMinutes()).padStart(2, '0')}`;
    
    // Pre-calculate matching days for all years to build filter criteria
    const matchingDays = [];
    
    for (const year of years) {
      const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
      
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(year, MONTHS.indexOf(month), day);
        if (currentDate.getDay() === weekday) {
          matchingDays.push({ year, month, day });
        }
      }
    }

    // Create bulk write operations for this update
    if (matchingDays.length > 0) {
      const bulkOp = {
        updateMany: {
          filter: {
            $or: matchingDays.map(({ year, month, day }) => ({
              year: year,
              month: month,
              day: day,
              category: category,
              time: time,
              available: true
            }))
          },
          update: [
            {
              $set: {
                time: newTime,
                timeSlotId: { 
                  $concat: [
                    { $toString: "$year" }, "-", 
                    "$month", "-", 
                    { $toString: "$day" }, "-", 
                    "$category", "-", 
                    newTime
                  ]
                }
              }
            }
          ]
        }
      };
      allBulkOps.push(bulkOp);
    }
  }

  // Process with timeout protection
  let totalModified = 0;
  const BATCH_SIZE = 20;
  const startTime = Date.now();
  
  for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
    // Safety check for individual chunk timeout
    if (Date.now() - startTime > 20000) { // 20 seconds per chunk
      console.warn("Chunk timeout reached, stopping");
      break;
    }
    
    const batch = allBulkOps.slice(i, i + BATCH_SIZE);
    const bulkResult = await collections.bulkWrite(batch, { 
      ordered: false,
      writeConcern: { w: 1, j: false }
    });
    
    totalModified += bulkResult.modifiedCount;
  }

  return { modifiedCount: totalModified };
}

router.patch("/MonthBulkTimeChange", async (req, res) => {
  const { updates, minutesToAdd } = req.body;

  if (!updates || !Array.isArray(updates) || !minutesToAdd) {
    return res.status(400).json({ error: "Updates array and minutesToAdd are required" });
  }

  try {
    // For very large operations, process in chunks
    const estimatedOperations = updates.length * 6 * 4; // rough estimate
    if (estimatedOperations > 800) {
      // Process in multiple smaller requests to avoid timeout
      const chunkSize = Math.ceil(updates.length / 3); // Split into 3 chunks
      const totalChunks = Math.ceil(updates.length / chunkSize);
      let completedChunks = 0;
      let totalProcessed = 0;
      
      // Process chunks sequentially to avoid race conditions
      const processChunksSequentially = async () => {
        for (let i = 0; i < updates.length; i += chunkSize) {
          const chunk = updates.slice(i, i + chunkSize);
          
          try {
            // Add delay between chunks to avoid overwhelming the system
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const result = await processTimeChangeChunk(chunk, minutesToAdd);
            totalProcessed += result.modifiedCount;
            completedChunks++;
            
            // Broadcast progress
            await broadcast({
              type: "bulkTimeChangeProgress",
              data: { 
                processed: totalProcessed, 
                total: estimatedOperations,
                progress: Math.round((completedChunks / totalChunks) * 100),
                chunk: completedChunks,
                totalChunks: totalChunks
              }
            });
            
            // Broadcast completion when all chunks are done
            if (completedChunks === totalChunks) {
              await broadcast({
                type: "bulkTimeChangeComplete",
                data: { 
                  totalProcessed: totalProcessed,
                  message: "All time updates completed successfully"
                }
              });
            }
          } catch (error) {
            console.error("Chunk processing error:", error);
            await broadcast({
              type: "bulkTimeChangeError",
              data: { 
                error: error.message,
                chunk: completedChunks + 1
              }
            });
          }
        }
      };
      
      // Start processing in background
      processChunksSequentially().catch(console.error);
      
      return res.json({
        message: "Large time change update started in chunks",
        estimatedOperations,
        chunks: totalChunks,
        status: "processing",
        modifiedCount: 0  // Frontend compatibility - will be updated via WebSocket
      });
    }
    
    const collections = db.collection("bookings");
    const currentYear = new Date().getFullYear();
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    // Build bulk operations for efficient processing
    const allBulkOps = [];

    for (const update of updates) {
      const { time, category, weekday, month } = update;
      
      // Parse the original time and calculate new time
      const [hours, minutes] = time.split(':').map(Number);
      const tempDate = new Date(2000, 0, 1, hours, minutes);
      tempDate.setMinutes(tempDate.getMinutes() + parseInt(minutesToAdd));
      const newTime = `${String(tempDate.getHours()).padStart(2, '0')}:${String(tempDate.getMinutes()).padStart(2, '0')}`;
      
      // Pre-calculate matching days for all years to build filter criteria
      const matchingDays = [];
      
      for (const year of years) {
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            matchingDays.push({ year, month, day });
          }
        }
      }

      // Create bulk write operations for this update
      if (matchingDays.length > 0) {
        const bulkOp = {
          updateMany: {
            filter: {
              $or: matchingDays.map(({ year, month, day }) => ({
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true
              }))
            },
            update: [
              {
                $set: {
                  time: newTime,
                  timeSlotId: {
                    $concat: [
                      { $toString: "$year" },
                      "-",
                      "$month",
                      "-", 
                      { $toString: "$day" },
                      "-",
                      "$category",
                      "-",
                      newTime
                    ]
                  }
                }
              }
            ]
          }
        };
        allBulkOps.push(bulkOp);
      }
    }

    // Execute all bulk operations with timeout protection
    let totalModified = 0;
    const results = [];

    if (allBulkOps.length > 0) {
      // Larger batch size for better performance, with timeout protection
      const BATCH_SIZE = 20;
      const startTime = Date.now();
      
      for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
        // Check if we're approaching the 30-second Heroku timeout
        if (Date.now() - startTime > 25000) { // 25 seconds safety margin
          console.warn("Approaching timeout, stopping batch processing");
          break;
        }
        
        const batch = allBulkOps.slice(i, i + BATCH_SIZE);
        const bulkResult = await collections.bulkWrite(batch, { 
          ordered: false,
          // Add write concern for faster processing
          writeConcern: { w: 1, j: false }
        });
        
        totalModified += bulkResult.modifiedCount;
        results.push({
          batchIndex: Math.floor(i / BATCH_SIZE),
          modifiedCount: bulkResult.modifiedCount,
          upsertedCount: bulkResult.upsertedCount
        });
      }
    }

    // Broadcast the update via WebSocket
    await broadcast({
      type: "bulkTimeUpdate",
      data: { updates, minutesToAdd }
    });

    res.json({
      message: "Bulk time change completed",
      results,
      modifiedCount: totalModified,  // Frontend compatibility
      totalModified,
      operationsProcessed: allBulkOps.length
    });

  } catch (error) {
    console.error("Bulk time change update error:", error);
    res.status(500).json({ error: "Server error while updating times" });
  }
});

router.patch("/bulk-update-offers", async (req, res) => {
  const { updates, offerValue } = req.body;

  if (!updates || !Array.isArray(updates) || !offerValue) {
    return res.status(400).json({ error: "Updates array and offerValue are required" });
  }

  try {
    // For very large operations, process in chunks
    const estimatedOperations = updates.length * 6 * 4; // rough estimate
    if (estimatedOperations > 800) {
      // Process in multiple smaller requests to avoid timeout
      const chunkSize = Math.ceil(updates.length / 3); // Split into 3 chunks
      const totalChunks = Math.ceil(updates.length / chunkSize);
      let completedChunks = 0;
      let totalProcessed = 0;
      
      // Process chunks sequentially to avoid race conditions
      const processChunksSequentially = async () => {
        for (let i = 0; i < updates.length; i += chunkSize) {
          const chunk = updates.slice(i, i + chunkSize);
          
          try {
            // Add delay between chunks to avoid overwhelming the system
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            const result = await processOfferChunk(chunk, offerValue);
            totalProcessed += result.modifiedCount;
            completedChunks++;
            
            // Broadcast progress
            await broadcast({
              type: "bulkOfferProgress",
              data: { 
                processed: totalProcessed, 
                total: estimatedOperations,
                progress: Math.round((completedChunks / totalChunks) * 100),
                chunk: completedChunks,
                totalChunks: totalChunks
              }
            });
            
            // Broadcast completion when all chunks are done
            if (completedChunks === totalChunks) {
              await broadcast({
                type: "bulkOfferComplete",
                data: { 
                  totalProcessed: totalProcessed,
                  message: "All offer updates completed successfully"
                }
              });
            }
          } catch (error) {
            console.error("Chunk processing error:", error);
            await broadcast({
              type: "bulkOfferError",
              data: { 
                error: error.message,
                chunk: completedChunks + 1
              }
            });
          }
        }
      };
      
      // Start processing in background
      processChunksSequentially().catch(console.error);
      
      return res.json({
        message: "Large offer update started in chunks",
        estimatedOperations,
        chunks: totalChunks,
        status: "processing"
      });
    }

    const collections = db.collection("bookings");
    const currentYear = new Date().getFullYear();
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );

    // Build bulk operations for efficient processing
    const allBulkOps = [];

    for (const update of updates) {
      const { time, category, weekday, month, offerType } = update;
      
      // Pre-calculate matching days for all years to build filter criteria
      const matchingDays = [];
      
      for (const year of years) {
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        
        for (let day = 1; day <= daysInMonth; day++) {
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            matchingDays.push({ year, month, day });
          }
        }
      }

      // Create bulk write operations for this update
      if (matchingDays.length > 0) {
        const bulkOp = {
          updateMany: {
            filter: {
              $or: matchingDays.map(({ year, month, day }) => ({
                year: year,
                month: month,
                day: day,
                category: category,
                time: time,
                available: true
              }))
            },
            update: {
              $set: { offer: offerValue }
            }
          }
        };
        allBulkOps.push(bulkOp);
      }
    }

    // Execute all bulk operations with timeout protection
    let totalModified = 0;
    const results = [];

    if (allBulkOps.length > 0) {
      // Larger batch size for better performance, with timeout protection
      const BATCH_SIZE = 20;
      const startTime = Date.now();
      
      for (let i = 0; i < allBulkOps.length; i += BATCH_SIZE) {
        // Check if we're approaching the 30-second Heroku timeout
        if (Date.now() - startTime > 25000) { // 25 seconds safety margin
          console.warn("Approaching timeout, stopping batch processing");
          break;
        }
        
        const batch = allBulkOps.slice(i, i + BATCH_SIZE);
        const bulkResult = await collections.bulkWrite(batch, { 
          ordered: false,
          // Add write concern for faster processing
          writeConcern: { w: 1, j: false }
        });
        
        totalModified += bulkResult.modifiedCount;
        results.push({
          batchIndex: Math.floor(i / BATCH_SIZE),
          modifiedCount: bulkResult.modifiedCount,
          upsertedCount: bulkResult.upsertedCount
        });
      }
    }

    // Broadcast the update via WebSocket
    await broadcast({
      type: "bulkOfferUpdate",
      data: { updates, offerValue }
    });

    res.json({
      message: "Bulk offer update completed",
      results,
      totalModified,
      operationsProcessed: allBulkOps.length
    });

  } catch (error) {
    console.error("Bulk offer update error:", error);
    res.status(500).json({ error: "Server error while updating offers" });
  }
});

router.delete("/deleteRoomDiscount", async (req, res) => {
  const { key, PersonCost } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Discount key is required" });
  }

  try {
    // Delete from roomDiscounts collection
    const collections = db.collection("roomDiscounts");
    const result = await collections.deleteOne({ key });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Discount not found" });
    }

    // Reset discount to 0 for any bookings with this discount value
    if (PersonCost) {
      console.log(`Starting discount reset process for discount = ${PersonCost}`);

      const bookingsCollection = db.collection("bookings");
      
      // First, count how many bookings will be affected
      const affectedCount = await bookingsCollection.countDocuments({ discount: PersonCost });
      console.log(`Found ${affectedCount} bookings with discount ${PersonCost}`);

      if (affectedCount === 0) {
        console.log("No bookings found with this discount value");
        return res.status(200).json({ 
          message: "Discount deleted successfully", 
          bookingsUpdated: 0 
        });
      }

      // If there are many bookings, use chunked processing
      if (affectedCount > 500) {
        console.log(`Large number of bookings (${affectedCount}). Starting background processing...`);
        
        // Start background processing
        processDiscountDeletionInBackground(PersonCost, affectedCount).catch(error => {
          console.error("Background processing error:", error);
        });

        // Return immediately to avoid timeout
        res.status(200).json({ 
          message: "Discount deleted successfully. Large number of bookings are being updated in background.",
          bookingsUpdated: "processing",
          totalBookingsToUpdate: affectedCount
        });

        await broadcast({
          type: "updateRoomDiscounts",
          message: "Update",
        });

        return;
      }

      // For smaller datasets, process normally with timeout protection
      const startTime = Date.now();
      const BATCH_SIZE = 100;
      let totalUpdated = 0;

      // Process in batches to avoid overwhelming the system
      const affectedBookings = await bookingsCollection.find({ discount: PersonCost }).toArray();
      
      for (let i = 0; i < affectedBookings.length; i += BATCH_SIZE) {
        // Check timeout (25 seconds safety margin)
        if (Date.now() - startTime > 25000) {
          console.warn("Approaching timeout, switching to background processing");
          
          // Process remaining bookings in background
          const remainingBookings = affectedBookings.slice(i);
          processRemainingBookingsInBackground(remainingBookings).catch(error => {
            console.error("Background processing error:", error);
          });
          
          break;
        }

        const batch = affectedBookings.slice(i, i + BATCH_SIZE);
        const batchIds = batch.map(booking => booking._id);
        
        const batchResult = await bookingsCollection.updateMany(
          { _id: { $in: batchIds } },
          { $set: { discount: 0 } },
          { writeConcern: { w: 1, j: false } }
        );

        totalUpdated += batchResult.modifiedCount;
        console.log(`Processed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchResult.modifiedCount} bookings updated`);
      }

      console.log(`Discount deletion completed. Updated ${totalUpdated} bookings.`);
    }

    res.status(200).json({ 
      message: "Discount deleted successfully", 
      bookingsUpdated: PersonCost ? totalUpdated : 0 
    });

    await broadcast({
      type: "updateRoomDiscounts",
      message: "Update",
    });

  } catch (error) {
    console.error("Error in deleteRoomDiscount:", error);
    res.status(500).json({ error: error.message });
  }
});

// Background processing function for large discount deletions
async function processDiscountDeletionInBackground(PersonCost, totalCount) {
  console.log(`Starting background processing for ${totalCount} bookings with discount ${PersonCost}`);
  
  try {
    const bookingsCollection = db.collection("bookings");
    const BATCH_SIZE = 200; // Larger batches for background processing
    let processedCount = 0;

    // Process in batches
    while (processedCount < totalCount) {
      const batch = await bookingsCollection.find({ discount: PersonCost })
        .limit(BATCH_SIZE)
        .toArray();

      if (batch.length === 0) {
        console.log("No more bookings to process");
        break;
      }

      const batchIds = batch.map(booking => booking._id);
      
      const result = await bookingsCollection.updateMany(
        { _id: { $in: batchIds } },
        { $set: { discount: 0 } },
        { writeConcern: { w: 1, j: false } }
      );

      processedCount += result.modifiedCount;
      console.log(`Background processing: ${processedCount}/${totalCount} bookings updated`);

      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`Background discount deletion completed. Updated ${processedCount} bookings.`);
    
    // Broadcast completion
    await broadcast({
      type: "discountDeletionComplete",
      data: { 
        PersonCost, 
        totalUpdated: processedCount,
        message: "Discount deletion background processing completed"
      }
    });

  } catch (error) {
    console.error("Background processing error:", error);
    await broadcast({
      type: "discountDeletionError",
      data: { 
        PersonCost, 
        error: error.message 
      }
    });
  }
}

// Helper function for processing remaining bookings in background
async function processRemainingBookingsInBackground(remainingBookings) {
  console.log(`Processing remaining ${remainingBookings.length} bookings in background`);
  
  try {
    const bookingsCollection = db.collection("bookings");
    const BATCH_SIZE = 100;
    let processedCount = 0;

    for (let i = 0; i < remainingBookings.length; i += BATCH_SIZE) {
      const batch = remainingBookings.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map(booking => booking._id);
      
      const result = await bookingsCollection.updateMany(
        { _id: { $in: batchIds } },
        { $set: { discount: 0 } },
        { writeConcern: { w: 1, j: false } }
      );

      processedCount += result.modifiedCount;
      console.log(`Background processing: ${processedCount}/${remainingBookings.length} remaining bookings updated`);

      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.log(`Background processing of remaining bookings completed. Updated ${processedCount} bookings.`);

  } catch (error) {
    console.error("Error processing remaining bookings:", error);
  }
}

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

    await broadcast({
      type: "updateRoomDiscounts",
      message: "Update",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Update room discount color
router.patch("/updateRoomDiscountColor", async (req, res) => {
  const { key, color } = req.body;

  if (!key || !color) {
    return res.status(400).json({ error: "Discount key and color are required" });
  }

  try {
    const collections = db.collection("roomDiscounts");

    const result = await collections.updateOne(
      { key },
      { $set: { color } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Discount not found" });
    }

    res.status(200).json({ message: "Discount color updated successfully" });

    // Broadcast the update to all connected clients
    await broadcast({
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
  const { key, code } = req.body;
  const discountCode = code || key; // Support both old and new field names

  if (!discountCode) {
    return res.status(400).json({ error: "Discount code is required" });
  }

  try {
    const collections = db.collection("discounts");
    const result = await collections.deleteOne({ 
      $or: [{ key: discountCode }, { code: discountCode }] 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Discount not found" });
    }

    res.status(200).json({ message: "Discount deleted" });

    await broadcast({
      type: "updateDiscount",
      message: "Update",
    })

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/createDiscount", async (req, res) => {
  const { 
    code, 
    description, 
    discountType, 
    amount, 
    usageType, 
    maxUses, 
    expiryDate, 
    isActive, 
    minimumPlayers, 
    minimumAmount, 
    applicableCategories 
  } = req.body;

  if (!code || !discountType || amount === undefined || amount === null) {
    return res.status(400).json({ error: "Code, discount type, and amount are required" });
  }

  if (!['total_fixed', 'total_percentage', 'per_player_fixed', 'per_player_percentage'].includes(discountType)) {
    return res.status(400).json({ error: "Invalid discount type" });
  }

  if (!['infinite', 'single_use'].includes(usageType || 'infinite')) {
    return res.status(400).json({ error: "Invalid usage type" });
  }

  try {
    const collections = db.collection("discounts");

    const discountExist = await collections.findOne({ code });
    if (discountExist) {
      return res.status(400).json({ error: "Discount code already exists" });
    }

    const discountDocument = {
      code,
      description: description || "",
      discountType,
      amount: Number(amount),
      usageType: usageType || 'infinite',
      maxUses: maxUses ? Number(maxUses) : null,
      usedCount: 0,
      usedBy: [],
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      isActive: isActive !== false,
      minimumPlayers: minimumPlayers ? Number(minimumPlayers) : null,
      minimumAmount: minimumAmount ? Number(minimumAmount) : null,
      applicableCategories: applicableCategories || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await collections.insertOne(discountDocument);

    res.status(201).json({ message: "Discount created successfully" });

    await broadcast({
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

    const discountDoc = await collections.findOne({ code: discount });
    if (!discountDoc) {
      return res.status(400).json({ error: "Invalid discount code" });
    }
    res.status(200).json({ message: "Discount applied", discount: discountDoc });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// New enhanced discount validation endpoint
router.post("/validateDiscount", async (req, res) => {
  const { code, players, category, totalAmount, bookingId } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Discount code is required" });
  }

  try {
    const collections = db.collection("discounts");
    const discountDoc = await collections.findOne({ code });

    if (!discountDoc) {
      return res.status(400).json({ 
        valid: false, 
        message: "Invalid discount code" 
      });
    }

    // Check if discount is active
    if (!discountDoc.isActive) {
      return res.status(400).json({ 
        valid: false, 
        message: "This discount code is no longer active" 
      });
    }

    // Check expiry date
    if (discountDoc.expiryDate && new Date() > discountDoc.expiryDate) {
      return res.status(400).json({ 
        valid: false, 
        message: "This discount code has expired" 
      });
    }

    // Check usage limits
    if (discountDoc.usageType === 'single_use' && discountDoc.usedBy.includes(bookingId)) {
      return res.status(400).json({ 
        valid: false, 
        message: "This discount code has already been used for this booking" 
      });
    }

    if (discountDoc.maxUses && discountDoc.usedCount >= discountDoc.maxUses) {
      return res.status(400).json({ 
        valid: false, 
        message: "This discount code has reached its usage limit" 
      });
    }

    // Check minimum requirements
    if (discountDoc.minimumPlayers && players < discountDoc.minimumPlayers) {
      return res.status(400).json({ 
        valid: false, 
        message: `This discount requires at least ${discountDoc.minimumPlayers} players` 
      });
    }

    if (discountDoc.minimumAmount && totalAmount < discountDoc.minimumAmount) {
      return res.status(400).json({ 
        valid: false, 
        message: `This discount requires a minimum booking amount of ${discountDoc.minimumAmount} SEK` 
      });
    }

    // Check applicable categories
    if (discountDoc.applicableCategories.length > 0 && !discountDoc.applicableCategories.includes(category)) {
      return res.status(400).json({ 
        valid: false, 
        message: "This discount is not applicable to the selected room category" 
      });
    }

    // Calculate discount amount based on type
    let discountAmount = 0;
    let newTotalAmount = totalAmount;
    
    switch (discountDoc.discountType) {
      case 'total_fixed':
        discountAmount = discountDoc.amount;
        newTotalAmount = Math.max(totalAmount - discountAmount, 850);
        break;
      case 'total_percentage':
        discountAmount = (totalAmount * discountDoc.amount) / 100;
        newTotalAmount = Math.max(Math.ceil(totalAmount - discountAmount), 850);
        break;
      case 'per_player_fixed':
        // For per-player fixed, replace the per-player cost with discount amount
        newTotalAmount = Math.max(discountDoc.amount * players, 850);
        discountAmount = totalAmount - newTotalAmount;
        break;
      case 'per_player_percentage':
        // For per-player percentage, apply percentage to current per-player cost
        const currentPerPlayerCost = totalAmount / players;
        const discountedPerPlayerCost = currentPerPlayerCost * (1 - discountDoc.amount / 100);
        newTotalAmount = Math.max(Math.ceil(discountedPerPlayerCost * players), 850);
        discountAmount = totalAmount - newTotalAmount;
        break;
      default:
        discountAmount = 0;
    }

    res.status(200).json({ 
      valid: true, 
      discountAmount: Math.round(discountAmount),
      appliedType: discountDoc.discountType,
      message: "Discount applied successfully",
      discount: discountDoc
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Discount usage tracking endpoint
router.patch("/useDiscount/:code", async (req, res) => {
  const { code } = req.params;
  const { bookingId, players, originalAmount } = req.body;

  if (!code || !bookingId) {
    return res.status(400).json({ error: "Code and booking ID are required" });
  }

  try {
    const collections = db.collection("discounts");
    const discountDoc = await collections.findOne({ code });

    if (!discountDoc) {
      return res.status(400).json({ error: "Invalid discount code" });
    }

    // Update usage tracking
    const updateData = {
      usedCount: discountDoc.usedCount + 1,
      updatedAt: new Date()
    };

    // Add booking ID to usedBy array if not already present
    if (!discountDoc.usedBy.includes(bookingId)) {
      updateData.usedBy = [...discountDoc.usedBy, bookingId];
    }

    const result = await collections.updateOne(
      { code },
      { $set: updateData }
    );

    if (result.modifiedCount === 0) {
      return res.status(400).json({ error: "Failed to update discount usage" });
    }

    res.status(200).json({ 
      message: "Discount usage tracked successfully",
      usedCount: updateData.usedCount
    });

    await broadcast({
      type: "updateDiscount",
      message: "Update",
    });

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
  const isFromAdmin = req.query.fromAdmin === 'true' || req.headers['x-from-admin'] === 'true';
  
  try {
    const result = await db.collection("bookings").updateOne(
      { timeSlotId: `${year}-${month}-${day}-${category.trim()}-${time}` },
      { $set: { ...updateData, updatedAt: new Date() } }
    );
    
    // If this is a cancellation (available: true) from admin with action=cancel, update cancelled slot with discount from other same time slots
    if (isFromAdmin && req.query.action === 'cancel' && updateData.available === true) {
      // Find other categories with the same time slot on the same day
      const sameTimeSlots = await db.collection("bookings").find({
        year: year,
        month: month,
        day: day,
        time: time,
        category: { $ne: category.trim() } // Exclude the cancelled booking's category
      }).toArray();
      
      // Find a discount value from the other time slots (take the first non-zero discount found)
      const discountToApply = sameTimeSlots.find(slot => slot.discount && slot.discount !== 0)?.discount;
      
      if (discountToApply) {
        // Update the cancelled booking with the discount from other time slots
        await db.collection("bookings").updateOne(
          { timeSlotId: `${year}-${month}-${day}-${category.trim()}-${time}` },
          { $set: { discount: discountToApply } }
        );
      }
    }
    
    res.json(result);
    
    // Only broadcast if the request is from the admin page
    if (isFromAdmin) {
      const bookingDetails = `${year}-${month}-${day} ${category} ${time}`;
      broadcast({ 
        type: "timeUpdate", 
        title: "bokning ändrad",
        message: bookingDetails,
        year,
        month,
        day,
        category,
        time: time
      }); // Fire-and-forget
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/checkout", async (req, res) => {
  const { year, month, day, category, time } = req.body;
  try {
    const collections = db.collection("bookings");

    // Create the timeSlotId for finding the booking
    const timeSlotId = `${year}-${month}-${day}-${category.trim()}-${time}`;

    // Delete the booking completely
    const result = await collections.deleteOne({ timeSlotId: timeSlotId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({
      message: "Booking deleted successfully",
      timeSlotId: timeSlotId,
      result
    });
    
    // Broadcast the update to all connected clients (fire-and-forget)
    broadcast({ type: "timeUpdate", message: "Update" });

  } catch (error) {
    console.error("Error deleting booking:", error);
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
    await broadcast({
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
    await broadcast({
      type: "bulkTimeUpdate",
      data: updates
    });

    res.json({
      message: "Bulk time update completed",
      results,
      modifiedCount: results.filter(r => r.success).length
    });

  } catch (error) {
    console.error('Error updating times:', error);
    res.status(500).json({ error: "Server error while updating times" });
  }
});

router.patch("/singleRoomDiscount", async (req, res) => {
  const { year, month, day, category, time, discount } = req.body;

  if (!year || !month || !day || !category || !time || discount === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const collections = db.collection("bookings");

    // Update only the specific time slot
    const result = await collections.updateOne(
      {
        year: parseInt(year),
        month: month,
        day: parseInt(day),
        category: category,
        time: time,
        available: { $in: [true, "locked", "unlocked"] } // Update if available is true, "locked", or "unlocked"
      },
      {
        $set: {
          discount: discount
        }
      }
    );

    // Broadcast the update via WebSocket
    await broadcast({
      type: "singleDiscountUpdate",
      data: { year, month, day, category, time, discount }
    });

    res.json({
      message: "Single time discount update completed",
      modifiedCount: result.modifiedCount,
      timeSlotPattern: `${year}-${month}-${day}-${category}-${time}`
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error while updating discount" });
  }
});

router.post("/swish-payment-confirmation", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    console.log("No paymentId provided in request");
    return res.status(400).json({ error: "Payment ID is required" });
  }

  // If payment is still in paymentStates, it means it's still pending
  if (paymentStates[paymentId]) {
    return res.json({
      status: "NOT PAID"
    });
  }

  // If not in paymentStates, check the database to see if it was actually paid
  try {
    const collections = db.collection("bookings");
    const booking = await collections.findOne({ 
      paymentId: paymentId,
      payed: { $ne: false } // Check if payed is not false (could be "Swish", "Nets Easy", etc.)
    });

    if (booking) {
      return res.json({
        status: "PAID"
      });
    } else {
      return res.json({
        status: "NOT PAID"
      });
    }
  } catch (error) {
    console.error("Error checking payment status:", error);
    return res.json({
      status: "NOT PAID"
    });
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

// Get a single booking by timeSlotId
router.get("/booking/:timeSlotId", async (req, res) => {
  const { timeSlotId } = req.params;
  try {
    const booking = await db.collection("bookings").findOne({ timeSlotId: timeSlotId });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }
    res.json(booking);
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
        const paymentId = req.body.id;

        const bookings = await collections.find({ paymentId: paymentId }).toArray();
        const originalTotalCost = bookings.reduce((sum, b) => sum + (b.cost || 0), 0);
        const amountPaid = parseFloat(req.body.amount);     // SEK
        const giftCardUsed = originalTotalCost - amountPaid;
        await handleGiftCardUpdate(bookings, giftCardUsed);

        // Create a reliable Swedish timezone timestamp
        const currentTime = new Date();
        const swedenTime = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(currentTime);

        // Update all bookings with this paymentId
        const result = await collections.updateMany(
          { paymentId: paymentId },
          { $set: { available: false, payed: "Swish", updatedAt: new Date(), bookedAt: swedenTime } }
        );
        console.log("Booking update result:", result);

        // Send GA4 tracking for completed booking
        if (result.modifiedCount > 0) {
          await trackBookingCompleted();
        }

        // Broadcast new booking notification (non-blocking)
        if (result.modifiedCount > 0 && bookings.length > 0) {
          const bookingsCount = bookings.length;
          
          // Different message format based on count
          let message;
          if (bookingsCount === 1) {
            const booking = bookings[0];
            message = `${booking.year}-${booking.month}-${booking.day} ${booking.category} ${booking.time}`;
          } else {
            message = `${bookingsCount} bokningar`;
          }
          
          broadcast({
            type: "bookingInitialized", 
            title: "Bokning slutförd",
            message: message,
            bookingsCount: bookingsCount,
            bookings: bookings.map(booking => ({
              year: booking.year,
              month: booking.month,
              day: booking.day,
              category: booking.category,
              time: booking.time,
              timeSlotId: booking.timeSlotId
            })),
            timeSlotIds: bookings.map(booking => booking.timeSlotId),
            paymentId: paymentId,
            paymentMethod: "Swish"
          });
        }

        // Delete backup entries by timeSlotId for each booking
        try {
          const backupCollection = db.collection("backup");
          let totalDeleted = 0;
          for (const booking of bookings) {
            if (booking.timeSlotId) {
              const backupResult = await backupCollection.deleteMany({ timeSlotId: booking.timeSlotId });
              totalDeleted += backupResult.deletedCount;
              console.log(`✅ Deleted ${backupResult.deletedCount} backup entries for timeSlotId: ${booking.timeSlotId}`);
            }
          }
          console.log(`✅ Total deleted backup entries: ${totalDeleted}`);
        } catch (backupError) {
          console.error(`❌ Error deleting backup entries:`, backupError);
          // Continue processing even if backup deletion fails
        }

        // Delete discount usage after successful payment
        try {
          const discountCollection = db.collection("discounts");
          const discountDeleteResult = await discountCollection.deleteOne({ usedBy: paymentId });
          if (discountDeleteResult.deletedCount > 0) {
            console.log(`✅ Deleted discount with usedBy: ${paymentId}`);
          }
        } catch (discountError) {
          console.error(`❌ Error deleting discount for payment ${paymentId}:`, discountError);
        }

        try {
          // Use the existing bookings array for confirmation email
          if (bookings.length > 0 && bookings[0].email) {
            // Prepare booking details for email
            const email = bookings[0].email;
            const bookingRef = bookings[0].bookingRef;
            const bookingDate = new Date().toISOString().split('T')[0];
            const totalCost = bookings.reduce((sum, booking) => sum + (booking.cost || 0), 0);
            const tax = Math.round(totalCost * 0.20);

            // Prepare items for the email
            const items = bookings.map(booking => ({
              category: booking.category,
              date: `${booking.day} ${booking.month} ${booking.year}`,
              time: booking.time,
              players: booking.players,
              cost: booking.cost
            }));

            // Send confirmation email using the exact same template as send-confirmation
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
                            ">Bokningsnummer: ${bookingRef}</p>
                            <p style="
                                margin: 0;
                                color: rgb(160, 160, 160);
                            ">Bokningsdatum: ${bookingDate}</p>
                        </div>

                        <div style="
                            padding: 20px 10px;
                            color: rgb(160, 160, 160);
                        ">
                            <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                            <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                        </div>

                        <div style="padding: 5px 10px;">
                            ${items.map(item => `
                                <div style="
                                    display: flex;
                                    justify-content: space-between;
                                    align-items: center;
                                    margin: 10px 0;
                                    color: white;
                                ">
                                    <div style="display: flex; align-items: center; gap: 10px;">
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

                        <div style="padding: 0 10px;">
                            <div style="
                                display: grid;
                                grid-template-columns: auto auto;
                                justify-content: space-between;
                                padding: 15px 0;
                                color: white;
                                border-top: 1px solid rgb(29, 29, 29);
                                gap: 200px;
                            ">
                                <p style="margin: 0;">Betalsätt</p>
                                <p style="margin: 0;">Swish</p>
                            </div>

                            <div style="
                                display: grid;
                                grid-template-columns: auto auto;
                                justify-content: space-between;
                                padding: 15px 0;
                                color: white;
                                gap: 200px;
                            ">
                                <p style="margin: 0;">Moms</p>
                                <p style="margin: 0;">SEK ${tax}</p>
                            </div>

                            <div style="
                                display: grid;
                                grid-template-columns: auto auto;
                                justify-content: space-between;
                                padding: 15px 0;
                                color: white;
                                border-top: 1px solid rgb(29, 29, 29);
                                gap: 200px;
                            ">
                                <p style="margin: 0; font-weight: bold;">Totalt</p>
                                <p style="margin: 0; font-weight: bold;">SEK ${totalCost}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            await transporter.sendMail({
              from: process.env.EMAIL_USER,
              to: email,
              subject: "Bokningsbekräftelse - Din betalning har mottagits",
              html: emailHtml
            });

            console.log(`Confirmation email sent to ${email} for payment ${paymentId}`);
          } else {
            console.log(`No email found for payment ${paymentId} or no bookings associated`);
          }
        } catch (emailError) {
          console.error("Error sending confirmation email:", emailError);
          // Continue processing even if email fails
        }

        if (paymentStates[paymentId]) {
          delete paymentStates[paymentId];
          console.log("Payment terminated from paymentStates:", paymentId);
        }

      } catch (dbError) {
        console.error('Error updating booking or sending email:', dbError, {
          message,
          parseResult: message.match(/([A-Z\s]+)\s+(\d+)\/(\w+)\s+(\d{2}:\d{2})/)
        });
      }
    } else if (status === 'ERROR') {
      try {
        console.log(`Swish payment failed: ${req.body.errorMessage} (${req.body.errorCode})`);
        const paymentId = req.body.id;

        // First, check what bookings exist with this paymentId
        const collections = db.collection("bookings");
        const existingBookings = await collections.find({ paymentId: paymentId }).toArray();
        console.log(`Found ${existingBookings.length} bookings with paymentId: ${paymentId}`);

        if (existingBookings.length > 0) {
          // Reset all bookings with this paymentId to available state
          const updateResult = await collections.updateMany(
            { paymentId: paymentId,
              available: "occupied"
             },
            {
              $set: {
                available: true,
                players: 0,
                payed: null,
                cost: 0,
                bookedBy: null,
                number: null,
                email: null,
                info: null,
                bookingRef: null,
                paymentId: null, // Clear the paymentId AFTER we found the bookings
                updatedAt: new Date()
              }
            }
          );
          
          console.log(`✅ Reset ${updateResult.modifiedCount} bookings for failed payment ${paymentId}`);
        } else {
          // No bookings found - might already be cleaned up
          console.log(`⚠️ No bookings found with paymentId: ${paymentId} - might already be cleaned up`);
        }

        // Clean up payment states
        if (paymentStates[paymentId]) {
          delete paymentStates[paymentId];
          console.log(`Removed failed payment ${paymentId} from paymentStates`);
        }

        // Terminate the payment on Swish provider
        try {
          console.log(`Attempting to terminate payment ${paymentId} on Swish provider`);
          
          // Load certificates for Swish API (use different variable name)
          const swishCert = fs.readFileSync(join(__dirname, '../ssl/myCertificate.pem'), 'utf8');
          const swishKey = fs.readFileSync(join(__dirname, '../ssl/PrivateKey.key'), 'utf8');
          const swishCa = fs.readFileSync(join(__dirname, '../ssl/Swish_TLS_RootCA.pem'), 'utf8');

          const httpsAgent = new https.Agent({
            cert: swishCert,
            key: swishKey,
            ca: swishCa,
            minVersion: 'TLSv1.2',
            rejectUnauthorized: false
          });

          const client = axios.create({ httpsAgent });

          const cancelResponse = await client.patch(
            `https://cpc.getswish.net/swish-cpcapi/api/v1/paymentrequests/${paymentId}`,
            [{
              "op": "replace",
              "path": "/status",
              "value": "cancelled"
            }],
            {
              headers: {
                "Content-Type": "application/json-patch+json"
              }
            }
          );
          
          if (cancelResponse.status === 200 || cancelResponse.status === 204) {
            console.log(`✅ Payment ${paymentId} terminated successfully on Swish provider`);
          } else {
            console.error(`❌ Failed to terminate payment ${paymentId} on provider:`, cancelResponse.status, cancelResponse.data);
          }
        } catch (terminateError) {
          console.error(`❌ Error terminating payment ${paymentId} on Swish provider:`, terminateError.message);
        }

        // Clean up any discounts used by this payment
        try {
          const discountCollection = db.collection("discounts");
          const discountDeleteResult = await discountCollection.deleteOne({ usedBy: paymentId });
          if (discountDeleteResult.deletedCount > 0) {
            console.log(`✅ Cleaned up discount for failed payment ${paymentId}`);
          }
        } catch (discountError) {
          console.error(`❌ Error cleaning up discount for failed payment ${paymentId}:`, discountError);
        }

      } catch (cleanupError) {
        console.error('Error cleaning up failed Swish payment:', cleanupError);
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

    console.log('=== Swish Payment Request ===');
    console.log('Request params:', { instructionUUID });
    console.log('Request body:', { payerAlias, amount, message, isMobile });

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

    const client = axios.create({ httpsAgent });

    // Base payment data
    let paymentData = {
      payeePaymentReference: instructionUUID,
      callbackUrl: 'https://mintbackend-0066444807ba.herokuapp.com/swish/callback',
      payeeAlias: '1230047647',
      amount: amount,
      currency: 'SEK',
      message: message
    };

    // Only add payerAlias for E-Commerce (desktop) payments
    // For M-Commerce (mobile), omit payerAlias to get PaymentRequestToken header
    if (!isMobile && payerAlias && typeof payerAlias === 'string') {
      paymentData.payerAlias = payerAlias.startsWith('0') ? '46' + payerAlias.slice(1) : payerAlias;
      console.log('Added payerAlias for E-Commerce:', paymentData.payerAlias);
    } else if (isMobile) {
      console.log('Omitting payerAlias for M-Commerce to enable deep linking');
    }

    console.log('Initial payment data:', paymentData);
    console.log('Final payment data:', paymentData);
    console.log('Making Swish request to:', `https://cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/${instructionUUID}`);

    const response = await client.put(
      `https://cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/${instructionUUID}`,
      paymentData,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: false
      }
    );

    console.log('Swish API Response:', {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data
    });

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
      const cancelResponse = await client.patch(
        `https://cpc.getswish.net/swish-cpcapi/api/v1/paymentrequests/${existingPaymentId}`,
        [{
          "op": "replace",
          "path": "/status",
          "value": "cancelled"
        }],
        {
          headers: {
            "Content-Type": "application/json-patch+json"
          }
        }
      );
      console.log(cancelResponse, "cancelResponse");
    }

    // For QR code payments, make an additional request to get payment status
    if (!isMobile && response.status === 201) {
      console.log('Making QR code status request...');
      try {
        const statusResponse = await client.post(
          `https://mpc.getswish.net/qrg-swish/api/v1/commerce`,
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

        console.log('QR code status response:', {
          status: statusResponse.status,
          data: statusResponse.data
        });

        return res.status(response.status).json({
          status: response.status,
          paymentRequestToken: response.headers.location,
          instructionUUID,
          paymentType: 'qr',
          paymentStatus: statusResponse.data
        });
      } catch (statusError) {
        console.error('Error fetching QR code status:', statusError);
      }
    }

    // For mobile payments, use PaymentRequestToken header; for desktop, use location header
    const tokenValue = isMobile ? 
      (response.headers.paymentrequesttoken || response.headers.PaymentRequestToken) : 
      response.headers.location;

    console.log('Sending final response:', {
      status: response.status,
      paymentRequestToken: tokenValue,
      instructionUUID,
      paymentType: isMobile ? 'mobile' : 'qr',
      headers: response.headers // Debug: log all headers
    });

    res.status(response.status).json({
      status: response.status,
      paymentRequestToken: tokenValue,
      instructionUUID,
      paymentType: isMobile ? 'mobile' : 'qr'
    });

  } catch (error) {
    console.error('=== Swish Payment Error ===');
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack
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
    let query = { available: false }; // Only search booked slots

    // Check if searchTerm contains any numbers
    if (/\d/.test(searchTerm)) {
      // Search by paymentId
      query.bookingRef = {
        $regex: searchTerm,
        $options: 'i'
      };
    } else {
      // Search by bookedBy (name)
      query.bookedBy = {
        $regex: searchTerm,
        $options: 'i'
      };
    }

    const result = await collections.find(query)
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

router.post("/edit-confirmation", async (req, res) => {
  try {
    const { to, subject, bookingDetails, paymentId } = req.body;

    // Fetch all bookings with the given paymentId
    const collections = db.collection("bookings");
    let bookings = [];

    if (paymentId) {
      // If paymentId is provided, fetch bookings by paymentId
      bookings = await collections.find({ paymentId: paymentId }).toArray();
      console.log(`Found ${bookings.length} bookings for paymentId ${paymentId}`);
    }

    // If no bookings found by paymentId or no paymentId provided, use the items from bookingDetails
    const items = bookings.length > 0
      ? bookings.map(booking => ({
        category: booking.category,
        date: `${booking.day} ${booking.month} ${booking.year}`,
        time: booking.time,
        players: booking.players,
        cost: booking.cost
      }))
      : bookingDetails.items;

    // Calculate total cost and tax based on the items
    const totalCost = items.reduce((sum, item) => sum + (item.cost || 0), 0);
    const tax = Math.round(totalCost * 0.20);

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
                  <h1 style="color: #333;">Din bokning har blivit ändrad</h1>
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
                      ">Kvitto - Bokningsändring</h2>
                      <p style="
                          margin: 0;
                          color: rgb(160, 160, 160);
                      ">Bokningsnummer: ${bookingDetails.bookingRef}</p>
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
                      ${items.map(item => `
                          <div style="
                              display: flex;
                              justify-content: space-between;
                              align-items: center;
                              margin: 10px 0;
                              color: white;
                          ">
                              <div style="display: flex; align-items: center; gap: 10px;">
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

                  <div style="padding: 0 10px;">
                      <div style="
                          display: grid;
                          grid-template-columns: auto auto;
                          justify-content: space-between;
                          padding: 15px 0;
                          color: white;
                          border-top: 1px solid rgb(29, 29, 29);
                          gap: 200px;
                      ">
                          <p style="margin: 0;">Betalsätt</p>
                          <p style="margin: 0;">${bookingDetails.paymentMethod}</p>
                      </div>

                      <div style="
                          display: grid;
                          grid-template-columns: auto auto;
                          justify-content: space-between;
                          padding: 15px 0;
                          color: white;
                          gap: 200px;
                      ">
                          <p style="margin: 0;">Moms</p>
                          <p style="margin: 0;">SEK ${tax}</p>
                      </div>

                      <div style="
                          display: grid;
                          grid-template-columns: auto auto;
                          justify-content: space-between;
                          padding: 15px 0;
                          color: white;
                          border-top: 1px solid rgb(29, 29, 29);
                          gap: 200px;
                      ">
                          <p style="margin: 0; font-weight: bold;">Totalt</p>
                          <p style="margin: 0; font-weight: bold;">SEK ${totalCost}</p>
                      </div>
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
                          ">Bokningsnummer: ${bookingDetails.bookingRef}</p>
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

                      <div style="padding: 0 10px;">
                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              border-top: 1px solid rgb(29, 29, 29);
                              gap: 200px;
                          ">
                              <p style="margin: 0;">Betalsätt</p>
                              <p style="margin: 0;">${bookingDetails.paymentMethod}</p>
                          </div>

                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              gap: 200px;
                          ">
                              <p style="margin: 0;">Moms</p>
                              <p style="margin: 0;">SEK ${bookingDetails.tax}</p>
                          </div>

                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              border-top: 1px solid rgb(29, 29, 29);
                              gap: 200px;
                          ">
                              <p style="margin: 0; font-weight: bold;">Totalt</p>
                              <p style="margin: 0; font-weight: bold;">SEK ${bookingDetails.totalCost}</p>
                          </div>
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

router.post("/reset-all-offers", async (req, res) => {
  try {
    const collections = db.collection("bookings");

    // First, get an estimate of how many documents need to be processed
    const estimatedCount = await collections.estimatedDocumentCount();
    
    // For very large collections, process in batches to avoid timeout
    if (estimatedCount > 10000) {
      // Process in background for large operations
      const processBatchesSequentially = async () => {
        const BATCH_SIZE = 5000;
        let totalProcessed = 0;
        let skip = 0;
        
        while (true) {
          const batch = await collections.find({}).skip(skip).limit(BATCH_SIZE).toArray();
          if (batch.length === 0) break;
          
          // Update this batch
          const batchIds = batch.map(doc => doc._id);
          const batchResult = await collections.updateMany(
            { _id: { $in: batchIds } },
            { $set: { offer: null } },
            { writeConcern: { w: 1, j: false } }
          );
          
          totalProcessed += batchResult.modifiedCount;
          skip += BATCH_SIZE;
          
          // Add small delay between batches
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Broadcast progress
          await broadcast({
            type: "offerResetProgress",
            data: { 
              processed: totalProcessed,
              estimated: estimatedCount,
              progress: Math.round((totalProcessed / estimatedCount) * 100)
            }
          });
        }
        
        // Final broadcast when complete
        await broadcast({
          type: "offersReset",
          data: {
            message: "All offers have been reset",
            totalProcessed: totalProcessed
          }
        });
      };
      
      // Start processing in background
      processBatchesSequentially().catch(console.error);
      
      return res.status(200).json({
        success: true,
        message: "Large offer reset started in background",
        estimatedCount,
        status: "processing"
      });
    }

    // For smaller collections, process normally with optimized write concern
    const result = await collections.updateMany(
      {}, // empty filter to match all documents
      { $set: { offer: null } },
      { writeConcern: { w: 1, j: false } } // Faster write concern
    );

    // Broadcast the update via WebSocket to notify all clients
    await broadcast({
      type: "offersReset",
      data: {
        message: "All offers have been reset",
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      }
    });

    res.status(200).json({
      success: true,
      message: "All offers have been reset",
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error("Reset offers error:", error);
    res.status(500).json({
      success: false,
      error: "Server error while resetting offers",
      message: error.message
    });
  }
});

// Gift Card Routes

const handleGiftCardUpdate = async (bookings, totalCost) => {
  if (!bookings || bookings.length === 0) return;

  const firstBooking = bookings[0];
  const { giftCardReference } = firstBooking;

  if (!giftCardReference) return;

  try {
      const giftCardCollections = db.collection("giftcards");
      const giftCard = await giftCardCollections.findOne({ reference: giftCardReference });

      if (giftCard && giftCard.payed) {
          const amountToDeduct = Math.min(totalCost, giftCard.totalAmount);
          const newTotalAmount = giftCard.totalAmount - amountToDeduct;

          await giftCardCollections.updateOne(
              { reference: giftCardReference },
              { $set: { totalAmount: newTotalAmount, updatedAt: new Date() } }
          );
          console.log(`Gift card ${giftCardReference} updated. New balance: ${newTotalAmount}`);
      }
  } catch (error) {
      console.error(`Error updating gift card ${giftCardReference}:`, error);
  }
};

router.post("/confirm-with-giftcard", async (req, res) => {
  const { combinedData, giftCardReference, totalCost, name, number, email } = req.body;
  const bookingRef = `${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  const collections = db.collection("bookings");

  try {
      const currentTime = new Date();
      const swedenTime = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).format(currentTime);

      const bookingPromises = combinedData.map(data => {
          const timeSlotId = `${data.year}-${data.month}-${data.day}-${data.categoryName.trim()}-${data.time.time}`;
          return collections.updateOne(
              { timeSlotId },
              {
                  $set: {
                      available: false,
                      payed: "Presentkort",
                      updatedAt: new Date(),
                      bookedAt: swedenTime,
                      bookedBy: name,
                      number,
                      email,
                      bookingRef,
                      cost: data.time.cost,
                      players: data.time.players,
                      giftCardReference
                  }
              }
          );
      });

      await Promise.all(bookingPromises);
      const bookings = await collections.find({ bookingRef }).toArray();
      await handleGiftCardUpdate(bookings, totalCost);
      
      console.log(`Booking confirmed with gift card. Ref: ${bookingRef}`);

      try {
        if (bookings.length > 0 && email) {
          const bookingDate = new Date().toISOString().split('T')[0];
          const tax = Math.round(totalCost * 0.20);

          const items = bookings.map(booking => ({
            category: booking.category,
            date: `${booking.day} ${booking.month} ${booking.year}`,
            time: booking.time,
            players: booking.players,
            cost: booking.cost
          }));

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
                          ">Bokningsnummer: ${bookingRef}</p>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Bokningsdatum: ${bookingDate}</p>
                      </div>

                      <div style="
                          padding: 20px 10px;
                          color: rgb(160, 160, 160);
                      ">
                          <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                          <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                      </div>

                      <div style="padding: 5px 10px;">
                          ${items.map(item => `
                              <div style="
                                  display: flex;
                                  justify-content: space-between;
                                  align-items: center;
                                  margin: 10px 0;
                                  color: white;
                              ">
                                  <div style="display: flex; align-items: center; gap: 10px;">
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

                      <div style="padding: 0 10px;">
                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              border-top: 1px solid rgb(29, 29, 29);
                              gap: 200px;
                          ">
                              <p style="margin: 0;">Betalsätt</p>
                              <p style="margin: 0;">Presentkort</p>
                          </div>

                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              gap: 200px;
                          ">
                              <p style="margin: 0;">Moms</p>
                              <p style="margin: 0;">SEK ${tax}</p>
                          </div>

                          <div style="
                              display: grid;
                              grid-template-columns: auto auto;
                              justify-content: space-between;
                              padding: 15px 0;
                              color: white;
                              border-top: 1px solid rgb(29, 29, 29);
                              gap: 200px;
                          ">
                              <p style="margin: 0; font-weight: bold;">Totalt</p>
                              <p style="margin: 0; font-weight: bold;">SEK ${totalCost}</p>
                          </div>
                      </div>
                  </div>
              </div>
          `;

          await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Bokningsbekräftelse - Din betalning har mottagits",
            html: emailHtml
          });

          console.log(`Confirmation email sent to ${email} for booking ${bookingRef}`);
        } else {
          console.log(`No email provided for booking ${bookingRef} or no bookings associated`);
        }
      } catch (emailError) {
        console.error("Error sending confirmation email:", emailError);
      }

      res.status(200).json({ message: "Booking confirmed successfully" });

  } catch (error) {
    console.error("Error confirming with gift card:", error);
    res.status(500).json({ error: "Failed to confirm booking with gift card" });
  }
});

// Store gift card in database
router.post("/giftcard", async (req, res) => {
  try {
    const giftCardData = req.body;
    const collections = db.collection("giftcards");

    // Add timestamp
    const currentTime = new Date();
    const swedenTime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(currentTime);

    const result = await collections.insertOne({
      ...giftCardData,
      createdAt: swedenTime,
      updatedAt: new Date()
    });

    console.log("Gift card created:", giftCardData.reference);
    res.status(201).json({ 
      message: "Gift card created successfully", 
      id: result.insertedId,
      reference: giftCardData.reference
    });

  } catch (error) {
    console.error("Error creating gift card:", error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize gift card payment
router.post("/v1/giftcard-payments/:paymentId/initialize", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const currentDate = new Date();
    const body = req.body;

    console.log(`Initializing gift card payment: ${paymentId}`);

    // Store payment state for tracking
    paymentStates[paymentId] = { 
      date: currentDate, 
      data: body.giftCardData,
      type: "giftcard"
    };

    console.log("Gift card payment states:", Object.keys(paymentStates));

    res.status(200).json({ 
      message: "Gift card payment initialized", 
      paymentId, 
      date: currentDate 
    });

    await broadcast({
      type: "giftcard_initialize",
      message: "Gift card payment initialized"
    });

  } catch (error) {
    console.error("Error initializing gift card payment:", error);
    res.status(500).json({ error: error.message });
  }
});

// Swish payment for gift cards
router.post('/swish/giftcard-payment/:instructionUUID', async (req, res) => {
  try {
    const { instructionUUID } = req.params;
    const { payerAlias, amount, message, isMobile } = req.body;

    console.log('=== Swish Gift Card Payment Request ===');
    console.log('Request params:', { instructionUUID });
    console.log('Request body:', { payerAlias, amount, message, isMobile });

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

    const client = axios.create({ httpsAgent });

    // Base payment data
    let paymentData = {
      payeePaymentReference: instructionUUID,
      callbackUrl: 'https://mintbackend-0066444807ba.herokuapp.com/swish/giftcard-callback',
      payeeAlias: '1230047647',
      amount: amount,
      currency: 'SEK',
      message: message
    };

    // Add payerAlias if provided
    if (payerAlias && typeof payerAlias === 'string') {
      paymentData.payerAlias = payerAlias.startsWith('0') ? '46' + payerAlias.slice(1) : payerAlias;
      console.log('Added payerAlias:', paymentData.payerAlias);
    }

    console.log('Gift card payment data:', paymentData);

    const response = await client.put(
      `https://cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/${instructionUUID}`,
      paymentData,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: false
      }
    );

    console.log('Swish Gift Card API Response:', {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    });

    // For QR code payments
    if (!isMobile && response.status === 201) {
      console.log('Making QR code status request for gift card...');
      try {
        const statusResponse = await client.post(
          `https://mpc.getswish.net/qrg-swish/api/v1/commerce`,
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
        console.error('Error fetching QR code status for gift card:', statusError);
      }
    }

    res.status(response.status).json({
      status: response.status,
      paymentRequestToken: response.headers.location,
      instructionUUID,
      paymentType: isMobile ? 'mobile' : 'qr'
    });

  } catch (error) {
    console.error('=== Swish Gift Card Payment Error ===');
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({
      error: 'Gift card payment processing error',
      message: error.message,
      details: error.response?.data
    });
  }
});

// Gift card payment confirmation
router.post("/swish-giftcard-payment-confirmation", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    console.log("No paymentId provided for gift card confirmation");
    return res.status(400).json({ error: "Payment ID is required" });
  }

  if (!paymentStates[paymentId]) {
    return res.json({
      status: "PAID"
    });
  }

  res.json({
    status: "NOT PAID"
  });
});

// Swish callback for gift cards
router.post("/swish/giftcard-callback", async (req, res) => {
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

    console.log('Swish gift card callback received:', req.body);

    if (status === 'PAID') {
      try {
        const collections = db.collection("giftcards");
        const instructionId = req.body.payeePaymentReference; // Our instructionId, not Swish's ID

        // Create a reliable Swedish timezone timestamp
        const currentTime = new Date();
        const swedenTime = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(currentTime);

        // Update gift card with payment confirmation
        const result = await collections.updateMany(
          { paymentId: instructionId },
          { 
            $set: { 
              payed: true, 
              paymentMethod: "Swish",
              paidAt: swedenTime,
              updatedAt: new Date() 
            } 
          }
        );

        console.log("Gift card update result:", {
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount
        });

        // Send gift card email to recipient
        try {
          const giftCards = await collections.find({ paymentId: instructionId }).toArray();

          if (giftCards.length > 0 && giftCards[0].recipientEmail) {
            const giftCard = giftCards[0];
            
            // Send gift card email
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
                      <h1 style="color: #333;">🎁 Du har fått ett presentkort!</h1>
                  </div>

                  <div style="
                      background-color: rgb(17, 21, 22);
                      border-radius: 15px;
                      overflow: hidden;
                      margin-bottom: 30px;
                  ">
                      <div style="
                          padding: 30px 10px;
                          border-bottom: 1px solid rgb(29, 29, 29);
                      ">
                          <h2 style="
                              margin: 10px 0 5px 0;
                              color: white;
                          ">Presentkort - Mint Escape Room</h2>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Presentkortsnummer: ${giftCard.reference}</p>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Värde: ${giftCard.totalAmount} SEK</p>
                      </div>

                      <div style="
                          padding: 20px 10px;
                          color: rgb(160, 160, 160);
                      ">
                          <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                          <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                      </div>

                      ${giftCard.message ? `
                      <div style="
                          padding: 20px 10px;
                          color: white;
                          border-top: 1px solid rgb(29, 29, 29);
                      ">
                          <h3 style="margin: 0 0 10px 0; color: rgb(154, 220, 198);">Personligt meddelande:</h3>
                          <p style="margin: 0; font-style: italic;">"${giftCard.message}"</p>
                      </div>
                      ` : ''}
                  </div>

                  <div style="
                      background-color: rgb(154, 220, 198);
                      color: black;
                      padding: 20px;
                      border-radius: 10px;
                      text-align: center;
                  ">
                      <p style="margin: 0; font-weight: bold;">
                          Boka din upplevelse på mintescaperoom.se eller ring 018-21 11 10
                      </p>
                  </div>
              </div>
            `;

            await transporter.sendMail({
              from: process.env.EMAIL_USER,
              to: giftCard.recipientEmail,
              subject: "🎁 Ditt presentkort från Mint Escape Room",
              html: emailHtml
            });

            console.log(`Gift card email sent to ${giftCard.recipientEmail} for payment ${instructionId}`);
          }
        } catch (emailError) {
          console.error("Error sending gift card email:", emailError);
        }

        // Remove from payment states
        if (paymentStates[instructionId]) {
          delete paymentStates[instructionId];
          console.log("Gift card payment terminated from paymentStates:", instructionId);
        }

      } catch (dbError) {
        console.error('Error updating gift card:', dbError);
      }
    }

    // Always return 200 OK to Swish
    res.status(200).json({
      message: 'Gift card callback received',
      receivedData: req.body
    });

  } catch (error) {
    console.error('Swish gift card callback error:', error);
    res.status(200).json({
      error: 'Gift card callback processing error',
      errorDetails: error.message
    });
  }
});

// Webhook for gift card purchases (Nets Easy)
router.post("/giftCardCreated", async (req, res) => {
  try {
    const event = req.body;

    console.log("Gift card webhook event received:", event);

    switch (event.event) {
      case "payment.checkout.completed":
        console.log("Gift card payment completed event:", event.data);

        const orderData = event.data.order;
        const paymentId = event.data.paymentId;
        
        console.log("Gift card order details:", {
          amount: orderData.amount.amount,
          reference: orderData.reference
        });

        const amount = orderData.amount.amount;

        // Charge the payment
        const chargeResponse = await fetch(`https://api.dibspayment.eu/v1/payments/${paymentId}/charges`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": key,
          },
          body: JSON.stringify({ amount: amount })
        });

        const chargeData = await chargeResponse.json();
        console.log("Gift card charge response:", chargeData);

        // Update gift card with payment confirmation
        const collections = db.collection("giftcards");
        
        const currentTime = new Date();
        const swedenTime = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(currentTime);

        // Use netsPaymentId to find the record
        const result = await collections.updateMany(
          { netsPaymentId: paymentId },
          {
            $set: {
              payed: true,
              paymentMethod: "Nets Easy",
              paidAt: swedenTime,
              updatedAt: new Date()
            }
          }
        );

        console.log("Gift card update result:", {
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount
        });

        // Send gift card email to recipient - also use netsPaymentId
        try {
          const giftCards = await collections.find({ netsPaymentId: paymentId }).toArray();

          if (giftCards.length > 0 && giftCards[0].recipientEmail) {
            const giftCard = giftCards[0];
            
            // Send gift card email
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
                      <h1 style="color: #333;">🎁 Du har fått ett presentkort!</h1>
                  </div>

                  <div style="
                      background-color: rgb(17, 21, 22);
                      border-radius: 15px;
                      overflow: hidden;
                      margin-bottom: 30px;
                  ">
                      <div style="
                          padding: 30px 10px;
                          border-bottom: 1px solid rgb(29, 29, 29);
                      ">
                          <h2 style="
                              margin: 10px 0 5px 0;
                              color: white;
                          ">Presentkort - Mint Escape Room</h2>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Presentkortsnummer: ${giftCard.reference}</p>
                          <p style="
                              margin: 0;
                              color: rgb(160, 160, 160);
                          ">Värde: ${giftCard.totalAmount} SEK</p>
                      </div>

                      <div style="
                          padding: 20px 10px;
                          color: rgb(160, 160, 160);
                      ">
                          <p style="margin: 0;">Mint Escape Room AB | Org.nr: 559382-8444 44</p>
                          <p style="margin: 0;">Vaksalagatan 31 A 753 31 Uppsala</p>
                      </div>

                      ${giftCard.message ? `
                      <div style="
                          padding: 20px 10px;
                          color: white;
                          border-top: 1px solid rgb(29, 29, 29);
                      ">
                          <h3 style="margin: 0 0 10px 0; color: rgb(154, 220, 198);">Personligt meddelande:</h3>
                          <p style="margin: 0; font-style: italic;">"${giftCard.message}"</p>
                      </div>
                      ` : ''}
                  </div>

                  <div style="
                      background-color: rgb(154, 220, 198);
                      color: black;
                      padding: 20px;
                      border-radius: 10px;
                      text-align: center;
                  ">
                      <p style="margin: 0; font-weight: bold;">
                          Boka din upplevelse på mintescaperoom.se eller ring 018-21 11 10
                      </p>
                  </div>
              </div>
            `;

            await transporter.sendMail({
              from: process.env.EMAIL_USER,
              to: giftCard.recipientEmail,
              subject: "🎁 Ditt presentkort från Mint Escape Room",
              html: emailHtml
            });

            console.log(`Gift card email sent to ${giftCard.recipientEmail} for payment ${paymentId}`);
          }
        } catch (emailError) {
          console.error("Error sending gift card email:", emailError);
        }

        // Remove from payment states - use instructionId if available
        const giftCards = await collections.find({ netsPaymentId: paymentId }).toArray();
        if (giftCards.length > 0 && giftCards[0].instructionId && paymentStates[giftCards[0].instructionId]) {
          delete paymentStates[giftCards[0].instructionId];
          console.log("Gift card payment terminated from paymentStates:", giftCards[0].instructionId);
        }

        break;
      default:
        console.log("Unhandled gift card event type:", event);
    }

    res.status(200).send("Gift card event received");
  } catch (error) {
    console.error("Error processing gift card webhook event:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get all gift cards (for admin)
router.get("/giftcards", async (req, res) => {
  try {
    const collections = db.collection("giftcards");
    const giftCards = await collections.find({}).sort({ createdAt: -1 }).toArray();
    res.json(giftCards);
  } catch (error) {
    console.error("Error fetching gift cards:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get gift card by reference
router.get("/giftcard/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const collections = db.collection("giftcards");
    const giftCard = await collections.findOne({ reference: reference });
    
    if (!giftCard) {
      return res.status(404).json({ error: "Gift card not found" });
    }
    
    res.json(giftCard);
  } catch (error) {
    console.error("Error fetching gift card:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update gift card with Nets paymentId
router.patch("/giftcard/update/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const { netsPaymentId, instructionId } = req.body;
    const collections = db.collection("giftcards");

    const result = await collections.updateOne(
      { reference: reference },
      { 
        $set: { 
          netsPaymentId: netsPaymentId,
          instructionId: instructionId,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Gift card not found" });
    }

    console.log(`Gift card ${reference} updated with Nets paymentId: ${netsPaymentId}`);
    res.status(200).json({ 
      message: "Gift card updated successfully",
      reference: reference,
      netsPaymentId: netsPaymentId
    });

  } catch (error) {
    console.error("Error updating gift card:", error);
    res.status(500).json({ error: error.message });
  }
});

// ===== NOTIFICATION ROUTES =====

// Get notifications for specific user
router.get('/notifications/:username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const notificationCollection = db.collection("notifications");
    
    // Get all notifications and calculate read status for this user
    const notifications = await notificationCollection
      .find({})
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();
    
    // Add user-specific read status
    const userNotifications = notifications.map(notification => {
      const userRead = notification.readBy?.find(read => read.username === username);
      return {
        ...notification,
        isRead: !!userRead,
        readAt: userRead?.readAt || null,
        isDismissed: userRead?.dismissed || false
      };
    });
    
    res.json(userNotifications);
  } catch (error) {
    console.error("Error fetching user notifications:", error);
    res.status(500).json({ error: error.message });
  }
});

// Mark notification as read for specific user
router.patch('/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    const notificationCollection = db.collection("notifications");
    
    // Check if user already marked it as read
    const notification = await notificationCollection.findOne({ _id: new ObjectId(id) });
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    
    const alreadyRead = notification.readBy?.some(read => read.username === username);
    
    if (!alreadyRead) {
      await notificationCollection.updateOne(
        { _id: new ObjectId(id) },
        { 
          $push: { 
            readBy: {
              username,
              readAt: new Date(),
              dismissed: false
            }
          }
        }
      );
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ error: error.message });
  }
});

// Mark all notifications as read for user
router.patch('/notifications/markall/read', authenticateToken, async (req, res) => {
  try {
    const { username } = req.body;
    const notificationCollection = db.collection("notifications");
    
    // Find all notifications not read by this user
    const unreadNotifications = await notificationCollection.find({
      'readBy.username': { $ne: username }
    }).toArray();
    
    // Mark them all as read
    for (const notification of unreadNotifications) {
      await notificationCollection.updateOne(
        { _id: notification._id },
        { 
          $push: { 
            readBy: {
              username,
              readAt: new Date(),
              dismissed: false
            }
          }
        }
      );
    }
    
    res.json({ success: true, markedCount: unreadNotifications.length });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get unread count for user
router.get('/notifications/:username/unread-count', authenticateToken, async (req, res) => {
  try {
    const { username } = req.params;
    const notificationCollection = db.collection("notifications");
    
    const unreadCount = await notificationCollection.countDocuments({
      'readBy.username': { $ne: username }
    });
    
    res.json({ unreadCount });
  } catch (error) {
    console.error("Error fetching unread count:", error);
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