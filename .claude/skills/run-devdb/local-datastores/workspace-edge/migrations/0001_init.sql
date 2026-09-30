CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

INSERT INTO customers (id, name, email, plan) VALUES
  (1, 'Ada Lovelace', 'ada@example.com', 'pro'),
  (2, 'Grace Hopper', 'grace@example.com', 'free'),
  (3, 'Chinua Achebe', 'chinua@example.com', 'team');

INSERT INTO orders (id, customer_id, total_cents, status) VALUES
  (1, 1, 4900, 'paid'),
  (2, 1, 1200, 'refunded'),
  (3, 3, 29900, 'paid'),
  (4, 2, 0, 'pending');
