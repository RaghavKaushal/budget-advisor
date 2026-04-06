require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { createClient } = require('@libsql/client');
const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

app.use(express.json());

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'budget-advisor-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

const defaultCategories = [
  'Food & Dining', 'Groceries', 'Transportation', 'Utilities', 'Rent/EMI',
  'Entertainment', 'Shopping', 'Healthcare', 'Subscriptions', 'Travel',
  'Education', 'Personal Care', 'Gifts', 'Insurance', 'Investments', 'Other'
];

async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      otp TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
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
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email)`);

  for (const cat of defaultCategories) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat]
    });
  }
  
  console.log('Database initialized');
}

const anthropic = process.env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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
    await db.execute({
      sql: 'DELETE FROM otps WHERE email = ? AND used = 0',
      args: [normalizedEmail]
    });
    
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    await db.execute({
      sql: 'INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?)',
      args: [normalizedEmail, otp, expiresAt]
    });
    
    if (process.env.RESEND_API_KEY) {
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
        res.json({ 
          message: 'OTP generated (email failed, showing here)', 
          email: normalizedEmail,
          otp: otp,
          devMode: true
        });
      }
    } else {
      console.log(`\n📧 OTP for ${normalizedEmail}: ${otp}\n`);
      res.json({ 
        message: 'OTP generated', 
        email: normalizedEmail,
        otp: otp,
        devMode: true
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp, name } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    const result = await db.execute({
      sql: `SELECT * FROM otps 
            WHERE email = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')
            ORDER BY created_at DESC LIMIT 1`,
      args: [normalizedEmail, otp]
    });
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    
    const otpRecord = result.rows[0];
    
    await db.execute({
      sql: 'UPDATE otps SET used = 1 WHERE id = ?',
      args: [otpRecord.id]
    });
    
    const userResult = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    
    let user;
    if (userResult.rows.length === 0) {
      const insertResult = await db.execute({
        sql: 'INSERT INTO users (email, name) VALUES (?, ?)',
        args: [normalizedEmail, name || normalizedEmail.split('@')[0]]
      });
      user = { id: insertResult.lastInsertRowid, email: normalizedEmail, name: name || normalizedEmail.split('@')[0] };
    } else {
      user = userResult.rows[0];
    }
    
    req.session.userId = Number(user.id);
    req.session.userEmail = user.email;
    req.session.userName = user.name;
    
    res.json({ 
      message: 'Login successful', 
      user: { id: user.id, email: user.email, name: user.name },
      isNewUser: userResult.rows.length === 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  
  const result = await db.execute({
    sql: 'SELECT id, email, name FROM users WHERE id = ?',
    args: [req.session.userId]
  });
  
  res.json({ user: result.rows[0] || null });
});

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  const { name } = req.body;
  
  try {
    await db.execute({
      sql: 'UPDATE users SET name = ? WHERE id = ?',
      args: [name, req.session.userId]
    });
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

    const insertedIds = [];
    for (const t of categorizedTransactions) {
      const result = await db.execute({
        sql: `INSERT INTO expenses (user_id, date, description, amount, category, source)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [userId, t.date, t.description, t.amount, t.category, t.source]
      });
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

