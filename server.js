import express from 'express';
import OpenAI from 'openai';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ElevenLabsClient } from 'elevenlabs';
import { Readable } from 'stream';

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

// Initialize ElevenLabs
const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY
});

// Initialize Google Sheets
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const MENU_SHEET_ID = '1NQwSFYRUaiuJBveQsC0EqmBzRgLZx86uCvluOXxhkts';

// In-memory conversation state storage (in production, use Redis or DB)
const conversationStates = new Map();

// Fetch menu from Google Sheets
async function getMenu() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: MENU_SHEET_ID,
      range: 'Sheet1!A:F',
    });
    const rows = response.data.values || [];
    const menu = {};
    
    for (let i = 1; i < rows.length; i++) {
      const [item, menuCategory, temperature, size, ounces, price] = rows[i];
      
      if (item && price) {
        const itemLower = item.toLowerCase().trim();
        const priceNum = parseFloat(price.replace('$', ''));
        
        if (isNaN(priceNum) || priceNum === 0) continue;
        
        if (!size || size.trim() === '') {
          menu[itemLower] = priceNum;
        } else {
          const sizeLower = size.toLowerCase().trim();
          if (!menu[itemLower]) menu[itemLower] = {};
          menu[itemLower][sizeLower] = priceNum;
        }
      }
    }
    console.log('Loaded menu items:', Object.keys(menu).length);
    return menu;
  } catch (error) {
    console.error('Error fetching menu:', error);
    return {};
  }
}

let cachedMenu = null;
let lastMenuFetch = 0;
const MENU_CACHE_DURATION = 60 * 60 * 1000; // 1 hour instead of 5 minutes

async function getCachedMenu() {
  const now = Date.now();
  if (!cachedMenu || (now - lastMenuFetch) > MENU_CACHE_DURATION) {
    cachedMenu = await getMenu();
    lastMenuFetch = now;
  }
  return cachedMenu;
}

function generateOrderNumber() {
  return Math.floor(100 + Math.random() * 900);
}

// Conversation state management
function getConversationState(sessionId) {
  if (!conversationStates.has(sessionId)) {
    conversationStates.set(sessionId, {
      orderItems: [],
      currentItem: null,
      conversationHistory: [],
      lastActivity: Date.now()
    });
  }
  const state = conversationStates.get(sessionId);
  state.lastActivity = Date.now();
  return state;
}

