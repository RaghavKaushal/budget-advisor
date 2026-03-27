let categories = [];
let people = [];
let currentUser = null;
let pendingEmail = null;

// Helper for fetch with credentials
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {})
    }
  });
  return response;
}

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});

// ============ AUTH FUNCTIONS (Email OTP) ============

async function checkAuth() {
  try {
    const response = await api('/api/auth/me');
    const data = await response.json();
    
    if (data.user) {
      currentUser = data.user;
      showMainApp();
    } else {
      showAuthScreen();
    }
  } catch (error) {
    showAuthScreen();
  }
}

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'none';
  showEmailStep();
}

function showMainApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('userName').textContent = currentUser.name || currentUser.email;
  
  initializeSelectors();
  loadCategories();
  loadPeople();
  loadData();
}

function showEmailStep() {
  document.getElementById('emailStep').style.display = 'block';
  document.getElementById('otpStep').style.display = 'none';
  hideAuthError();
}

function showOtpStep(email, otp = null) {
  document.getElementById('emailStep').style.display = 'none';
  document.getElementById('otpStep').style.display = 'block';
  document.getElementById('otpEmail').textContent = email;
  document.getElementById('otpInput').value = '';
  document.getElementById('otpInput').focus();
  
  if (otp) {
    document.getElementById('devOtpBox').style.display = 'block';
    document.getElementById('devOtpDisplay').textContent = otp;
  } else {
    document.getElementById('devOtpBox').style.display = 'none';
  }
  
  hideAuthError();
}

function backToEmail() {
  showEmailStep();
  pendingEmail = null;
}

function showAuthError(message) {
  const errorDiv = document.getElementById('authError');
  errorDiv.textContent = message;
  errorDiv.classList.add('show');
}

function hideAuthError() {
  document.getElementById('authError').classList.remove('show');
}

async function sendOTP(event) {
  event.preventDefault();
  hideAuthError();
  
  const email = document.getElementById('authEmail').value.trim();
  const btn = document.getElementById('sendOtpBtn');
  
  btn.disabled = true;
  btn.textContent = 'Sending...';
  
  try {
    const response = await api('/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      pendingEmail = data.email;
      showOtpStep(data.email, data.devMode ? data.otp : null);
    } else {
      showAuthError(data.error);
    }
  } catch (error) {
    showAuthError('Failed to send OTP. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send OTP';
  }
}

async function verifyOTP(event) {
  event.preventDefault();
  hideAuthError();
  
  const otp = document.getElementById('otpInput').value.trim();
  
  if (!pendingEmail) {
    showAuthError('Please enter your email first');
    showEmailStep();
    return;
  }
  
  try {
    const response = await api('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email: pendingEmail, otp })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      currentUser = data.user;
      pendingEmail = null;
      showMainApp();
    } else {
      showAuthError(data.error);
    }
  } catch (error) {
    showAuthError('Verification failed. Please try again.');
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('Logout error:', error);
  }
  
  currentUser = null;
  pendingEmail = null;
  showAuthScreen();
}

// ============ APP FUNCTIONS ============

function initializeSelectors() {
  const monthSelect = document.getElementById('monthSelect');
  const yearSelect = document.getElementById('yearSelect');
  
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  
  monthSelect.innerHTML = '';
  months.forEach((month, i) => {
    const option = document.createElement('option');
    option.value = (i + 1).toString();
    option.textContent = month;
    monthSelect.appendChild(option);
  });
  
  yearSelect.innerHTML = '';
  const currentYear = new Date().getFullYear();
  for (let year = currentYear - 2; year <= currentYear + 1; year++) {
    const option = document.createElement('option');
    option.value = year.toString();
    option.textContent = year;
    yearSelect.appendChild(option);
  }
  
  const now = new Date();
  monthSelect.value = (now.getMonth() + 1).toString();
  yearSelect.value = now.getFullYear().toString();
  
  document.getElementById('expenseDate').value = now.toISOString().split('T')[0];
}

async function loadCategories() {
  try {
    const response = await api('/api/categories');
    categories = await response.json();
    
    const selects = ['expenseCategory', 'editCategory'];
    selects.forEach(id => {
      const select = document.getElementById(id);
      select.innerHTML = '';
      categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        select.appendChild(option);
      });
    });
  } catch (error) {
    console.error('Failed to load categories:', error);
  }
}

