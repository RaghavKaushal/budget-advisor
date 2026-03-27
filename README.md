# Budget Advisor

A personal smart budget tracking app with AI-powered expense categorization, amortization, and "on behalf of" tracking.

## Features

- **PDF Statement Parsing**: Upload bank statements (UPI) or credit card bills
- **AI Categorization**: Automatically categorize expenses using OpenAI
- **Amortization**: Spread annual subscriptions across 12 months
- **"On Behalf Of" Tracking**: Track expenses made for others and see how much to collect
- **Excel Export**: Download your expenses with category breakdown and collection summary

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure your OpenAI API key in `.env`:
```
OPENAI_API_KEY=your_key_here
```

3. Start the server:
```bash
npm start
```

4. Open http://localhost:3001 in your browser

## Usage

### Upload Statements
1. Click "Upload Statement"
2. Select source type (Bank/CC/Other)
3. Upload PDF file
4. Transactions will be parsed and auto-categorized

### Add Manual Expenses
1. Click "Add Expense"
2. Fill in details
3. For annual subscriptions, check "Amortize" and set months (e.g., 12)
4. Set "On Behalf Of" if paying for someone else

### Track Collections
- The "To Collect" section shows total money others owe you
- Filter transactions by person to see detailed breakdown
- Export to Excel includes a "To Collect" sheet

### Export
Click "Export Excel" to download a spreadsheet with:
- All transactions for the month
- Category summary
- Collection summary (money to collect from others)

## PDF Parsing Notes

The parser works best with standard Indian bank statement formats. If transactions aren't detected:
1. The raw text will be shown for debugging
2. You can add transactions manually
3. Common formats supported:
   - HDFC, ICICI, SBI statements
   - Credit card bills (HDFC, ICICI, Axis, etc.)

## Tech Stack

- Node.js + Express
- SQLite (better-sqlite3)
- OpenAI API (gpt-4o-mini)
- pdf-parse
- xlsx
