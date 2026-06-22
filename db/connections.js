import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

try {
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(
    "Pinged your deployment. You successfully connected to MongoDB!"
  );
} catch (err) {
  console.error(err);
}

async function run() {
  try {
    const collection = db.collection('bookings');

    // Define the time slots with additional info
    const timeSlot = {
      "available": true,
      "cost": 0,
      "players": 0,
      "bookedBy": null,
      "payed": null,
      "number": null,
      "email": null,
      "info": null,
      "paymentId": null,
      "discount": 0,
      "bookingRef": null,
      "offer": null,
      "baseCost": 850,
    };

    const times = ["09:30", "11:00", "12:30", "14:00", "15:30", "17:00", "18:30", "20:00", "21:30"];
    const categories = ["SCHOOL OF MAGIC", "HAUNTED HOTEL", "ARK RAIDER", "SUBMARINE", "JURRASIC EXPERIMENT"];
    
    // Create flattened documents for better querying
    const bookings = [];
    const year = 2026;
    const months = [
      { name: "January", days: 31 },
      { name: "February", days: 28 },
      { name: "March", days: 31 },
      { name: "April", days: 30 },
      { name: "May", days: 31 },
      { name: "June", days: 30 },
      { name: "July", days: 31 },
      { name: "August", days: 31 },
      { name: "September", days: 30 },
      { name: "October", days: 31 },
      { name: "November", days: 30 },
      { name: "December", days: 31 }
    ];

    // Create flattened structure
    months.forEach(month => {
      for (let day = 1; day <= month.days; day++) {
        categories.forEach(category => {
          times.forEach(time => {
            bookings.push({
              year,
              month: month.name,
              day,
              category,
              time,
              ...timeSlot,
              // Add compound index fields for faster queries
              dateString: `${year}-${month.name}-${day}`,
              timeSlotId: `${year}-${month.name}-${day}-${category}-${time}`
            });
          });
        });
      }
    });

    // Create indexes for common queries
    await collection.createIndex({ timeSlotId: 1 });
    await collection.createIndex({ dateString: 1 });
    await collection.createIndex({ year: 1, month: 1, day: 1 });
    await collection.createIndex({ available: 1 });
    await collection.createIndex({ category: 1 });
    
    // Composite indexes for bulk discount operations
    await collection.createIndex({ year: 1, month: 1, day: 1, category: 1, time: 1, available: 1 });
    await collection.createIndex({ category: 1, time: 1, available: 1 });
    await collection.createIndex({ available: 1, category: 1, time: 1 });

    // Insert all bookings
    const result = await collection.insertMany(bookings);
    console.log(`${result.insertedCount} bookings inserted`);

  } finally {
    await client.close();
  }
}

let db = client.db("Mintescaperoom");

//run().catch(console.dir);
//mongodb+srv://alexanderneurasite:vrLUEvVaSHgWkabl@cluster0.0zreakw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0

// Ensure the indexes that back the hot public read paths exist on every boot.
// createIndex is idempotent: it is a no-op if the index already exists, so this
// is safe to run on each deploy and does not change any query results — it only
// guarantees the booking-slot query uses an index scan instead of a collection scan.
//   - { year, month, day }  backs GET /bookings/:year/:month/:day  (booking grid)
//   - { timeSlotId }        backs GET /booking/:timeSlotId          (checkout re-check)
async function ensureIndexes() {
  try {
    const bookings = db.collection("bookings");
    await bookings.createIndex({ year: 1, month: 1, day: 1 });
    await bookings.createIndex({ timeSlotId: 1 });
    console.log("Ensured booking read-path indexes (year/month/day, timeSlotId)");
  } catch (err) {
    // Never let index maintenance crash the server; queries still work without it.
    console.error("Failed to ensure booking indexes:", err.message);
  }
}

ensureIndexes();

export default db;