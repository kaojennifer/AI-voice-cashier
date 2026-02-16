import express from 'express';
import OpenAI from 'openai';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Write credentials from environment variable if it exists (for Railway deployment)
if (process.env.GOOGLE_CREDENTIALS) {
  fs.writeFileSync('./credentials.json', process.env.GOOGLE_CREDENTIALS);
}

// Initialize Google Sheets
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Menu spreadsheet ID
const MENU_SHEET_ID = '1NQwSFYRUaiuJBveQsC0EqmBzRgLZx86uCvluOXxhkts';

// Function to fetch menu from Google Sheets
async function getMenu() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MENU_SHEET_ID,
      range: 'Sheet1!A:C', // Assuming columns: Item, Size, Price
    });

    const rows = response.data.values || [];
    const menu = {};

    // Skip header row and build menu object
    for (let i = 1; i < rows.length; i++) {
      const [item, size, price] = rows[i];
      if (item && size && price) {
        const itemLower = item.toLowerCase().trim();
        const sizeLower = size.toLowerCase().trim();
        const priceNum = parseFloat(price.replace('$', ''));

        if (!menu[itemLower]) {
          menu[itemLower] = {};
        }
        menu[itemLower][sizeLower] = priceNum;
      }
    }

    return menu;
  } catch (error) {
    console.error('Error fetching menu:', error);
    // Fallback menu if Google Sheets fails
    return {
      "coffee": { "small": 2.50, "medium": 3.00, "large": 3.50 },
      "latte": { "small": 3.50, "medium": 4.00, "large": 4.50 },
      "cappuccino": { "small": 3.50, "medium": 4.00, "large": 4.50 },
      "espresso": { "single": 2.00, "double": 3.00 },
    };
  }
}

// Cache menu and refresh every 5 minutes
let cachedMenu = null;
let lastMenuFetch = 0;
const MENU_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCachedMenu() {
  const now = Date.now();
  if (!cachedMenu || (now - lastMenuFetch) > MENU_CACHE_DURATION) {
    cachedMenu = await getMenu();
    lastMenuFetch = now;
  }
  return cachedMenu;
}

// Process order with OpenAI
app.post('/api/process-order', async (req, res) => {
  try {
    const { audioText, customerName } = req.body;
    const menu = await getCachedMenu();

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a friendly NYC coffee shop cashier. Parse customer orders and return ONLY a JSON object with this exact format:
{
  "items": [{"item": "latte", "size": "large", "price": 4.50}],
  "total": 4.50,
  "response": "Got it! One large latte. That'll be $4.50"
}

Current menu with prices: ${JSON.stringify(menu)}

Be conversational but efficient - this is a busy NYC shop. If the customer orders something not on the menu, politely let them know and suggest alternatives. If size is unclear, ask for clarification.`
        },
        {
          role: "user",
          content: audioText
        }
      ],
      temperature: 0.7,
    });

    const orderData = JSON.parse(completion.choices[0].message.content);
    
    // Save to Google Sheets (orders database)
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          customerName || 'Guest',
          JSON.stringify(orderData.items),
          orderData.total,
          'pending'
        ]]
      }
    });

    res.json(orderData);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// Get order history
app.get('/api/orders', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:E',
    });

    const rows = response.data.values || [];
    const orders = rows.slice(1).map(row => ({
      timestamp: row[0],
      customerName: row[1],
      items: JSON.parse(row[2] || '[]'),
      total: parseFloat(row[3]),
      status: row[4]
    }));

    res.json(orders);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get current menu (useful for displaying on frontend)
app.get('/api/menu', async (req, res) => {
  try {
    const menu = await getCachedMenu();
    res.json(menu);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
