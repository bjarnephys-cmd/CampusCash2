import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, '../campuscash.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    category TEXT NOT NULL,
    is_shared INTEGER NOT NULL DEFAULT 0,
    split_between_count INTEGER DEFAULT 1,
    notes TEXT,
    settled INTEGER NOT NULL DEFAULT 0,
    debtors TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe migration: add column if older db exists
try {
  db.exec(`ALTER TABLE transactions ADD COLUMN debtors TEXT;`);
} catch {
  // column already exists
}

export interface DebtorDTO {
  id: string;
  name: string;
  amount: number;
  settled: boolean;
  settled_at?: string;
}

export interface DBTransaction {
  id: string;
  date: string;
  title: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  is_shared: number;
  split_between_count: number | null;
  notes: string | null;
  settled: number;
  debtors: string | null;
  created_at?: string;
}

export interface TransactionDTO {
  id: string;
  date: string;
  title: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  is_shared: boolean;
  split_between_count?: number;
  notes?: string;
  settled?: boolean;
  debtors?: DebtorDTO[];
}

export const INITIAL_DATA: Omit<TransactionDTO, 'id'>[] = [
  {
    date: "2026-10-01",
    title: "SU Udbetaling",
    amount: 6820.00,
    type: "income",
    category: "SU/Job",
    is_shared: false
  },
  {
    date: "2026-10-01",
    title: "Husleje Kollegie",
    amount: 3200.00,
    type: "expense",
    category: "Bolig/Husleje",
    is_shared: false
  },
  {
    date: "2026-10-03",
    title: "Kantine Frokost",
    amount: 45.00,
    type: "expense",
    category: "Kantine/Mad",
    is_shared: false
  },
  {
    date: "2026-10-04",
    title: "Pensumbog i Mikroøkonomi",
    amount: 420.00,
    type: "expense",
    category: "Bøger/Pensum",
    is_shared: false
  },
  {
    date: "2026-10-05",
    title: "Snacks til Klubmøde",
    amount: 150.00,
    type: "expense",
    category: "Bytur/Socialt",
    is_shared: true,
    split_between_count: 3,
    debtors: [
      { id: "d-105-1", name: "Person 1", amount: 50.00, settled: false },
      { id: "d-105-2", name: "Person 2", amount: 50.00, settled: false }
    ]
  }
];

function buildDefaultDebtors(id: string, amount: number, splitCount: number, settled = false): DebtorDTO[] {
  const count = Math.max(1, splitCount - 1);
  const perPerson = Math.round((amount / splitCount) * 100) / 100;
  return Array.from({ length: count }, (_, i) => ({
    id: `d-${id}-${i + 1}`,
    name: `Person ${i + 1}`,
    amount: perPerson,
    settled: settled,
  }));
}

function formatRow(row: DBTransaction): TransactionDTO {
  let debtors: DebtorDTO[] | undefined = undefined;

  if (row.is_shared === 1) {
    if (row.debtors) {
      try {
        debtors = JSON.parse(row.debtors);
      } catch {
        debtors = undefined;
      }
    }

    if (!debtors || debtors.length === 0) {
      const splitCount = row.split_between_count && row.split_between_count > 1 ? row.split_between_count : 2;
      debtors = buildDefaultDebtors(row.id, row.amount, splitCount, row.settled === 1);
    }
  }

  // A shared transaction is settled if all its debtors have settled
  const isSettled = row.is_shared === 1 && debtors && debtors.length > 0
    ? debtors.every((d) => d.settled)
    : row.settled === 1;

  return {
    id: row.id,
    date: row.date,
    title: row.title,
    amount: row.amount,
    type: row.type,
    category: row.category,
    is_shared: row.is_shared === 1,
    split_between_count: row.split_between_count || undefined,
    notes: row.notes || undefined,
    settled: isSettled,
    debtors: debtors,
  };
}

export function seedInitialData() {
  const count = db.prepare('SELECT count(*) as count FROM transactions').get() as { count: number };
  if (count.count === 0) {
    const insert = db.prepare(`
      INSERT INTO transactions (id, date, title, amount, type, category, is_shared, split_between_count, notes, settled, debtors)
      VALUES (@id, @date, @title, @amount, @type, @category, @is_shared, @split_between_count, @notes, @settled, @debtors)
    `);

    const insertMany = db.transaction((items) => {
      let idx = 101;
      for (const item of items) {
        const id = `tx-${idx++}`;
        const debtors = item.is_shared
          ? (item.debtors || buildDefaultDebtors(id, item.amount, item.split_between_count || 2, item.settled || false))
          : null;

        insert.run({
          id,
          date: item.date,
          title: item.title,
          amount: item.amount,
          type: item.type,
          category: item.category,
          is_shared: item.is_shared ? 1 : 0,
          split_between_count: item.split_between_count || 1,
          notes: item.notes || null,
          settled: item.settled ? 1 : 0,
          debtors: debtors ? JSON.stringify(debtors) : null,
        });
      }
    });

    insertMany(INITIAL_DATA);
  }
}

