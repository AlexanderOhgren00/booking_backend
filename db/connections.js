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
  } catch(err) {
    console.error(err);
}

async function run() {
  try {
    const collection = db.collection('months');
  
    // Define the time slots with additional info
    const timeSlots = [
      { "time": "9:30", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "11:00", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "12:30", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "14:00", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "15:30", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "17:00", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "18:30", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "20:00", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null },
      { "time": "21:30", "available": true, "cost": 850, "players": 0, "bookedBy": null, "number": null, "email": null, "info": null, "paymentId": null }
    ];
  
    // Define the categories
    const categories = ["SCHOOL OF MAGIC", "HAUNTED HOTEL", "ARK RAIDER", "SUBMARINE", "JURRASIC EXPERIMENT"];
  
    // Create an example document for October with 31 days
    const octoberSchedule = {
    month: "October",
    days: Array.from({ length: 31 }, (_, i) => ({
      day: i + 1,
      categories: categories.map(category => ({
      name: category,
      times: timeSlots
      }))
    }))
    };
  
    // Insert the document into the collection
    const result = await collection.insertOne(octoberSchedule);
    console.log("Document inserted with _id: ", result.insertedId);
  
  } finally {
    await client.close();
  }
}
  
let db = client.db("Mintescaperoom");

//run().catch(console.dir);

export default db;