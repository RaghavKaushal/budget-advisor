require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

const dbPath = process.env.DATABASE_PATH || './db/budget.db';
const db = new Database(dbPath);

// Session store using SQLite (persists across restarts)
const sessionDb = new Database(process.env.SESSION_DB_PATH || './db/sessions.db');

app.use(express.json());

// Trust proxy for Railway/production (needed for secure cookies behind proxy)
if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,
      intervalMs: 900000 // Clear expired sessions every 15 min
    }
  }),
  secret: process.env.SESSION_SECRET || 'budget-advisor-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProduction, // true for HTTPS in production
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax', // 'none' needed for cross-site in production
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

// Database schema - Email OTP based auth
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    otp TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT,
    on_behalf_of TEXT,
    is_amortized INTEGER DEFAULT 0,
    amortization_months INTEGER,
    amortization_start TEXT,
    source TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
`);

const defaultCategories = [
  'Food & Dining', 'Groceries', 'Transportation', 'Utilities', 'Rent/EMI',
  'Entertainment', 'Shopping', 'Healthcare', 'Subscriptions', 'Travel',
  'Education', 'Personal Care', 'Gifts', 'Insurance', 'Investments', 'Other'
];

const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
defaultCategories.forEach(cat => insertCategory.run(cat));

const anthropic = process.env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please login first' });
  }
  next();
}

// ============ AUTH ROUTES (Email OTP) ============

app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    // Delete old unused OTPs for this email
    db.prepare('DELETE FROM otps WHERE email = ? AND used = 0').run(normalizedEmail);
    
    // Generate new OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
    
    // Store OTP
    db.prepare('INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)')
      .run(normalizedEmail, otp, expiresAt);
    
    // Check if Resend API key exists
    if (process.env.RESEND_API_KEY) {
      // Send email via Resend
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM || 'Budget Advisor <onboarding@resend.dev>',
            to: normalizedEmail,
            subject: 'Your Login OTP - Budget Advisor',
            html: `
              <h2>Your OTP for Budget Advisor</h2>
              <p style="font-size: 32px; font-weight: bold; color: #6c5ce7; letter-spacing: 5px;">${otp}</p>
              <p>This OTP expires in 10 minutes.</p>
              <p>If you didn't request this, please ignore this email.</p>
            `
          })
        });
        
        if (response.ok) {
          res.json({ message: 'OTP sent to your email', email: normalizedEmail });
        } else {
          throw new Error('Failed to send email');
        }
      } catch (emailError) {
        console.error('Email error:', emailError);
        // Fallback: return OTP in response (dev mode)
        res.json({ 
          message: 'OTP generated (email failed, showing here)', 
          email: normalizedEmail,
          otp: otp, // DEV MODE: Remove in production!
          devMode: true
        });
      }
    } else {
      // No email service configured - DEV MODE
      console.log(`\n📧 OTP for ${normalizedEmail}: ${otp}\n`);
      res.json({ 
        message: 'OTP generated', 
        email: normalizedEmail,
        otp: otp, // DEV MODE: Shows OTP in response
        devMode: true
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp, name } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    // Find valid OTP
    const otpRecord = db.prepare(`
      SELECT * FROM otps 
      WHERE email = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(normalizedEmail, otp);
    
    if (!otpRecord) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    
    // Mark OTP as used
    db.prepare('UPDATE otps SET used = 1 WHERE id = ?').run(otpRecord.id);
    
    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    
    if (!user) {
      // New user - create account
      const result = db.prepare('INSERT INTO users (email, name) VALUES (?, ?)')
        .run(normalizedEmail, name || normalizedEmail.split('@')[0]);
      user = { id: result.lastInsertRowid, email: normalizedEmail, name: name || normalizedEmail.split('@')[0] };
    }
    
    // Set session
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userName = user.name;
    
    res.json({ 
      message: 'Login successful', 
      user: { id: user.id, email: user.email, name: user.name },
      isNewUser: !user.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const { name } = req.body;
  
  try {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.session.userId);
    req.session.userName = name;
    res.json({ message: 'Profile updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ AI CATEGORIZATION ============

async function categorizeWithAI(transactions) {
  if (!anthropic) {
    return transactions.map(t => ({ ...t, category: 'Other' }));
  }

  const prompt = `Categorize these Indian bank transactions into one of these categories:
${defaultCategories.join(', ')}

Transactions:
${transactions.map((t, i) => `${i + 1}. ${t.description} - ₹${t.amount}`).join('\n')}

Respond with ONLY a JSON array of category names in the same order, like: ["Food & Dining", "Shopping", ...]
No explanation, just the JSON array.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0].text.trim();
    const categories = JSON.parse(content);
    return transactions.map((t, i) => ({ ...t, category: categories[i] || 'Other' }));
  } catch (error) {
    console.error('AI categorization failed:', error.message);
    return transactions.map(t => ({ ...t, category: 'Other' }));
  }
}

function parseTransactionsFromText(text, source) {
  const transactions = [];
  const lines = text.split('\n');
  
  const patterns = [
    /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s+(.+?)\s+(?:Rs\.?|₹|INR)\s*([\d,]+\.?\d*)/gi,
    /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s+(.+?)\s+([\d,]+\.?\d*)\s*(?:Dr|Cr)?/gi,
    /(\d{1,2}\s+\w{3}\s+\d{2,4})\s+(.+?)\s+(?:Rs\.?|₹|INR)?\s*([\d,]+\.?\d*)/gi,
  ];

  const seenDescriptions = new Set();

  for (const line of lines) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        const description = match[2].trim();
        const amount = parseFloat(match[3].replace(/,/g, ''));
        
        if (amount > 0 && description.length > 2 && !seenDescriptions.has(description)) {
          seenDescriptions.add(description);
          
          let dateStr = match[1];
          let parsedDate;
          try {
            const parts = dateStr.split(/[-\/\s]+/);
            if (parts.length >= 3) {
              let year = parts[2].length === 2 ? '20' + parts[2] : parts[2];
              parsedDate = `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
          } catch {
            parsedDate = new Date().toISOString().split('T')[0];
          }

          transactions.push({
            date: parsedDate || new Date().toISOString().split('T')[0],
            description,
            amount,
            source
          });
        }
        break;
      }
    }
  }

  return transactions;
}

