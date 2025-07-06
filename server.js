const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const twilio = require("twilio");
const moment = require("moment");
const mongoose = require("mongoose");
require("dotenv").config();
const morgan = require("morgan");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(morgan("dev"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Mock mode for development (change to false for production)
const MOCK_TWILIO = false;

// Twilio configuration
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Google Calendar configuration
const auth = new google.auth.GoogleAuth({
  keyFile: './heroic-grove-465018-h0-626c30a9a60a.json', // Put your JSON file here
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({
  version: "v3",
  auth: auth,
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on("error", (err) => console.error("MongoDB connection error:", err));
db.once("open", () => console.log("Connected to MongoDB"));

const RideSchema = new mongoose.Schema(
  {
    rideId: {
      type: String,
      required: true,
      unique: true,
      default: () => `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    },
    driverPhone: {
      type: String,
      required: true,
      validate: {
        validator: function(v) {
          return /^\+[1-9]\d{1,14}$/.test(v);
        },
        message: 'Invalid phone number format'
      }
    },
    riderPhone: {
      type: String,
      required: true,
      validate: {
        validator: function(v) {
          return /^\+[1-9]\d{1,14}$/.test(v);
        },
        message: 'Invalid phone number format'
      }
    },
    from: {
      type: String,
      required: true,
      trim: true,
      maxLength: 200
    },
    to: {
      type: String,
      required: true,
      trim: true,
      maxLength: 200
    },
    requestedTime: {
      type: Date,
      required: true
    },
    status: {
      type: String,
      enum: ["auto_accepted", "auto_rejected", "completed", "cancelled"],
      required: true
    },
    rejectionReason: {
      type: String,
      enum: ["driver_conflict", "rider_conflict", "system_error"],
      default: undefined
    },
    estimatedDuration: {
      type: Number,
      default: 60,
      min: 15,
      max: 480
    },
    googleEventId: {
      type: String,
      default: null
    },
    conflictDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: []
    },
    processedAt: {
      type: Date,
      default: Date.now
    }
  },
  { 
    timestamps: true
  }
);

const ConversationSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return /^\+[1-9]\d{1,14}$/.test(v);
      },
      message: 'Invalid phone number format'
    }
  },
  step: {
    type: String,
    enum: ['waiting_for_from', 'waiting_for_to', 'waiting_for_time', 'waiting_for_duration', 'waiting_for_driver', 'completed'],
    default: 'waiting_for_from'
  },
  rideData: {
    from: { type: String, default: null },
    to: { type: String, default: null },
    time: { type: String, default: null },
    estimatedDuration: { type: Number, default: null }, // Add this line
    driverPhone: { type: String, default: null }
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

ConversationSchema.index({ lastMessageAt: 1 }, { expireAfterSeconds: 1800 });

const Conversation = mongoose.model('Conversation', ConversationSchema);

const UserSchema = new mongoose.Schema({
  phone: { 
    type: String, 
    required: true, 
    unique: true,
    validate: {
      validator: function(v) {
        return /^\+[1-9]\d{1,14}$/.test(v);
      },
      message: 'Invalid phone number format'
    }
  },
  name: { type: String, default: "" },
  userType: { type: String, enum: ["rider", "driver"], default: "rider" },
  totalRides: { type: Number, default: 0 },
  lastRideAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Indexes
RideSchema.index({ driverPhone: 1, requestedTime: 1 });
RideSchema.index({ riderPhone: 1, requestedTime: 1 });
RideSchema.index({ status: 1 });
RideSchema.index({ rideId: 1 });

if (mongoose.models.Ride) {
  delete mongoose.models.Ride;
}
if (mongoose.models.User) {
  delete mongoose.models.User;
}

const Ride = mongoose.model("Ride", RideSchema);
const User = mongoose.model("User", UserSchema);

async function sendNotification(to, message) {
  if (MOCK_TWILIO) {
    console.log(`MOCK MESSAGE TO ${to}:`);
    console.log(message);
    console.log("---");
  } else {
    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: to,
      });
      console.log(`Message sent to ${to}`);
    } catch (error) {
      console.error(`Failed to send message to ${to}:`, error);
    }
  }
}

async function checkCalendarConflicts(driverPhone, riderPhone, requestedTime, duration = 60) {
  try {
    const startTime = moment(requestedTime);
    const endTime = moment(requestedTime).add(duration, "minutes");
    
    // Check 30 minutes before and after for conflicts
    const searchStart = startTime.clone().subtract(30, "minutes");
    const searchEnd = endTime.clone().add(30, "minutes");

    console.log(`Checking conflicts from ${searchStart.format()} to ${searchEnd.format()}`);

    // 1. Check Google Calendar for driver conflicts
    let calendarConflicts = [];
    try {
      // Use "primary" calendar or your specific calendar ID
      const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
      console.log(`Using calendar ID: ${calendarId}`);
      
      const response = await calendar.events.list({
        calendarId: calendarId,
        timeMin: searchStart.toISOString(),
        timeMax: searchEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      calendarConflicts = response.data.items || [];
      console.log(`Google Calendar: ${calendarConflicts.length} events found`);
    } catch (error) {
      console.error("Calendar API error:", error.message);
      console.log("Continuing without calendar check...");
      // Don't fail the whole process - continue without calendar check
    }

    // 2. Check existing rides for BOTH driver and rider
    const existingRides = await Ride.find({
      $or: [
        { driverPhone: driverPhone },
        { riderPhone: riderPhone }
      ],
      status: { $in: ["auto_accepted", "completed"] },
      requestedTime: {
        $gte: searchStart.toDate(),
        $lte: searchEnd.toDate()
      }
    });

    console.log(`Existing rides: ${existingRides.length} found`);

    // 3. Determine conflict details
    const conflicts = [];
    
    // Calendar conflicts (driver)
    calendarConflicts.forEach(event => {
      conflicts.push({
        type: "driver_calendar",
        eventTitle: event.summary || "Busy",
        eventTime: event.start?.dateTime || event.start?.date,
        details: `Driver has: ${event.summary || "appointment"}`
      });
    });

    // Existing ride conflicts
    existingRides.forEach(ride => {
      if (ride.driverPhone === driverPhone) {
        conflicts.push({
          type: "driver_conflict",
          eventTitle: `Ride: ${ride.from} → ${ride.to}`,
          eventTime: ride.requestedTime,
          details: `Driver already has ride: ${ride.from} → ${ride.to}`
        });
      }
      if (ride.riderPhone === riderPhone) {
        conflicts.push({
          type: "rider_conflict", 
          eventTitle: `Ride: ${ride.from} → ${ride.to}`,
          eventTime: ride.requestedTime,
          details: `Rider already has ride: ${ride.from} → ${ride.to}`
        });
      }
    });

    const hasConflict = conflicts.length > 0;
    const rejectionReason = conflicts.some(c => c.type.includes('rider')) ? 'rider_conflict' :
                           conflicts.some(c => c.type.includes('driver')) ? 'driver_conflict' : null;

    console.log(`Conflict check result: ${hasConflict ? 'CONFLICTS FOUND' : 'NO CONFLICTS'}`);
    if (hasConflict) {
      console.log(`Conflicts:`, conflicts.map(c => c.details));
    }

    return {
      hasConflict,
      rejectionReason,
      conflicts,
      summary: hasConflict ? 
        `Found ${conflicts.length} conflict(s): ${conflicts.map(c => c.details).join(', ')}` :
        'No conflicts detected'
    };

  } catch (error) {
    console.error("Error checking conflicts:", error);
    return {
      hasConflict: true,
      rejectionReason: 'system_error',
      conflicts: [],
      summary: 'System error during conflict check'
    };
  }
}

async function createCalendarEvent(ride) {
  try {
    const startTime = moment(ride.requestedTime);
    const endTime = startTime.clone().add(ride.estimatedDuration, "minutes");

    const event = {
      summary: `RIDE: ${ride.from} → ${ride.to}`,
      description: `AUTO-BOOKED RIDE\n\nDriver: ${ride.driverPhone}\nRider: ${ride.riderPhone}\nRide ID: ${ride.rideId}\nDuration: ${ride.estimatedDuration} min\n\nThis ride was automatically scheduled by the system.`,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: "Asia/Karachi",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: "Asia/Karachi",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'popup', minutes: 10 },
          { method: 'popup', minutes: 5 }
        ]
      },
      colorId: '10' // Green for auto-accepted rides
    };

    // Use same calendar ID as in conflict check
    const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
    console.log(`Creating event in calendar: ${calendarId}`);

    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
    });

    console.log(`Calendar event created: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error("Error creating calendar event:", error.message);
    throw error;
  }
}

// Send automated notifications
async function sendAutomatedNotifications(ride, conflictResult) {
  try {
    const formattedTime = moment(ride.requestedTime).format("MMMM Do YYYY, h:mm A");
    
    if (ride.status === "auto_accepted") {
      // SUCCESS MESSAGES
      const riderMessage = `RIDE AUTO-CONFIRMED!\n\nYour ride has been automatically booked:\n\n📍 From: ${ride.from}\n📍 To: ${ride.to}\nTime: ${formattedTime}\n🚗 Driver: ${ride.driverPhone}\nRide ID: ${ride.rideId}`;
      

      await sendNotification(`whatsapp:${ride.riderPhone}`, riderMessage);
      
    } else if (ride.status === "auto_rejected") {
      const riderMessage = `RIDE AUTO-REJECTED\n\nSorry, your ride request was automatically rejected:\n\n📍 From: ${ride.from}\n📍 To: ${ride.to}\nRequested: ${formattedTime}\n\nDriver is busy at the requested time. Please choose a different time slot.`;
      
      await sendNotification(`whatsapp:${ride.riderPhone}`, riderMessage);
    }

    console.log(`Automated notifications sent for ride ${ride.rideId} (${ride.status})`);
  } catch (error) {
    console.error("Error sending notifications:", error);
  }
}

// MAIN AUTOMATED BOOKING ENDPOINT
app.post("/ride/request", async (req, res) => {
  try {
    const { driverPhone, riderPhone, from, to, time, estimatedDuration, rideId } = req.body;

    // Basic validation
    if (!driverPhone || !riderPhone || !from || !to || !time) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields: driverPhone, riderPhone, from, to, time" 
      });
    }

    // Phone validation
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(driverPhone) || !phoneRegex.test(riderPhone)) {
      return res.status(400).json({ 
        success: false,
        error: "Invalid phone format. Use international format (+1234567890)" 
      });
    }

    // Future time validation
    if (moment(time).isBefore(moment())) {
      return res.status(400).json({ 
        success: false,
        error: "Ride time must be in the future" 
      });
    }

    const finalRideId = rideId || `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const duration = estimatedDuration || 60;

    console.log(`\nSTEP 1: Checking conflicts...`);
    const conflictResult = await checkCalendarConflicts(driverPhone, riderPhone, time, duration);

    // STEP 2: Auto-decide based on conflicts
    console.log(`\n STEP 2: Auto-processing decision...`);
    let status, googleEventId = null;
    
    if (conflictResult.hasConflict) {
      status = "auto_rejected";
    } else {
      status = "auto_accepted"; 
    }

    // STEP 3: Create ride record
    console.log(`\nSTEP 3: Saving ride to database...`);
    const ride = new Ride({
      rideId: finalRideId,
      driverPhone,
      riderPhone,
      from: from.trim(),
      to: to.trim(),
      requestedTime: moment(time).toDate(),
      status,
      estimatedDuration: duration,
      conflictDetails: conflictResult.conflicts,
      processedAt: new Date()
    });

    // Only set rejectionReason if there's actually a conflict
    if (conflictResult.hasConflict && conflictResult.rejectionReason) {
      ride.rejectionReason = conflictResult.rejectionReason;
    }

    await ride.save();
    console.log(`Ride saved with status: ${status}`);

    // STEP 4: Create calendar event if accepted
    if (status === "auto_accepted") {
      console.log(`\nSTEP 4: Creating calendar event...`);
      try {
        googleEventId = await createCalendarEvent(ride);
        ride.googleEventId = googleEventId;
        await ride.save();
        console.log(`Calendar event created successfully`);
      } catch (calendarError) {
        console.error("Calendar creation failed, but ride still accepted:", calendarError);
      }
    } else {
      console.log(`\nSTEP 4: Skipping calendar (ride rejected)`);
    }

    console.log(`\nSTEP 5: Updating user records...`);
    await User.findOneAndUpdate(
      { phone: riderPhone },
      { 
        phone: riderPhone,
        lastRideAt: status === "auto_accepted" ? new Date() : undefined,
        $inc: { totalRides: status === "auto_accepted" ? 1 : 0 }
      },
      { upsert: true }
    );
    console.log(`Rider record updated`);

    console.log(`\nSTEP 6: Sending notifications...`);
    await sendAutomatedNotifications(ride, conflictResult);

    console.log(`\nSTEP 7: Sending response...`);
    const response = {
      success: true,
      rideId: ride.rideId,
      status: ride.status,
      autoDecision: status === "auto_accepted" ? "ACCEPTED" : "REJECTED",
      requestedTime: ride.requestedTime,
      estimatedDuration: ride.estimatedDuration,
      processedAt: ride.processedAt,
      hasConflicts: conflictResult.hasConflict
    };

    if (status === "auto_accepted") {
      response.message = "Ride automatically accepted and booked!";
      response.calendarEventId = googleEventId;
      console.log(`SUCCESS: Ride ${finalRideId} AUTO-ACCEPTED!`);
      return res.status(200).json(response);
    } else {
      response.message = "Ride automatically rejected due to conflicts";
      response.rejectionReason = conflictResult.rejectionReason;
      response.conflictSummary = conflictResult.summary;
      response.conflicts = conflictResult.conflicts;
      console.log(`REJECTED: Ride ${finalRideId} AUTO-REJECTED!`);
      return res.status(409).json(response);
    }

  } catch (error) {
    console.error("SYSTEM ERROR during automated processing:", error);
    res.status(500).json({ 
      success: false,
      error: "System error during automated ride processing",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get("/ride/status/:rideId", async (req, res) => {
  try {
    const ride = await Ride.findOne({ rideId: req.params.rideId });
    
    if (!ride) {
      return res.status(404).json({ 
        success: false,
        error: "Ride not found" 
      });
    }

    res.json({ 
      success: true,
      ride: {
        rideId: ride.rideId,
        status: ride.status,
        autoDecision: ride.status.replace('auto_', '').toUpperCase(),
        from: ride.from,
        to: ride.to,
        requestedTime: ride.requestedTime,
        estimatedDuration: ride.estimatedDuration,
        driverPhone: ride.driverPhone,
        riderPhone: ride.riderPhone,
        rejectionReason: ride.rejectionReason,
        conflictDetails: ride.conflictDetails,
        googleEventId: ride.googleEventId,
        processedAt: ride.processedAt,
        createdAt: ride.createdAt
      }
    });
  } catch (error) {
    console.error("Error fetching ride:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to get ride status" 
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    const dbStatus = db.readyState === 1 ? "connected" : "disconnected";
    
    let calendarStatus = "unknown";
    try {
      await calendar.calendars.get({ calendarId: "primary" });
      calendarStatus = "connected";
    } catch {
      calendarStatus = "error";
    }

    const stats = {
      totalRides: await Ride.countDocuments(),
      autoAccepted: await Ride.countDocuments({ status: "auto_accepted" }),
      autoRejected: await Ride.countDocuments({ status: "auto_rejected" }),
      completedRides: await Ride.countDocuments({ status: "completed" })
    };
    
    res.json({
      status: "ok",
      mode: "FULLY_AUTOMATED",
      database: dbStatus,
      calendar: calendarStatus,
      twilio: MOCK_TWILIO ? "mock" : "real",
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: "error",
      error: "Health check failed",
      timestamp: new Date().toISOString()
    });
  }
});

async function getOrCreateConversation(phone) {
  let conversation = await Conversation.findOne({ 
    phone: phone, 
    isActive: true 
  });
  
  if (!conversation) {
    conversation = new Conversation({
      phone: phone,
      step: 'waiting_for_from',
      rideData: {}
    });
    await conversation.save();
  }
  
  return conversation;
}

async function updateConversationStep(phone, step, data = {}) {
  const conversation = await Conversation.findOneAndUpdate(
    { phone: phone, isActive: true },
    { 
      step: step,
      $set: Object.keys(data).reduce((acc, key) => {
        acc[`rideData.${key}`] = data[key];
        return acc;
      }, {}),
      lastMessageAt: new Date()
    },
    { new: true }
  );
  
  return conversation;
}

async function processConversationMessage(phone, message) {
  const conversation = await getOrCreateConversation(phone);
  const userMessage = message.trim();
  
  console.log(`Processing message from ${phone}: "${userMessage}" (Step: ${conversation.step})`);
  
  let responseMessage = '';
  let nextStep = conversation.step;
  let updateData = {};
  
  switch (conversation.step) {
    case 'waiting_for_from':
      if (userMessage.toLowerCase().includes('ride') || userMessage.toLowerCase().includes('book')) {
        responseMessage = `🚗 *RIDE BOOKING STARTED*\n\nGreat! I'll help you book a ride.\n\nPlease tell me your *From (Current location)*:`;
        nextStep = 'waiting_for_from';
      } else if (userMessage.length > 2) {
        updateData.from = userMessage;
        responseMessage = `📍 *From (Current location):* ${userMessage}\n\nNow, please tell me your *Destination (Drop-off location)*:`;
        nextStep = 'waiting_for_to';
      } else {
        responseMessage = `Please provide a valid pickup location.\n\n*From (Current location):* Where are you starting from?`;
      }
      break;
      
    case 'waiting_for_to':
      if (userMessage.length > 2) {
        updateData.to = userMessage;
        responseMessage = `📍 *Destination (Drop-off):* ${userMessage}\n\nWhen do you need this ride?\n\n*Time (Departure time):*\nPlease provide:\n- "now" for immediate pickup\n- "today 3:00 PM"\n- "tomorrow 9:00 AM"\n- "Dec 25 2:30 PM"`;
        nextStep = 'waiting_for_time';
      } else {
        responseMessage = `Please provide a valid destination.\n\n*Destination (Drop-off location):* Where would you like to go?`;
      }
      break;
      
    case 'waiting_for_time':
      const timeResult = parseTimeInput(userMessage);
      if (timeResult.success) {
        updateData.time = timeResult.datetime;
        responseMessage = `⏰ *Time (Departure time):* ${moment(timeResult.datetime).format('MMMM Do YYYY, h:mm A')}\n\nHow long do you expect this ride to take?\n\n*Estimated Duration:*\nPlease provide duration in minutes:\n- "30" for 30 minutes\n- "60" for 1 hour\n- "90" for 1.5 hours`;
        nextStep = 'waiting_for_duration';
      } else {
        responseMessage = `⚠️ I couldn't understand the time.\n\n*Time (Departure time):* Please try:\n- "now" for immediate\n- "today 3:00 PM"\n- "tomorrow 9:00 AM"\n- "Dec 25 2:30 PM"`;
      }
      break;
      
    case 'waiting_for_duration':
      const duration = parseDurationInput(userMessage);
      if (duration.success) {
        updateData.estimatedDuration = duration.minutes;
        responseMessage = `⏱️ *Estimated Duration:* ${duration.minutes} minutes\n\nFinally, please provide the driver's phone number:\n\n*Driver Contact:*\nWith country code (e.g., +923001234567)`;
        nextStep = 'waiting_for_driver';
      } else {
        responseMessage = `⚠️ Invalid duration format.\n\n*Estimated Duration:* Please provide duration in minutes:\n- "30" for 30 minutes\n- "60" for 1 hour\n- "90" for 1.5 hours\n- Or just type a number like "45"`;
      }
      break;
      
    case 'waiting_for_driver':
      const phoneRegex = /^\+[1-9]\d{1,14}$/;
      // Extract phone number from message
      const phoneMatch = userMessage.match(/\+[1-9]\d{1,14}/);
      const driverPhone = phoneMatch ? phoneMatch[0] : userMessage;
      
      if (phoneRegex.test(driverPhone)) {
        updateData.driverPhone = driverPhone;
        
        // Now we have all the data - let's book the ride!
        const updatedConversation = await updateConversationStep(phone, 'completed', updateData);
        
        // Show summary before booking
        const summaryMessage = `📋 *BOOKING SUMMARY*\n\n📍 *From:* ${updatedConversation.rideData.from}\n📍 *Destination:* ${updatedConversation.rideData.to}\n⏰ *Time:* ${moment(updatedConversation.rideData.time).format('MMMM Do YYYY, h:mm A')}\n⏱️ *Duration:* ${updatedConversation.rideData.estimatedDuration} minutes\n🚗 *Driver:* ${driverPhone}\n\n⚡ Processing your booking...`;
        
        // Send summary first
        await sendNotification(`whatsapp:${phone}`, summaryMessage);
        
        try {
          // Call your existing booking API internally
          const bookingResult = await bookRideInternal({
            driverPhone: driverPhone,
            riderPhone: phone,
            from: updatedConversation.rideData.from,
            to: updatedConversation.rideData.to,
            time: updatedConversation.rideData.time,
            estimatedDuration: updatedConversation.rideData.estimatedDuration
          });
          
          if (bookingResult.success) {
            responseMessage = `✅ *RIDE BOOKED SUCCESSFULLY!*\n\n🆔 *Ride ID:* ${bookingResult.rideId}\n📍 *From:* ${updatedConversation.rideData.from}\n📍 *To:* ${updatedConversation.rideData.to}\n⏰ *Departure:* ${moment(updatedConversation.rideData.time).format('MMMM Do YYYY, h:mm A')}\n⏱️ *Duration:* ${updatedConversation.rideData.estimatedDuration} minutes\n🚗 *Driver:* ${driverPhone}\n\n🎉 *Status: ${bookingResult.autoDecision}*\n\n${bookingResult.message}\n\nType "ride" to book another ride.`;
          } else {
            responseMessage = `❌ *BOOKING FAILED*\n\n${bookingResult.message}\n\n📋 *Details:*\n${bookingResult.conflictSummary || 'Unknown error'}\n\n💡 Please try booking for a different time or contact the driver directly.\n\nType "ride" to try again.`;
          }
        } catch (error) {
          console.error('Internal booking error:', error);
          responseMessage = `❌ *SYSTEM ERROR*\n\nSorry, there was an error processing your booking. Please try again later.\n\nType "ride" to start over.`;
        }
        
        // Mark conversation as completed
        await Conversation.findOneAndUpdate(
          { phone: phone, isActive: true },
          { isActive: false }
        );
        
        return responseMessage;
      } else {
        responseMessage = `⚠️ Invalid phone number format.\n\n*Driver Contact:* Please provide the driver's phone number with country code.\n\nExample: +923001234567`;
      }
      break;
      
    default:
      responseMessage = `Hello! 👋\n\nSend "ride" or "book ride" to start booking a new ride.\n\nI'll help you book by asking for:\n📍 From (Current location)\n📍 Destination (Drop-off)\n⏰ Time (Departure time)\n⏱️ Estimated Duration\n🚗 Driver Contact`;
      nextStep = 'waiting_for_from';
  }
  
  // Update conversation
  await updateConversationStep(phone, nextStep, updateData);
  
  return responseMessage;
}

function parseDurationInput(input) {
  const inputStr = input.toLowerCase().trim();
  
  try {
    // Extract numbers from the input
    const numberMatch = inputStr.match(/\d+/);
    if (!numberMatch) {
      return { success: false, error: 'No number found' };
    }
    
    const number = parseInt(numberMatch[0]);
    
    // Check for hour indicators
    if (inputStr.includes('hour') || inputStr.includes('hr')) {
      const minutes = number * 60;
      if (minutes >= 15 && minutes <= 480) { // 15 min to 8 hours
        return { success: true, minutes: minutes };
      }
    }
    
    // Check for minute indicators or just number
    if (inputStr.includes('min') || inputStr.includes('minute') || /^\d+$/.test(inputStr.trim())) {
      if (number >= 15 && number <= 480) { // 15 min to 8 hours
        return { success: true, minutes: number };
      }
    }
    
    // Handle decimal hours (e.g., "1.5 hours")
    const decimalMatch = inputStr.match(/(\d+\.?\d*)\s*(hour|hr)/);
    if (decimalMatch) {
      const hours = parseFloat(decimalMatch[1]);
      const minutes = Math.round(hours * 60);
      if (minutes >= 15 && minutes <= 480) {
        return { success: true, minutes: minutes };
      }
    }
    
    return { success: false, error: 'Duration out of range (15-480 minutes)' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
// Time parsing helper
function parseTimeInput(input) {
  const now = moment();
  const inputLower = input.toLowerCase().trim();
  
  try {
    // Handle "now" or "immediately"
    if (inputLower.includes('now') || inputLower.includes('immediate')) {
      return { success: true, datetime: now.toISOString() };
    }
    
    // Handle "today" + time
    if (inputLower.includes('today')) {
      const timeStr = inputLower.replace('today', '').trim();
      const time = moment(timeStr, ['h:mm A', 'H:mm', 'h A'], true);
      if (time.isValid()) {
        const today = moment().hour(time.hour()).minute(time.minute()).second(0);
        if (today.isBefore(now)) {
          today.add(1, 'day'); // If time has passed, assume tomorrow
        }
        return { success: true, datetime: today.toISOString() };
      }
    }
    
    // Handle "tomorrow" + time
    if (inputLower.includes('tomorrow')) {
      const timeStr = inputLower.replace('tomorrow', '').trim();
      const time = moment(timeStr, ['h:mm A', 'H:mm', 'h A'], true);
      if (time.isValid()) {
        const tomorrow = moment().add(1, 'day').hour(time.hour()).minute(time.minute()).second(0);
        return { success: true, datetime: tomorrow.toISOString() };
      }
    }
    
    // Try to parse as full date-time
    const formats = [
      'MMMM Do YYYY, h:mm A',
      'MMM Do YYYY, h:mm A', 
      'MM/DD/YYYY h:mm A',
      'DD/MM/YYYY h:mm A',
      'YYYY-MM-DD h:mm A',
      'MMMM Do h:mm A',
      'MMM Do h:mm A',
      'MM/DD h:mm A',
      'DD/MM h:mm A'
    ];
    
    for (const format of formats) {
      const parsed = moment(input, format, true);
      if (parsed.isValid() && parsed.isAfter(now)) {
        return { success: true, datetime: parsed.toISOString() };
      }
    }
    
    return { success: false, error: 'Could not parse time' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Internal booking function (reuses your existing logic)
async function bookRideInternal(rideData) {
  try {
    const { driverPhone, riderPhone, from, to, time, estimatedDuration } = rideData;
    
    // Validate future time
    if (moment(time).isBefore(moment())) {
      return {
        success: false,
        message: "Ride time must be in the future"
      };
    }
    
    const rideId = `ride_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const duration = estimatedDuration || 60; // Use provided duration or default to 60
    
    // Check conflicts (reuse your existing function)
    const conflictResult = await checkCalendarConflicts(driverPhone, riderPhone, time, duration);
    
    // Auto-decide
    const status = conflictResult.hasConflict ? "auto_rejected" : "auto_accepted";
    
    // Create ride record
    const ride = new Ride({
      rideId,
      driverPhone,
      riderPhone,
      from: from.trim(),
      to: to.trim(),
      requestedTime: moment(time).toDate(),
      status,
      estimatedDuration: duration, // Use the actual provided duration
      conflictDetails: conflictResult.conflicts,
      processedAt: new Date()
    });
    
    if (conflictResult.hasConflict && conflictResult.rejectionReason) {
      ride.rejectionReason = conflictResult.rejectionReason;
    }
    
    await ride.save();
    
    // Create calendar event if accepted
    let googleEventId = null;
    if (status === "auto_accepted") {
      try {
        googleEventId = await createCalendarEvent(ride);
        ride.googleEventId = googleEventId;
        await ride.save();
      } catch (calendarError) {
        console.error("Calendar creation failed:", calendarError);
      }
    }
    
    // Update user records
    await User.findOneAndUpdate(
      { phone: riderPhone },
      { 
        phone: riderPhone,
        lastRideAt: status === "auto_accepted" ? new Date() : undefined,
        $inc: { totalRides: status === "auto_accepted" ? 1 : 0 }
      },
      { upsert: true }
    );
    
    return {
      success: true,
      rideId: ride.rideId,
      status: ride.status,
      autoDecision: status === "auto_accepted" ? "ACCEPTED" : "REJECTED",
      message: status === "auto_accepted" ? 
        "Ride automatically accepted and booked!" : 
        "Ride automatically rejected due to conflicts",
      requestedTime: ride.requestedTime,
      estimatedDuration: ride.estimatedDuration,
      calendarEventId: googleEventId,
      hasConflicts: conflictResult.hasConflict,
      rejectionReason: conflictResult.rejectionReason,
      conflictSummary: conflictResult.summary,
      conflicts: conflictResult.conflicts
    };
    
  } catch (error) {
    console.error("Internal booking error:", error);
    return {
      success: false,
      message: "System error during booking",
      error: error.message
    };
  }
}

// WEBHOOK ENDPOINT for WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('WhatsApp webhook received:', JSON.stringify(req.body, null, 2));
    
    // Twilio WhatsApp webhook structure
    const message = req.body.Body;
    const from = req.body.From; // Format: whatsapp:+1234567890
    const to = req.body.To;
    
    if (!message || !from) {
      return res.status(400).send('Invalid webhook data');
    }
    
    // Extract phone number (remove "whatsapp:" prefix)
    const phoneNumber = from.replace('whatsapp:', '');
    
    console.log(`Processing WhatsApp message from ${phoneNumber}: "${message}"`);
    
    // Process the conversation
    const responseMessage = await processConversationMessage(phoneNumber, message);
    
    // Send response back via WhatsApp
    await sendNotification(from, responseMessage);
    
    // Respond to Twilio webhook
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).send('Internal server error');
  }
});

// Helper endpoint to check active conversations (for debugging)
app.get('/conversations/active', async (req, res) => {
  try {
    const conversations = await Conversation.find({ isActive: true });
    res.json({ 
      success: true,
      count: conversations.length,
      conversations: conversations.map(c => ({
        phone: c.phone,
        step: c.step,
        rideData: c.rideData,
        lastMessageAt: c.lastMessageAt
      }))
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch conversations' });
  }
});

// Helper endpoint to reset a conversation (for debugging)
app.post('/conversations/reset', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    await Conversation.findOneAndUpdate(
      { phone: phone },
      { isActive: false }
    );
    
    res.json({ success: true, message: 'Conversation reset' });
  } catch (error) {
    console.error('Error resetting conversation:', error);
    res.status(500).json({ success: false, error: 'Failed to reset conversation' });
  }
});

// Update your existing health check to include conversation stats
app.get("/health", async (req, res) => {
  try {
    const dbStatus = db.readyState === 1 ? "connected" : "disconnected";
    
    let calendarStatus = "unknown";
    try {
      await calendar.calendars.get({ calendarId: "primary" });
      calendarStatus = "connected";
    } catch {
      calendarStatus = "error";
    }

    const stats = {
      totalRides: await Ride.countDocuments(),
      autoAccepted: await Ride.countDocuments({ status: "auto_accepted" }),
      autoRejected: await Ride.countDocuments({ status: "auto_rejected" }),
      completedRides: await Ride.countDocuments({ status: "completed" }),
      activeConversations: await Conversation.countDocuments({ isActive: true }),
      totalUsers: await User.countDocuments()
    };
    
    res.json({
      status: "ok",
      mode: "FULLY_AUTOMATED + WHATSAPP",
      database: dbStatus,
      calendar: calendarStatus,
      twilio: MOCK_TWILIO ? "mock" : "real",
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: "error",
      error: "Health check failed",
      timestamp: new Date().toISOString()
    });
  }
});

console.log(`\nWhatsApp Integration Added!`);
console.log(`POST /webhook/whatsapp   - WhatsApp webhook endpoint`);
console.log(`GET  /conversations/active - View active conversations`);

// Start server
app.listen(port, () => {
  console.log(`\n🤖 FULLY AUTOMATED RIDE BOOKING SYSTEM`);
  console.log(`Server running on port ${port}`);
  console.log(`Twilio: ${MOCK_TWILIO ? 'MOCK MODE' : 'LIVE MODE'}`);
  console.log(`Calendar: ${process.env.GOOGLE_CLIENT_EMAIL ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Database: ${process.env.MONGODB_URI ? 'CONNECTED' : 'NOT CONFIGURED'}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`POST /ride/request     - Submit ride (auto-processed)`);
  console.log(`GET  /ride/status/:id  - Check ride status`);
  console.log(`GET  /health           - System health & stats`);
});

module.exports = app;