// Seed on startup if needed
seedInitialData();

export function getAllTransactions(filters?: { type?: string; category?: string; search?: string }): TransactionDTO[] {
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params: any[] = [];

  if (filters?.type && filters.type !== 'all') {
    if (filters.type === 'shared') {
      query += ' AND is_shared = 1 AND type = "expense"';
    } else {
      query += ' AND type = ?';
      params.push(filters.type);
    }
  }

  if (filters?.category && filters.category !== 'all') {
    query += ' AND category = ?';
    params.push(filters.category);
  }

  if (filters?.search) {
    query += ' AND (title LIKE ? OR category LIKE ? OR notes LIKE ?)';
    const searchParam = `%${filters.search}%`;
    params.push(searchParam, searchParam, searchParam);
  }

  query += ' ORDER BY date DESC, created_at DESC';

  const rows = db.prepare(query).all(...params) as DBTransaction[];
  return rows.map(formatRow);
}

export function getTransactionById(id: string): TransactionDTO | null {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as DBTransaction | undefined;
  return row ? formatRow(row) : null;
}

export function createTransaction(data: Omit<TransactionDTO, 'id'> & { id?: string }): TransactionDTO {
  const id = data.id || `tx-${Date.now().toString().slice(-6)}`;
  const splitCount = data.split_between_count || 1;
  
  let debtorsJson: string | null = null;
  if (data.is_shared) {
    const debtors = data.debtors && data.debtors.length > 0
      ? data.debtors
      : buildDefaultDebtors(id, data.amount, splitCount, Boolean(data.settled));
    debtorsJson = JSON.stringify(debtors);
  }

  const stmt = db.prepare(`
    INSERT INTO transactions (id, date, title, amount, type, category, is_shared, split_between_count, notes, settled, debtors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    data.date,
    data.title,
    data.amount,
    data.type,
    data.category,
    data.is_shared ? 1 : 0,
    splitCount,
    data.notes || null,
    data.settled ? 1 : 0,
    debtorsJson
  );

  return getTransactionById(id)!;
}

export function updateTransaction(id: string, data: Partial<TransactionDTO>): TransactionDTO | null {
  const current = getTransactionById(id);
  if (!current) return null;

  const merged = { ...current, ...data };
  const splitCount = merged.split_between_count || 1;

  let debtorsJson: string | null = null;
  if (merged.is_shared) {
    let debtors = merged.debtors;
    if (!debtors || debtors.length === 0) {
      debtors = buildDefaultDebtors(id, merged.amount, splitCount, Boolean(merged.settled));
    }
    debtorsJson = JSON.stringify(debtors);
  }

  const isAllSettled = merged.is_shared && merged.debtors && merged.debtors.length > 0
    ? merged.debtors.every((d) => d.settled)
    : merged.settled;

  const stmt = db.prepare(`
    UPDATE transactions 
    SET date = ?, title = ?, amount = ?, type = ?, category = ?, is_shared = ?, split_between_count = ?, notes = ?, settled = ?, debtors = ?
    WHERE id = ?
  `);

  stmt.run(
    merged.date,
    merged.title,
    merged.amount,
    merged.type,
    merged.category,
    merged.is_shared ? 1 : 0,
    splitCount,
    merged.notes || null,
    isAllSettled ? 1 : 0,
    debtorsJson,
    id
  );

  return getTransactionById(id);
}

export function deleteTransaction(id: string): boolean {
  const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return info.changes > 0;
}

export function toggleSettledTransaction(id: string): TransactionDTO | null {
  const current = getTransactionById(id);
  if (!current) return null;

  const newSettledState = !current.settled;

  // If shared, also update all debtors to the new state
  let newDebtors = current.debtors;
  if (current.is_shared && current.debtors && current.debtors.length > 0) {
    newDebtors = current.debtors.map((d) => ({
      ...d,
      settled: newSettledState,
      settled_at: newSettledState ? new Date().toISOString() : undefined,
    }));
  }

  return updateTransaction(id, {
    settled: newSettledState,
    debtors: newDebtors,
  });
}

export function toggleDebtorSettled(transactionId: string, debtorId: string): TransactionDTO | null {
  const current = getTransactionById(transactionId);
  if (!current || !current.debtors) return null;

  const updatedDebtors = current.debtors.map((d) => {
    if (d.id === debtorId) {
      const nextSettled = !d.settled;
      return {
        ...d,
        settled: nextSettled,
        settled_at: nextSettled ? new Date().toISOString() : undefined,
      };
    }
    return d;
  });

  return updateTransaction(transactionId, {
    debtors: updatedDebtors,
  });
}

export function updateDebtors(transactionId: string, debtors: DebtorDTO[]): TransactionDTO | null {
  return updateTransaction(transactionId, {
    debtors,
  });
}

export function resetDatabase(): TransactionDTO[] {
  db.prepare('DELETE FROM transactions').run();
  seedInitialData();
  return getAllTransactions();
}