app.post('/api/expenses', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { date, description, amount, category, on_behalf_of, is_amortized, amortization_months, source } = req.body;
  
  try {
    if (is_amortized && amortization_months > 1) {
      const monthlyAmount = amount / amortization_months;
      const startDate = new Date(date);
      const insertedIds = [];

      for (let i = 0; i < amortization_months; i++) {
        const expenseDate = new Date(startDate);
        expenseDate.setMonth(expenseDate.getMonth() + i);
        const dateStr = expenseDate.toISOString().split('T')[0];
        
        const result = await db.execute({
          sql: `INSERT INTO expenses (user_id, date, description, amount, category, on_behalf_of, is_amortized, amortization_months, amortization_start, source)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          args: [
            userId,
            dateStr,
            `${description} (${i + 1}/${amortization_months})`,
            monthlyAmount,
            category || 'Subscriptions',
            on_behalf_of || null,
            amortization_months,
            date,
            source || 'Manual'
          ]
        });
        insertedIds.push(result.lastInsertRowid);
      }
      
      res.json({ message: `Created ${amortization_months} amortized entries`, ids: insertedIds });
    } else {
      const result = await db.execute({
        sql: `INSERT INTO expenses (user_id, date, description, amount, category, on_behalf_of, source)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [userId, date, description, amount, category || 'Other', on_behalf_of || null, source || 'Manual']
      });
      res.json({ message: 'Expense added', id: result.lastInsertRowid });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/expenses', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { month, year, on_behalf_of } = req.query;
  
  let sql = 'SELECT * FROM expenses WHERE user_id = ?';
  const args = [userId];
  
  if (month && year) {
    sql += " AND strftime('%Y-%m', date) = ?";
    args.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  if (on_behalf_of) {
    sql += ' AND on_behalf_of = ?';
    args.push(on_behalf_of);
  }
  
  sql += ' ORDER BY date DESC';
  
  const result = await db.execute({ sql, args });
  res.json(result.rows);
});

app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { date, description, amount, category, on_behalf_of } = req.body;
  
  try {
    await db.execute({
      sql: `UPDATE expenses 
            SET date = COALESCE(?, date),
                description = COALESCE(?, description),
                amount = COALESCE(?, amount),
                category = COALESCE(?, category),
                on_behalf_of = ?
            WHERE id = ? AND user_id = ?`,
      args: [date, description, amount, category, on_behalf_of || null, id, userId]
    });
    res.json({ message: 'Expense updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  try {
    await db.execute({
      sql: 'DELETE FROM expenses WHERE id = ? AND user_id = ?',
      args: [req.params.id, userId]
    });
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/summary', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { month, year } = req.query;
  const monthStr = `${year}-${month.padStart(2, '0')}`;
  
  const totalExpenseResult = await db.execute({
    sql: `SELECT COALESCE(SUM(amount), 0) as total 
          FROM expenses 
          WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NULL`,
    args: [userId, monthStr]
  });

  const byCategoryResult = await db.execute({
    sql: `SELECT category, SUM(amount) as total 
          FROM expenses 
          WHERE user_id = ? AND strftime('%Y-%m', date) = ?
          GROUP BY category 
          ORDER BY total DESC`,
    args: [userId, monthStr]
  });

  const onBehalfOfResult = await db.execute({
    sql: `SELECT on_behalf_of, SUM(amount) as total 
          FROM expenses 
          WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NOT NULL
          GROUP BY on_behalf_of`,
    args: [userId, monthStr]
  });

  const pendingCollectionResult = await db.execute({
    sql: `SELECT on_behalf_of, SUM(amount) as total 
          FROM expenses 
          WHERE user_id = ? AND on_behalf_of IS NOT NULL
          GROUP BY on_behalf_of`,
    args: [userId]
  });

  res.json({
    totalExpense: totalExpenseResult.rows[0]?.total || 0,
    byCategory: byCategoryResult.rows,
    onBehalfOf: onBehalfOfResult.rows,
    pendingCollection: pendingCollectionResult.rows
  });
});

app.get('/api/people', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const result = await db.execute({
    sql: 'SELECT DISTINCT on_behalf_of as name FROM expenses WHERE user_id = ? AND on_behalf_of IS NOT NULL',
    args: [userId]
  });
  res.json(result.rows.map(p => p.name));
});

app.get('/api/categories', async (req, res) => {
  const result = await db.execute('SELECT name FROM categories ORDER BY name');
  res.json(result.rows.map(c => c.name));
});

app.get('/api/export', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { month, year } = req.query;
  
  let sql = 'SELECT date, description, amount, category, on_behalf_of, source FROM expenses WHERE user_id = ?';
  const args = [userId];
  
  if (month && year) {
    sql += " AND strftime('%Y-%m', date) = ?";
    args.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  sql += ' ORDER BY date DESC';
  
  const result = await db.execute({ sql, args });
  const expenses = result.rows;
  
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
    const summaryResult = await db.execute({
      sql: `SELECT category, SUM(amount) as total 
            FROM expenses 
            WHERE user_id = ? AND strftime('%Y-%m', date) = ?
            GROUP BY category`,
      args: [userId, `${year}-${month.padStart(2, '0')}`]
    });

    const summaryWs = XLSX.utils.json_to_sheet(summaryResult.rows.map(s => ({
      'Category': s.category,
      'Total (₹)': s.total
    })));
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    const onBehalfResult = await db.execute({
      sql: `SELECT on_behalf_of, SUM(amount) as total 
            FROM expenses 
            WHERE user_id = ? AND strftime('%Y-%m', date) = ? AND on_behalf_of IS NOT NULL
            GROUP BY on_behalf_of`,
      args: [userId, `${year}-${month.padStart(2, '0')}`]
    });

    if (onBehalfResult.rows.length > 0) {
      const onBehalfWs = XLSX.utils.json_to_sheet(onBehalfResult.rows.map(o => ({
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

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Budget Advisor running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