// ============ EXPENSE ROUTES (Protected) ============

app.post('/api/upload-statement', requireAuth, upload.single('statement'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.session.userId;
    const source = req.body.source || 'Bank Statement';
    const filePath = req.file.path;
    
    let text;
    if (req.file.mimetype === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      text = pdfData.text;
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    fs.unlinkSync(filePath);

    const transactions = parseTransactionsFromText(text, source);
    
    if (transactions.length === 0) {
      return res.json({ 
        message: 'No transactions found. You may need to add them manually.',
        transactions: [],
        rawText: text.substring(0, 2000)
      });
    }

    const categorizedTransactions = await categorizeWithAI(transactions);

    const insert = db.prepare(`
      INSERT INTO expenses (user_id, date, description, amount, category, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertedIds = [];
    for (const t of categorizedTransactions) {
      const result = insert.run(userId, t.date, t.description, t.amount, t.category, t.source);
      insertedIds.push(result.lastInsertRowid);
    }

    res.json({
      message: `Successfully imported ${categorizedTransactions.length} transactions`,
      transactions: categorizedTransactions,
      ids: insertedIds
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/expenses', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { date, description, amount, category, on_behalf_of, is_amortized, amortization_months, source } = req.body;
  
  try {
    if (is_amortized && amortization_months > 1) {
      const monthlyAmount = amount / amortization_months;
      const startDate = new Date(date);
      const insertedIds = [];
      
      const insert = db.prepare(`
        INSERT INTO expenses (user_id, date, description, amount, category, on_behalf_of, is_amortized, amortization_months, amortization_start, source)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);

      for (let i = 0; i < amortization_months; i++) {
        const expenseDate = new Date(startDate);
        expenseDate.setMonth(expenseDate.getMonth() + i);
        const dateStr = expenseDate.toISOString().split('T')[0];
        
        const result = insert.run(
          userId,
          dateStr,
          `${description} (${i + 1}/${amortization_months})`,
          monthlyAmount,
          category || 'Subscriptions',
          on_behalf_of || null,
          amortization_months,
          date,
          source || 'Manual'
        );
        insertedIds.push(result.lastInsertRowid);
      }
      
      res.json({ message: `Created ${amortization_months} amortized entries`, ids: insertedIds });
    } else {
      const insert = db.prepare(`
        INSERT INTO expenses (user_id, date, description, amount, category, on_behalf_of, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      const result = insert.run(userId, date, description, amount, category || 'Other', on_behalf_of || null, source || 'Manual');
      res.json({ message: 'Expense added', id: result.lastInsertRowid });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/expenses', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { month, year, on_behalf_of } = req.query;
  
  let query = 'SELECT * FROM expenses WHERE user_id = ?';
  const params = [userId];
  
  if (month && year) {
    query += " AND strftime('%Y-%m', date) = ?";
    params.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  if (on_behalf_of) {
    query += ' AND on_behalf_of = ?';
    params.push(on_behalf_of);
  }
  
  query += ' ORDER BY date DESC';
  
  const expenses = db.prepare(query).all(...params);
  res.json(expenses);
});

app.put('/api/expenses/:id', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { date, description, amount, category, on_behalf_of } = req.body;
  
  try {
    const update = db.prepare(`
      UPDATE expenses 
      SET date = COALESCE(?, date),
          description = COALESCE(?, description),
          amount = COALESCE(?, amount),
          category = COALESCE(?, category),
          on_behalf_of = ?
      WHERE id = ? AND user_id = ?
    `);
    
    update.run(date, description, amount, category, on_behalf_of || null, id, userId);
    res.json({ message: 'Expense updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', requireAuth, (req, res) => {
  const userId = req.session.userId;
  try {
    db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(req.params.id, userId);
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/summary', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { month, year } = req.query;
  const monthStr = `${year}-${month.padStart(2, '0')}`;
  
  const totalExpense = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total 
    FROM expenses 
    WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NULL
  `).get(userId, monthStr);

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) as total 
    FROM expenses 
    WHERE user_id = ? AND strftime('%Y-%m', date) = ?
    GROUP BY category 
    ORDER BY total DESC
  `).all(userId, monthStr);

  const onBehalfOf = db.prepare(`
    SELECT on_behalf_of, SUM(amount) as total 
    FROM expenses 
    WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NOT NULL
    GROUP BY on_behalf_of
  `).all(userId, monthStr);

  const pendingCollection = db.prepare(`
    SELECT on_behalf_of, SUM(amount) as total 
    FROM expenses 
    WHERE user_id = ? AND on_behalf_of IS NOT NULL
    GROUP BY on_behalf_of
  `).all(userId);

  res.json({
    totalExpense: totalExpense.total,
    byCategory,
    onBehalfOf,
    pendingCollection
  });
});

app.get('/api/people', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const people = db.prepare('SELECT DISTINCT on_behalf_of as name FROM expenses WHERE user_id = ? AND on_behalf_of IS NOT NULL').all(userId);
  res.json(people.map(p => p.name));
});

app.get('/api/categories', (req, res) => {
  const categories = db.prepare('SELECT name FROM categories ORDER BY name').all();
  res.json(categories.map(c => c.name));
});

app.get('/api/export', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { month, year } = req.query;
  
  let query = 'SELECT date, description, amount, category, on_behalf_of, source FROM expenses WHERE user_id = ?';
  const params = [userId];
  
  if (month && year) {
    query += " AND strftime('%Y-%m', date) = ?";
    params.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  query += ' ORDER BY date DESC';
  
  const expenses = db.prepare(query).all(...params);
  
  const worksheetData = expenses.map(e => ({
    'Date': e.date,
    'Description': e.description,
    'Amount (₹)': e.amount,
    'Category': e.category,
    'On Behalf Of': e.on_behalf_of || '',
    'Source': e.source || ''
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(worksheetData);
  
  ws['!cols'] = [
    { wch: 12 },
    { wch: 40 },
    { wch: 12 },
    { wch: 18 },
    { wch: 15 },
    { wch: 15 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');

  if (month && year) {
    const summary = db.prepare(`
      SELECT category, SUM(amount) as total 
      FROM expenses 
      WHERE user_id = ? AND strftime('%Y-%m', date) = ?
      GROUP BY category
    `).all(userId, `${year}-${month.padStart(2, '0')}`);

    const summaryWs = XLSX.utils.json_to_sheet(summary.map(s => ({
      'Category': s.category,
      'Total (₹)': s.total
    })));
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    const onBehalf = db.prepare(`
      SELECT on_behalf_of, SUM(amount) as total 
      FROM expenses 
      WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NOT NULL
      GROUP BY on_behalf_of
    `).all(userId, `${year}-${month.padStart(2, '0')}`);

    if (onBehalf.length > 0) {
      const onBehalfWs = XLSX.utils.json_to_sheet(onBehalf.map(o => ({
        'Person': o.on_behalf_of,
        'Amount to Collect (₹)': o.total
      })));
      XLSX.utils.book_append_sheet(wb, onBehalfWs, 'To Collect');
    }
  }

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  
  const filename = month && year ? `expenses_${year}_${month}.xlsx` : 'all_expenses.xlsx';
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.listen(PORT, () => {
  console.log(`Budget Advisor running at http://localhost:${PORT}`);
});
