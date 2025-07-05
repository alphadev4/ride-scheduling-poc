# Ride Booking System with WhatsApp & Google Calendar

System for ride booking with driver confirmation via WhatsApp and automatic Google Calendar scheduling.

## 🔄 Complete Workflow

### 1. **Ride Request Created**
- User/System creates ride via API

### 2. **System proceeds to schedule ride**
```
- Ride scheduled → Status: "scheduled"
- Conflict detected → Status: "rejected"
```

### 3. **Final Confirmation**
- User receives confirmation/rejection notification
- Calendar event created (if accepted)
- Database updated with final status



### Prerequisites

- Node.js 18+
- MongoDB
- Google Cloud Project with Calendar API
- Twilio Account (optional for testing)

### Installation

```bash
# Clone repository
git clone <your-repo-url>
cd ride-booking-system

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

### Environment Configuration

Create `.env` file with:

```env
# Server
PORT=3000
NODE_ENV=development

# MongoDB
MONGODB_URI=mongodb://localhost:27017/ride-booking

# Twilio WhatsApp (optional for testing)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=whatsapp:+14155238886

# Google Calendar
GOOGLE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=primary
```

### Start Application

```bash
npm run dev

```

## 🔧 Google Calendar Setup

### 1. Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project
3. Enable **Google Calendar API**

### 2. Create Service Account
1. Navigate to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **Service Account**
3. Download JSON key file
4. Extract `client_email` and `private_key` for `.env`

### 3. Share Calendar
1. Open Google Calendar
2. Go to calendar settings
3. Share with service account email
4. Grant **"Make changes to events"** permission

## Twilio Setup (Optional)

### For Testing (Mock Mode)
- Set `MOCK_TWILIO = true` in `server.js` (line 18)
- No Twilio account needed

### For Production
1. Create [Twilio Account](https://console.twilio.com/)
2. Set up WhatsApp Sandbox or get approved number
3. Set webhook URL: `https://yourdomain.com/api/whatsapp/webhook`
4. Set `MOCK_TWILIO = false` in `server.js`
5. Uncomment lines 68-73 in `sendTwilioMessage` function

## Testing

### Health Check
```bash
curl http://localhost:3000/health
```

### Basic Flow Test
```bash
# 1. Create ride request
curl -X POST http://localhost:3000/ride/request \
  -H "Content-Type: application/json" \
  -d '{
    "driverPhone": "+923174104964",
    "userPhone": "+923001234567",
    "rideId": "test_001",
    "from": "Downtown",
    "to": "Airport",
    "time": "2025-07-08T15:00:00"
  }'

# 2. Simulate driver accepting
curl -X POST http://localhost:3000/api/whatsapp/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=yes&From=whatsapp:+923174104964"

# 3. Check ride status
curl http://localhost:3000/ride/status/test_001
```

## API Documentation

### Create Ride Request
```http
POST /ride/request
Content-Type: application/json

{
  "driverPhone": "+923174104964",
  "userPhone": "+923001234567", 
  "rideId": "unique_ride_id",
  "from": "Pickup Location",
  "to": "Destination",
  "time": "2025-07-08T15:00:00"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Ride request sent",
  "rideId": "unique_ride_id"
}
```

### Get Ride Status
```http
GET /ride/status/{rideId}
```

**Response:**
```json
{
  "success": true,
  "ride": {
    "rideId": "unique_ride_id",
    "status": "pending|scheduled|rejected|cancelled",
    "from": "Pickup Location",
    "to": "Destination", 
    "time": "2025-07-08T15:00:00Z",
    "driverPhone": "+923174104964",
    "userPhone": "+923001234567",
    "createdAt": "2025-07-05T10:30:00Z"
  }
}
```

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "database": "connected",
  "twilioMode": "mock|real",
  "timestamp": "2025-07-05T10:30:00Z"
}
```

