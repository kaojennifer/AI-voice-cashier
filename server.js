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

// Write credentials from environment variable if it exists
if (process.env.GOOGLE_CREDENTIALS) {
  fs.writeFileSync('./credentials.json', process.env.GOOGLE_CREDENTIALS);
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Sheets
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const MENU_SHEET_ID = '1NQwSFYRUaiuJBveQsC0EqmBzRgLZx86uCvluOXxhkts';

// Fetch menu from Google Sheets
async function getMenu() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MENU_SHEET_ID,
      range: 'Sheet1!A:F',  // Read columns A through F
    });
    const rows = response.data.values || [];
    const menu = {};
    
    for (let i = 1; i < rows.length; i++) {
      const [item, menuCategory, temperature, size, ounces, price] = rows[i];
      
      if (item && price) {
        const itemLower = item.toLowerCase().trim();
        const priceNum = parseFloat(price.replace('$', ''));
        
        // Skip items with no price (like "Sweetness Levels", "Ice Levels")
        if (isNaN(priceNum) || priceNum === 0) continue;
        
        // If no size (pastries, add-ons), treat as single-item with price
        if (!size || size.trim() === '') {
          menu[itemLower] = priceNum;
        } else {
          // If has size, structure as nested object
          const sizeLower = size.toLowerCase().trim();
          if (!menu[itemLower]) menu[itemLower] = {};
          menu[itemLower][sizeLower] = priceNum;
        }
      }
    }
    console.log('Loaded menu:', JSON.stringify(menu, null, 2));
    return menu;
  } catch (error) {
    console.error('Error fetching menu:', error);
    return {
      "coffee": { "small": 2.50, "medium": 3.00, "large": 3.50 },
      "latte": { "small": 3.50, "medium": 4.00, "large": 4.50 },
    };
  }
}

// Cache menu
let cachedMenu = null;
let lastMenuFetch = 0;
const MENU_CACHE_DURATION = 5 * 60 * 1000;

async function getCachedMenu() {
  const now = Date.now();
  if (!cachedMenu || (now - lastMenuFetch) > MENU_CACHE_DURATION) {
    cachedMenu = await getMenu();
    lastMenuFetch = now;
  }
  return cachedMenu;
}

// Generate order number
function generateOrderNumber() {
  return Math.floor(100 + Math.random() * 900);
}

// Estimate wait time based on pending orders
async function getWaitTime() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const rows = response.data.values || [];
    const pendingOrders = rows.slice(1).filter(row => row[4] === 'pending').length;
    return Math.max(2, pendingOrders * 3);
  } catch (error) {
    return 5;
  }
}

// Process order
app.post('/api/process-order', async (req, res) => {
  try {
    const { audioText, customerName } = req.body;
    const menu = await getCachedMenu();
    const orderNumber = generateOrderNumber();
    const waitTime = await getWaitTime();

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a friendly NYC coffee shop cashier. Parse customer orders and return ONLY a valid JSON object.

MENU STRUCTURE:
- Drinks (coffee, latte, tea, etc.) have sizes: small/large or 12oz/16oz
- Pastries and food items don't have sizes - just the item name
- For items WITH sizes: {"item": "latte", "size": "large", "price": 5.00}
- For items WITHOUT sizes: {"item": "chocolate croissant", "price": 4.00}

CRITICAL RULES:
1. If customer requests items NOT on the menu, return EMPTY items array: {"items": [], "total": 0, "response": "I'm sorry, we don't have [item] on our menu. Is there anything else you'd like to order?"}
2. ONLY include items that exist in the menu
3. If ALL items are unavailable, items MUST be empty array

Valid order format:
{
  "items": [{"item": "latte", "size": "large", "price": 5.00}],
  "total": 5.00,
  "response": "Got it! One large latte. That'll be $5.00. Your order number is #${orderNumber}. Estimated wait: ${waitTime} minutes!"
}

Unavailable item format:
{
  "items": [],
  "total": 0,
  "response": "I'm sorry, we don't have sodas on our menu. Is there anything else you'd like to order?"
}

Current menu: ${JSON.stringify(menu)}
CRITICAL: Return ONLY valid JSON. No text before or after. Put all conversation in the "response" field.`
        },
        { role: "user", content: audioText }
      ],
      temperature: 0.3,
    });

    let orderData;
    try {
      orderData = JSON.parse(completion.choices[0].message.content);
    } catch (parseError) {
      const text = completion.choices[0].message.content;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        orderData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse OpenAI response as JSON');
      }
    }

    // Check if order has valid items before saving
    if (!orderData.items || orderData.items.length === 0 || orderData.total === 0) {
      // Don't save empty/invalid orders to Google Sheets
      return res.json({ 
        response: orderData.response,
        orderNumber: null,
        waitTime: null,
        items: [],
        total: 0
      });
    }

    // Save to Google Sheets only if order is valid
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          customerName || 'Guest',
          JSON.stringify(orderData.items),
          orderData.total,
          'pending',
          orderNumber
        ]]
      }
    });

    res.json({ ...orderData, orderNumber, waitTime });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const rows = response.data.values || [];
    const orders = rows.slice(1).map(row => ({
      timestamp: row[0],
      customerName: row[1],
      items: JSON.parse(row[2] || '[]'),
      total: parseFloat(row[3]),
      status: row[4] || 'pending',
      orderNumber: row[5] || 'N/A'
    }));
    res.json(orders);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Update order status (for barista view)
app.post('/api/update-order-status', async (req, res) => {
  try {
    const { rowIndex, status } = req.body;
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Sheet1!E${rowIndex + 2}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Get menu
app.get('/api/menu', async (req, res) => {
  try {
    const menu = await getCachedMenu();
    res.json(menu);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});