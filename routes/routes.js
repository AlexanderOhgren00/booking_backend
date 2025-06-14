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

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
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
                discount: item.discount,
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
          }
        } catch (updateError) {
          console.error(`❌ Error processing booking reset for ${timeSlotId}:`, updateError);
          console.error(`Error stack:`, updateError.stack);
        }
      }

      // Terminate the payment on the payment provider
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

      // Remove from paymentStates
      console.log(`Removing payment ${paymentId} from paymentStates`);
      delete paymentStates[paymentId];
      console.log(`✅ Removed payment ${paymentId} from paymentStates`);
      console.log(`Current paymentStates after removal:`, Object.keys(paymentStates).length > 0 ? Object.keys(paymentStates) : "No payment states");

      // Broadcast update to all clients
      broadcast({
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
    const backupQueryCondition = {};

    if (lastDate) {
      console.log(`Fetching bookings before date: ${lastDate}`);
      queryCondition.bookedAt = { $lt: lastDate };
      backupQueryCondition.backupCreatedAt = { $lt: lastDate };
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

    // Merge both arrays and sort by date
    const allRecentBookings = [...recentBookings, ...recentBackups]
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

router.post("addbackup", async (req, res) => {
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
    broadcast({
      type: "initialize",
      message: "Update"
    });

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

        const backupCollection = db.collection("backup");
        const backupResult = await backupCollection.deleteMany({ paymentId: paymentId });
        console.log(`✅ Deleted ${backupResult.deletedCount} backup entries for payment ${paymentId}`);

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

router.patch("/MonthBulkTimeChange", async (req, res) => {
  console.log("MonthBulkTimeChange endpoint called with body:", req.body);
  const { updates, minutesToAdd } = req.body;

  if (!updates || !Array.isArray(updates) || !minutesToAdd) {
    console.log("Validation failed:", { updates, minutesToAdd });
    return res.status(400).json({ error: "Updates array and minutesToAdd are required" });
  }

  try {
    const collections = db.collection("bookings");
    const results = [];
    const currentYear = new Date().getFullYear();
    console.log("Starting update process with current year:", currentYear);

    // Get all years from current year up to 2030
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );
    console.log("Years to process:", years);

    for (const update of updates) {
      const { time, category, weekday, month } = update;
      console.log("Processing update:", { time, category, weekday, month });

      // Update specific month for all years
      for (const year of years) {
        console.log(`Processing year ${year} for ${month}`);
        // Get the number of days in this month
        const daysInMonth = new Date(year, MONTHS.indexOf(month) + 1, 0).getDate();
        console.log(`Days in ${month} ${year}: ${daysInMonth}`);

        // Check each day in the month
        for (let day = 1; day <= daysInMonth; day++) {
          // Check if this day matches the selected weekday
          const currentDate = new Date(year, MONTHS.indexOf(month), day);
          if (currentDate.getDay() === weekday) {
            console.log(`Found matching weekday for ${year}-${month}-${day}`);
            // Parse the original time
            const [hours, minutes] = time.split(':').map(Number);
            const originalDate = new Date(year, MONTHS.indexOf(month), day, hours, minutes);

            // Add the specified minutes
            originalDate.setMinutes(originalDate.getMinutes() + parseInt(minutesToAdd));

            // Format the new time as HH:mm
            const newTime = `${String(originalDate.getHours()).padStart(2, '0')}:${String(originalDate.getMinutes()).padStart(2, '0')}`;
            console.log(`Time conversion: ${time} -> ${newTime} (adding ${minutesToAdd} minutes)`);

            // Log the query we're about to execute
            console.log("Executing update query with:", {
              year,
              month,
              day,
              category,
              time,
              newTime
            });

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
                  time: newTime,
                  timeSlotId: `${year}-${month}-${day}-${category}-${newTime}`
                }
              }
            );

            console.log("Update result:", {
              matchedCount: result.matchedCount,
              modifiedCount: result.modifiedCount,
              timeSlot: `${year}-${month}-${day}-${category}-${time}`
            });

            if (result.modifiedCount > 0) {
              results.push({
                timeSlotId: `${year}-${month}-${day}-${category}-${time}`,
                newTimeSlotId: `${year}-${month}-${day}-${category}-${newTime}`,
                success: true
              });
            }
          }
        }
      }
    }

    console.log("Final results:", results);

    // Broadcast the update via WebSocket
    broadcast({
      type: "bulkTimeUpdate",
      data: { updates, minutesToAdd }
    });
    console.log("WebSocket broadcast sent");

    res.json({
      message: "Bulk time change completed",
      results,
      modifiedCount: results.length
    });

  } catch (error) {
    console.error("Error in MonthBulkTimeChange:", error);
    res.status(500).json({ error: "Server error while updating times" });
  }
});

router.patch("/bulk-update-offers", async (req, res) => {
  console.log("=== BULK UPDATE OFFERS ENDPOINT CALLED ===");
  console.log("Request body:", JSON.stringify(req.body, null, 2));
  console.log("Request IP:", req.ip);
  console.log("Request timestamp:", new Date().toISOString());

  const { updates, offerValue } = req.body;

  if (!updates || !Array.isArray(updates) || !offerValue) {
    console.log("❌ VALIDATION FAILED:", { updates, offerValue });
    return res.status(400).json({ error: "Updates array and offerValue are required" });
  }

  console.log(`✅ Validation passed: ${updates.length} updates with offer value ${offerValue}`);

  try {
    const collections = db.collection("bookings");
    const results = [];
    const currentYear = new Date().getFullYear();
    console.log(`🔍 Starting offer update process with current year: ${currentYear}`);
    console.log(`📊 Update summary: ${updates.length} time slots, offer value: ${offerValue} SEK`);

    // Month name to number mapping
    const monthNameToNumber = {
      "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
      "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12
    };

    // Get all years from current year up to 2030
    const years = Array.from(
      { length: 2030 - currentYear + 1 },
      (_, i) => currentYear + i
    );
    console.log(`📅 Years to process: ${years.join(", ")}`);

    // Process each update
    for (const update of updates) {
      const { time, category, weekday, month } = update;

      if (!time || !category || weekday === undefined || !month) {
        console.log(`⚠️ Skipping invalid update:`, JSON.stringify(update));
        continue;
      }

      // Convert month name to number if needed
      let monthNumber = month;
      if (isNaN(month)) {
        monthNumber = monthNameToNumber[month];
        if (!monthNumber) {
          console.log(`⚠️ Invalid month name: ${month}`);
          continue;
        }
      }

      console.log(`🔄 Processing update for category: "${category}" at time: "${time}" on weekday: ${weekday} in month: ${month} (${monthNumber})`);

      // Find all matching bookings across years
      for (const year of years) {
        // Get all days in the specified month that match the weekday
        const daysInMonth = new Date(year, monthNumber, 0).getDate();
        const matchingDays = [];

        for (let day = 1; day <= daysInMonth; day++) {
          const date = new Date(year, monthNumber - 1, day);
          // getDay() returns 0 for Sunday, 1 for Monday, etc.
          if (date.getDay() === weekday) {
            matchingDays.push(day);
          }
        }

        console.log(`📆 Found ${matchingDays.length} matching days in ${month}/${year} for weekday ${weekday}: [${matchingDays.join(", ")}]`);

        // Update each matching day
        for (const day of matchingDays) {
          // Try both formats: numeric month and month name
          const timeSlotIdNumeric = `${year}-${monthNumber}-${day}-${category.trim()}-${time}`;
          const timeSlotIdName = `${year}-${month}-${day}-${category.trim()}-${time}`;

          console.log(`🔍 Looking for timeSlot with numeric month: ${timeSlotIdNumeric}`);
          console.log(`🔍 Looking for timeSlot with month name: ${timeSlotIdName}`);

          // First try with numeric month
          let updateResult = await collections.updateOne(
            { timeSlotId: timeSlotIdNumeric },
            { $set: { offer: offerValue } }
          );

          // If no match, try with month name
          if (updateResult.matchedCount === 0) {
            console.log(`⚠️ No match with numeric month, trying with month name`);
            updateResult = await collections.updateOne(
              { timeSlotId: timeSlotIdName },
              { $set: { offer: offerValue } }
            );
          }

          if (updateResult.matchedCount > 0) {
            const usedTimeSlotId = updateResult.matchedCount > 0 ? timeSlotIdName : timeSlotIdNumeric;
            results.push({
              timeSlotId: usedTimeSlotId,
              success: updateResult.modifiedCount > 0,
              year,
              month,
              day,
              category,
              time,
              offer: offerValue
            });

            console.log(`✅ Updated timeSlot: ${usedTimeSlotId} with discount: ${offerValue} SEK (modified: ${updateResult.modifiedCount > 0 ? "YES" : "NO"})`);
          } else {
            console.log(`❌ No matching booking found for either timeSlot format`);
          }
        }
      }
    }

    console.log(`📊 Update summary: ${results.length} time slots updated out of ${updates.length} requested`);

    // Broadcast the update via WebSocket
    console.log(`📡 Broadcasting update to connected clients`);
    broadcast({
      type: "bulkOfferUpdate",
      data: { updates, offerValue }
    });

    console.log(`✅ Bulk offer update completed successfully`);
    res.json({
      message: "Bulk offer update completed",
      results,
      modifiedCount: results.length
    });

  } catch (error) {
    console.error("❌ ERROR in bulk-update-offers:", error);
    console.error("Stack trace:", error.stack);
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
      console.log(`Resetting discount to 0 for bookings with discount = ${PersonCost}`);

      const bookingsCollection = db.collection("bookings");
      const bookingUpdateResult = await bookingsCollection.updateMany(
        { discount: PersonCost },
        { $set: { discount: 0 } }
      );

      console.log(`Updated ${bookingUpdateResult.modifiedCount} bookings with discount ${PersonCost} to 0`);
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
  const { key, sale, currency, expiryDate, perPlayer, discountType, usedBy } = req.body;

  if (!key || !sale || !currency || !expiryDate) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const collections = db.collection("discounts");

    const discountExist = await collections.findOne({ key });
    if (discountExist) {
      return res.status(400).json({ error: "Discount code already exists" });
    }

    await collections.insertOne({ key, sale, currency, perPlayer, expiryDate, discountType, usedBy });

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
      { $set: { ...updateData, updatedAt: new Date() } }
    );
    res.json(result);
    broadcast({ type: "timeUpdate", message: "Update" });
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

    // Broadcast the update to all connected clients
    broadcast({ type: "timeUpdate", message: "Update" });

    res.json({
      message: "Booking deleted successfully",
      timeSlotId: timeSlotId,
      result
    });

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
    console.error('Error updating times:', error);
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

router.post("/swish-payment-confirmation", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    console.log("No paymentId provided in request");
    return res.status(400).json({ error: "Payment ID is required" });
  }

  if (!paymentStates[paymentId]) {
    return res.json({
      status: "PAID"
    })
  }

  res.json({
    status: "NOT PAID"
  })

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
        const paymentId = req.body.id;

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

        const backupCollection = db.collection("backup");
        const backupResult = await backupCollection.deleteMany({ paymentId: paymentId });
        console.log(`✅ Deleted ${backupResult.deletedCount} backup entries for payment ${paymentId}`);

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
          // Get the customer email and booking details for confirmation email
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

    // Always add payerAlias if it exists and is a string
    if (payerAlias && typeof payerAlias === 'string') {
      paymentData.payerAlias = payerAlias.startsWith('0') ? '46' + payerAlias.slice(1) : payerAlias;
      console.log('Added payerAlias:', paymentData.payerAlias);
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

    // For mobile payments or if status fetch fails
    console.log('Sending final response:', {
      status: response.status,
      paymentRequestToken: response.headers.location,
      instructionUUID,
      paymentType: isMobile ? 'mobile' : 'qr'
    });

    res.status(response.status).json({
      status: response.status,
      paymentRequestToken: response.headers.location,
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
  console.log("=== RESET ALL OFFERS ENDPOINT CALLED ===");
  console.log("Request timestamp:", new Date().toISOString());
  console.log("Request IP:", req.ip);

  try {
    const collections = db.collection("bookings");

    // Update all bookings to reset the offer field
    const result = await collections.updateMany(
      {}, // empty filter to match all documents
      { $set: { offer: null } }
    );

    console.log(`✅ Reset offers for ${result.modifiedCount} bookings out of ${result.matchedCount} total`);

    // Broadcast the update via WebSocket to notify all clients
    broadcast({
      type: "offersReset",
      message: "All offers have been reset"
    });
    console.log("📡 Broadcast sent to notify clients of offer reset");

    res.status(200).json({
      success: true,
      message: "All offers have been reset",
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error("❌ ERROR in reset-all-offers:", error);
    console.error("Stack trace:", error.stack);
    res.status(500).json({
      success: false,
      error: "Server error while resetting offers",
      message: error.message
    });
  }
});

// Gift Card Routes

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

    broadcast({
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