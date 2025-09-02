// app.config.js
// Bridge env → Expo extra (build-time). Never commit real secrets to the repo.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Prefer .env.local if present
const envPath = fs.existsSync(path.join(__dirname, '.env.local'))
  ? path.join(__dirname, '.env.local')
  : path.join(__dirname, '.env');

dotenv.config({ path: envPath });

module.exports = {
  expo: {
    name: "Bullish or Bust",
    slug: "bullish-or-bust",
    // Keep all preexisting fields if you already have an app.json/app.config.js; merge instead of clobbering.
    extra: {
      // Merge any existing extra keys here if file already existed
      APCA_API_KEY_ID: process.env.APCA_API_KEY_ID,
      APCA_API_SECRET_KEY: process.env.APCA_API_SECRET_KEY,
      APCA_API_BASE: process.env.APCA_API_BASE || "https://paper-api.alpaca.markets/v2"
    }
  }
};