async function loadPeople() {
  try {
    const response = await api('/api/people');
    if (!response.ok) return;
    
    people = await response.json();
    
    const selects = ['expenseOnBehalf', 'editOnBehalf', 'filterPerson'];
    selects.forEach(id => {
      const select = document.getElementById(id);
      const firstOption = select.querySelector('option');
      select.innerHTML = '';
      select.appendChild(firstOption);
      
      people.forEach(person => {
        const option = document.createElement('option');
        option.value = person;
        option.textContent = person;
        select.appendChild(option);
      });
    });
  } catch (error) {
    console.error('Failed to load people:', error);
  }
}

async function loadData() {
  await Promise.all([loadSummary(), loadExpenses()]);
}

async function loadSummary() {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  
  try {
    const response = await api(`/api/summary?month=${month}&year=${year}`);
    if (!response.ok) return;
    
    const data = await response.json();
    
    document.getElementById('totalExpense').textContent = formatCurrency(data.totalExpense);
    
    const totalCollect = data.pendingCollection.reduce((sum, p) => sum + p.total, 0);
    document.getElementById('totalCollect').textContent = formatCurrency(totalCollect);
    
    const categoryDiv = document.getElementById('categoryBreakdown');
    if (data.byCategory.length === 0) {
      categoryDiv.innerHTML = '<p class="empty-state">No expenses this month</p>';
    } else {
      categoryDiv.innerHTML = data.byCategory.map(c => `
        <div class="breakdown-item">
          <span class="name">${c.category}</span>
          <span class="amount">${formatCurrency(c.total)}</span>
        </div>
      `).join('');
    }
    
    const collectDiv = document.getElementById('collectBreakdown');
    if (data.pendingCollection.length === 0) {
      collectDiv.innerHTML = '<p class="empty-state">Nothing to collect</p>';
    } else {
      collectDiv.innerHTML = data.pendingCollection.map(p => `
        <div class="breakdown-item">
          <span class="name">${p.on_behalf_of}</span>
          <span class="amount">${formatCurrency(p.total)}</span>
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Failed to load summary:', error);
  }
}

async function loadExpenses() {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  const filterPerson = document.getElementById('filterPerson').value;
  
  let url = `/api/expenses?month=${month}&year=${year}`;
  if (filterPerson) {
    url += `&on_behalf_of=${encodeURIComponent(filterPerson)}`;
  }
  
  try {
    const response = await api(url);
    if (!response.ok) return;
    
    const expenses = await response.json();
    
    const tbody = document.getElementById('expensesBody');
    
    if (expenses.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-state">No expenses found. Upload a statement or add manually.</td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = expenses.map(e => `
      <tr>
        <td>${formatDate(e.date)}</td>
        <td>${escapeHtml(e.description)}</td>
        <td class="amount-cell">${formatCurrency(e.amount)}</td>
        <td><span class="category-badge">${e.category || 'Other'}</span></td>
        <td>${e.on_behalf_of ? `<span class="on-behalf-badge">${escapeHtml(e.on_behalf_of)}</span>` : '-'}</td>
        <td>
          <button class="btn-edit" onclick="editExpense(${e.id})">Edit</button>
          <button class="btn-danger" onclick="deleteExpense(${e.id})">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Failed to load expenses:', error);
  }
}

function showUploadModal() {
  document.getElementById('uploadModal').classList.add('show');
  document.getElementById('uploadResult').classList.remove('show');
}

function showAddExpenseModal() {
  document.getElementById('expenseModalTitle').textContent = 'Add Expense';
  document.getElementById('expenseForm').reset();
  document.getElementById('expenseDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('amortizationFields').style.display = 'none';
  document.getElementById('addExpenseModal').classList.add('show');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('show');
}

function toggleAmortization() {
  const checked = document.getElementById('isAmortized').checked;
  document.getElementById('amortizationFields').style.display = checked ? 'block' : 'none';
}

async function uploadStatement(event) {
  event.preventDefault();
  
  const form = event.target;
  const formData = new FormData(form);
  const resultDiv = document.getElementById('uploadResult');
  
  resultDiv.innerHTML = 'Parsing statement...';
  resultDiv.className = 'result-box show';
  
  try {
    const response = await fetch('/api/upload-statement', {
      method: 'POST',
      body: formData,
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (response.ok) {
      resultDiv.innerHTML = `
        <p><strong>✓ ${data.message}</strong></p>
        ${data.transactions.length > 0 ? `
          <p style="margin-top: 10px; color: #888;">
            Found: ${data.transactions.slice(0, 3).map(t => t.description.substring(0, 30)).join(', ')}...
          </p>
        ` : ''}
        ${data.rawText ? `
          <details style="margin-top: 10px;">
            <summary style="color: #888; cursor: pointer;">Show raw text (for debugging)</summary>
            <pre style="font-size: 0.75rem; margin-top: 10px; white-space: pre-wrap; color: #666;">${escapeHtml(data.rawText)}</pre>
          </details>
        ` : ''}
      `;
      resultDiv.className = 'result-box show success';
      form.reset();
      loadData();
      loadPeople();
    } else {
      resultDiv.innerHTML = `<p>✗ Error: ${data.error}</p>`;
      resultDiv.className = 'result-box show error';
    }
  } catch (error) {
    resultDiv.innerHTML = `<p>✗ Error: ${error.message}</p>`;
    resultDiv.className = 'result-box show error';
  }
}

async function saveExpense(event) {
  event.preventDefault();
  
  const newPerson = document.getElementById('newPerson').value.trim();
  const onBehalfOf = newPerson || document.getElementById('expenseOnBehalf').value;
  
  const expense = {
    date: document.getElementById('expenseDate').value,
    description: document.getElementById('expenseDescription').value,
    amount: parseFloat(document.getElementById('expenseAmount').value),
    category: document.getElementById('expenseCategory').value,
    on_behalf_of: onBehalfOf || null,
    is_amortized: document.getElementById('isAmortized').checked,
    amortization_months: parseInt(document.getElementById('amortizationMonths').value) || 12,
    source: 'Manual'
  };
  
  try {
    const response = await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify(expense)
    });
    
    if (response.ok) {
      closeModal('addExpenseModal');
      loadData();
      loadPeople();
    } else {
      const data = await response.json();
      alert('Error: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function editExpense(id) {
  try {
    const response = await api('/api/expenses');
    const expenses = await response.json();
    const expense = expenses.find(e => e.id === id);
    
    if (!expense) {
      alert('Expense not found');
      return;
    }
    
    document.getElementById('editId').value = expense.id;
    document.getElementById('editDate').value = expense.date;
    document.getElementById('editDescription').value = expense.description;
    document.getElementById('editAmount').value = expense.amount;
    document.getElementById('editCategory').value = expense.category || 'Other';
    document.getElementById('editOnBehalf').value = expense.on_behalf_of || '';
    
    document.getElementById('editModal').classList.add('show');
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function updateExpense(event) {
  event.preventDefault();
  
  const id = document.getElementById('editId').value;
  const expense = {
    date: document.getElementById('editDate').value,
    description: document.getElementById('editDescription').value,
    amount: parseFloat(document.getElementById('editAmount').value),
    category: document.getElementById('editCategory').value,
    on_behalf_of: document.getElementById('editOnBehalf').value || null
  };
  
  try {
    const response = await api(`/api/expenses/${id}`, {
      method: 'PUT',
      body: JSON.stringify(expense)
    });
    
    if (response.ok) {
      closeModal('editModal');
      loadData();
      loadPeople();
    } else {
      const data = await response.json();
      alert('Error: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function deleteExpense(id) {
  if (!confirm('Are you sure you want to delete this expense?')) {
    return;
  }
  
  try {
    const response = await api(`/api/expenses/${id}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      loadData();
      loadPeople();
    } else {
      const data = await response.json();
      alert('Error: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

function exportToExcel() {
  const month = document.getElementById('monthSelect').value;
  const year = document.getElementById('yearSelect').value;
  window.location.href = `/api/export?month=${month}&year=${year}`;
}

function formatCurrency(amount) {
  return '₹' + amount.toLocaleString('en-IN', { 
    minimumFractionDigits: 0,
    maximumFractionDigits: 2 
  });
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.onclick = function(event) {
  if (event.target.classList.contains('modal')) {
    event.target.classList.remove('show');
  }
};
