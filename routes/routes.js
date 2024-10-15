import express from "express";
import { ObjectId } from "mongodb";
import db from "../db/connections.js";

const router = express.Router();
const key = process.env.NETS_KEY;

router.post("/v1/payments", async (req, res) => {
    console.log(req.body)
    try {
      const product = req.body;
      console.log(product);
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
    console.log(req.body);
    res.status(200).send("Event received");
  } catch (error) {
    console.error(error);
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

router.get("/months", async (req, res) => {
    let collections = db.collection("months")
    let result = await collections.find({}).toArray();
    res.json(result); 
});

router.patch("/checkout", async (req, res) => {
    const { month, day, category, time, available, bookedBy } = req.body;
    
    try {
        let collections = db.collection("months");
        let result = await collections.updateOne(
          { "month": month, "days.day": day, "days.categories.name": category, "days.categories.times.time": time},
          { $set: {"days.$[day].categories.$[category].times.$[time].available": available, "days.$[day].categories.$[category].times.$[time].bookedBy": bookedBy}},
          { arrayFilters: [{ "day.day": day }, { "category.name": category }, { "time.time": time }] }
        );
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

export default router;