// Clean up old conversations (older than 30 minutes)
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30 * 60 * 1000; // 30 minutes
  for (const [sessionId, state] of conversationStates.entries()) {
    if (now - state.lastActivity > TIMEOUT) {
      conversationStates.delete(sessionId);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// Multi-turn conversation endpoint for VOICE orders
app.post('/api/conversation-turn', async (req, res) => {
  try {
    const { sessionId, userMessage, customerName, mode = 'text' } = req.body; // Default to text mode
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }

    const state = getConversationState(sessionId);
    const menu = await getCachedMenu();
    
    // Add user message to history
    state.conversationHistory.push({ role: 'user', content: userMessage });
    
    // Build conversation prompt
    const systemPrompt = `You are a friendly NYC coffee shop voice assistant named Eryn. You're having a natural conversation with a customer to take their order.

CONVERSATION RULES:
1. Ask ONE clarifying question at a time (size, temperature, milk, modifications)
2. Be conversational and natural - like talking to a friend
3. Remember what they've already told you
4. When an item is complete, ask "Anything else?" or confirm and move to next item
5. Validate against impossible requests (no hot frappuccinos, max 6 shots, etc.)

MENU: ${JSON.stringify(menu)}

CURRENT ORDER STATE:
- Items completed: ${JSON.stringify(state.orderItems)}
- Current item being configured: ${JSON.stringify(state.currentItem)}

RESPONSE FORMAT - Return JSON:
{
  "reply": "Your natural conversational response here",
  "needsMoreInfo": true/false,
  "orderComplete": false,
  "currentItem": {item details if being built},
  "action": "ask_size" | "ask_temperature" | "ask_milk" | "ask_modifications" | "add_item" | "finalize_order" | "invalid_request"
}

EXAMPLES:
User: "I want a latte"
Response: {"reply": "Great choice! Would you like that small or large?", "needsMoreInfo": true, "action": "ask_size", "currentItem": {"item": "latte"}}

User: "Large"
Response: {"reply": "Perfect! Hot or iced?", "needsMoreInfo": true, "action": "ask_temperature", "currentItem": {"item": "latte", "size": "large"}}

User: "Hot with oat milk"
Response: {"reply": "One large hot latte with oat milk. Anything else?", "needsMoreInfo": false, "action": "add_item", "currentItem": {"item": "latte", "size": "large", "temperature": "hot", "milk": "oat"}}

User: "That's it"
Response: {"reply": "Perfect! Your total is $5.00. I'll have that ready for you in about 3 minutes!", "needsMoreInfo": false, "orderComplete": true, "action": "finalize_order"}`;

    // Call OpenAI for conversation management
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",  // Changed from gpt-4 to gpt-4o for JSON support
      messages: [
        { role: "system", content: systemPrompt },
        ...state.conversationHistory
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const aiResponse = JSON.parse(completion.choices[0].message.content);
    
    // Update conversation state based on AI response
    if (aiResponse.currentItem) {
      state.currentItem = aiResponse.currentItem;
    }
    
    if (aiResponse.action === 'add_item' && state.currentItem) {
      // Calculate price for the item
      const itemName = state.currentItem.item.toLowerCase();
      const size = state.currentItem.size?.toLowerCase();
      
      let price = 0;
      if (menu[itemName]) {
        if (typeof menu[itemName] === 'number') {
          price = menu[itemName];
        } else if (size && menu[itemName][size]) {
          price = menu[itemName][size];
        }
      }
      
      state.orderItems.push({ ...state.currentItem, price });
      state.currentItem = null;
    }
    
    // Generate audio ONLY for voice mode with error handling
    let audioBuffer = null;
    if (mode === 'voice') {
      try {
        const audioStream = await elevenlabs.textToSpeech.convert("iP95p4xoKVk53GoZ742B", {
          text: aiResponse.reply,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        });
        
        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(chunk);
        }
        audioBuffer = Buffer.concat(chunks);
      } catch (elevenLabsError) {
        console.error('ElevenLabs error (continuing without audio):', elevenLabsError.message);
        // Continue without audio - conversation still works in text mode
      }
    }
    
    // Save conversation history
    state.conversationHistory.push({ role: 'assistant', content: aiResponse.reply });
    
    // If order is complete, save to Google Sheets
    if (aiResponse.orderComplete && state.orderItems.length > 0) {
      const total = state.orderItems.reduce((sum, item) => sum + (item.price || 0), 0);
      const orderNumber = generateOrderNumber();
      
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:F',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            new Date().toISOString(),
            customerName || 'Guest',
            JSON.stringify(state.orderItems),
            total,
            'pending',
            orderNumber
          ]]
        }
      });
      
      // Clear conversation state after order completion
      conversationStates.delete(sessionId);
      
      return res.json({
        audio: audioBuffer ? audioBuffer.toString('base64') : null,
        reply: aiResponse.reply,
        orderComplete: true,
        orderNumber,
        total,
        items: state.orderItems
      });
    }
    
    res.json({
      audio: audioBuffer ? audioBuffer.toString('base64') : null,
      reply: aiResponse.reply,
      needsMoreInfo: aiResponse.needsMoreInfo,
      orderComplete: false,
      currentItem: state.currentItem
    });
    
  } catch (error) {
    console.error('Conversation error:', error);
    res.status(500).json({ error: 'Failed to process conversation turn' });
  }
});

// Keep existing text-only endpoint for TYPE ordering
app.post('/api/process-order', async (req, res) => {
  try {
    const { audioText, customerName } = req.body;
    const menu = await getCachedMenu();
    const orderNumber = generateOrderNumber();

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a friendly NYC coffee shop cashier. Parse customer orders and return ONLY a valid JSON object.

CRITICAL RULES:
1. If customer requests items NOT on the menu, return EMPTY items array
2. ONLY include items that exist in the menu
3. Size is OPTIONAL for pastries/food items

Menu: ${JSON.stringify(menu)}

Return format:
{
  "items": [{"item": "latte", "size": "large", "price": 5.00}],
  "total": 5.00,
  "response": "Got it! One large latte. That'll be $5.00. Your order number is #${orderNumber}."
}

If unavailable:
{
  "items": [],
  "total": 0,
  "response": "I'm sorry, we don't have that on our menu. Is there anything else you'd like?"
}`
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

    if (!orderData.items || orderData.items.length === 0 || orderData.total === 0) {
      return res.json({ 
        response: orderData.response,
        orderNumber: null,
        items: [],
        total: 0
      });
    }

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

    res.json({ ...orderData, orderNumber });
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

// Update order status
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});