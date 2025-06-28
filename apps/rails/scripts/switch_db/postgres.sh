#!/bin/bash

echo "Configuring Rails application to use PostgreSQL..."

# Comment out other database gems in Gemfile
sed -i '' 's/^gem "sqlite3"$/# gem "sqlite3"/' Gemfile 2>/dev/null || sed -i 's/^gem "sqlite3"$/# gem "sqlite3"/' Gemfile
sed -i '' 's/^gem "mysql2"$/# gem "mysql2"/' Gemfile 2>/dev/null || sed -i 's/^gem "mysql2"$/# gem "mysql2"/' Gemfile

# Ensure PostgreSQL gem is uncommented in Gemfile
sed -i '' 's/# gem "pg"/gem "pg"/' Gemfile 2>/dev/null || sed -i 's/# gem "pg"/gem "pg"/' Gemfile

# Create PostgreSQL database configuration
cat > config/database.yml << EOL_CONFIG
default: &default
  adapter: postgresql
  encoding: unicode
  host: localhost
  port: 3333
  username: postgres
  password: mysecretpassword
  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>

development:
  <<: *default
  database: sample_db

test:
  <<: *default
  database: sample_db_test

production:
  primary:
    <<: *default
    database: sample_db_production
  cache:
    <<: *default
    database: sample_db_production_cache
    migrations_paths: db/cache_migrate
  queue:
    <<: *default
    database: sample_db_production_queue
    migrations_paths: db/queue_migrate
  cable:
    <<: *default
    database: sample_db_production_cable
    migrations_paths: db/cable_migrate
EOL_CONFIG

# Create PostgreSQL migration for extensions
migration_file="db/migrate/$(date +%Y%m%d%H%M%S)_setup_postgres_extensions.rb"
cat > "$migration_file" << EOL_MIGRATION
class SetupPostgresExtensions < ActiveRecord::Migration[8.0]
  def up
    # Enable core extensions
    enable_extension "pgcrypto" unless extension_enabled?("pgcrypto")
    enable_extension "uuid-ossp" unless extension_enabled?("uuid-ossp")
  end

  def down
    # Disable extensions
    disable_extension "uuid-ossp" if extension_enabled?("uuid-ossp")
    disable_extension "pgcrypto" if extension_enabled?("pgcrypto")
  end
end
EOL_MIGRATION

# Reset database using Docker directly
echo "Setting up database..."
docker exec postgres-devdb-triage psql -U postgres -c "DROP DATABASE IF EXISTS sample_db;"
docker exec postgres-devdb-triage psql -U postgres -c "CREATE DATABASE sample_db;"

# Apply the extensions directly using Docker
echo "Applying PostgreSQL extensions..."
docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

# Test database connection
echo "Testing database connection..."
CONNECTION_TEST=$(docker exec postgres-devdb-triage psql -U postgres -d sample_db -t -c "SELECT version();")
connection_result=$?

if [ $connection_result -eq 0 ]; then
  echo "Successfully connected to PostgreSQL database (version: $CONNECTION_TEST)"
  echo "Database connection test: PASSED"
  echo "Rails application is now configured to use PostgreSQL and connection is verified!"
  
  # Install required gems
  echo "Installing required gems..."
  bundle install
  
  # Create seed data
  echo "Creating sample data..."
  
  # Create products table
  echo "Creating products table..."
  PRODUCTS_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$PRODUCTS_TABLE_SQL"
  
  # Create categories table
  echo "Creating categories table..."
  CATEGORIES_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$CATEGORIES_TABLE_SQL"
  
  # Create users table
  echo "Creating users table..."
  USERS_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$USERS_TABLE_SQL"
  
  # Insert sample categories
  echo "Inserting sample categories..."
  CATEGORIES_DATA_SQL=$(cat << 'SQL'
  INSERT INTO categories (name, description) VALUES
  ('Electronics', 'Electronic devices and gadgets'),
  ('Clothing', 'Apparel and fashion items'),
  ('Books', 'Books and publications'),
  ('Home & Kitchen', 'Home appliances and kitchen supplies'),
  ('Sports', 'Sports equipment and accessories');
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$CATEGORIES_DATA_SQL"
  
  # Insert sample products
  echo "Inserting sample products..."
  PRODUCTS_DATA_SQL=$(cat << 'SQL'
  INSERT INTO products (name, description, price, stock_quantity) VALUES
  ('Smartphone X', 'Latest smartphone with advanced features', 899.99, 50),
  ('Laptop Pro', 'High-performance laptop for professionals', 1299.99, 25),
  ('Wireless Headphones', 'Noise-cancelling wireless headphones', 199.99, 100),
  ('Cotton T-shirt', 'Comfortable cotton t-shirt', 19.99, 200),
  ('Denim Jeans', 'Classic denim jeans', 49.99, 150),
  ('Programming Guide', 'Comprehensive programming guide', 29.99, 75),
  ('Coffee Maker', 'Automatic coffee maker', 89.99, 30),
  ('Blender', 'High-speed blender for smoothies', 69.99, 40),
  ('Yoga Mat', 'Non-slip yoga mat', 24.99, 120),
  ('Basketball', 'Official size basketball', 29.99, 80);
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$PRODUCTS_DATA_SQL"
  
  # Insert sample users
  echo "Inserting sample users..."
  USERS_DATA_SQL=$(cat << 'SQL'
  INSERT INTO users (email, name) VALUES
  ('john.doe@example.com', 'John Doe'),
  ('jane.smith@example.com', 'Jane Smith'),
  ('bob.johnson@example.com', 'Bob Johnson'),
  ('alice.williams@example.com', 'Alice Williams'),
  ('charlie.brown@example.com', 'Charlie Brown');
SQL
  )
  
  docker exec postgres-devdb-triage psql -U postgres -d sample_db -c "$USERS_DATA_SQL"
  
  echo "Sample data created successfully!"
else
  echo "Failed to connect to database"
  echo "Database connection test: FAILED"
  exit 1
fi
