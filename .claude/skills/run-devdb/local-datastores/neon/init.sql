CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customers (name, email, plan)
SELECT 'Customer ' || g, 'customer' || g || '@example.com', (ARRAY['free','launch','scale'])[1 + g % 3]
FROM generate_series(1, 500) g;

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint REFERENCES customers(id),
  total numeric(12,2) NOT NULL,
  status text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO orders (customer_id, total, status, meta)
SELECT 1 + g % 500, round((random() * 500)::numeric, 2), (ARRAY['pending','paid','refunded'])[1 + g % 3],
       jsonb_build_object('source', 'seed', 'n', g)
FROM generate_series(1, 5000) g;
