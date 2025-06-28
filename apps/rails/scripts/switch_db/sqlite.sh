#!/bin/bash

echo "Configuring Rails application to use SQLite..."

# Comment out other database gems in Gemfile
sed -i '' 's/^gem "pg"$/# gem "pg"/' Gemfile 2>/dev/null || sed -i 's/^gem "pg"$/# gem "pg"/' Gemfile
sed -i '' 's/^gem "mysql2"$/# gem "mysql2"/' Gemfile 2>/dev/null || sed -i 's/^gem "mysql2"$/# gem "mysql2"/' Gemfile

# Ensure SQLite gem is uncommented in Gemfile
sed -i '' 's/# gem "sqlite3"/gem "sqlite3"/' Gemfile 2>/dev/null || sed -i 's/# gem "sqlite3"/gem "sqlite3"/' Gemfile

# Create SQLite database configuration
cat > config/database.yml << EOL_CONFIG
default: &default
  adapter: sqlite3
  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>
  timeout: 5000

development:
  <<: *default
  database: storage/development.sqlite3

test:
  <<: *default
  database: storage/test.sqlite3

production:
  primary:
    <<: *default
    database: storage/production.sqlite3
  cache:
    <<: *default
    database: storage/production_cache.sqlite3
    migrations_paths: db/cache_migrate
  queue:
    <<: *default
    database: storage/production_queue.sqlite3
    migrations_paths: db/queue_migrate
  cable:
    <<: *default
    database: storage/production_cable.sqlite3
    migrations_paths: db/cable_migrate
EOL_CONFIG

# Create storage directory if it doesn't exist
mkdir -p storage

# Install required gems
echo "Installing required gems..."
bundle install

# Reset database
echo "Setting up database..."
bin/rails db:drop 2>/dev/null || true
bin/rails db:create

# Check if schema.rb exists and contains PostgreSQL-specific commands
if [ -f db/schema.rb ]; then
  echo "Backing up and resetting schema.rb..."
  cp db/schema.rb db/schema.rb.bak
  cat > db/schema.rb << 'EOL_SCHEMA'
# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 0) do
end
EOL_SCHEMA
fi

# Reset the database completely
echo "Resetting database completely..."
rm -rf db/migrate/*
rm -f db/schema.rb
rm -f storage/*.sqlite3

# Create storage directory if it doesn't exist
mkdir -p storage

# Create a fresh schema.rb file
cat > db/schema.rb << 'EOL_SCHEMA'
# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 0) do
end
EOL_SCHEMA

# Create fresh databases
bin/rails db:create

# Create a simple model to test database connection
echo "Creating test connection migration..."
migration_file="db/migrate/$(date +%Y%m%d%H%M%S)_create_test_connection.rb"
cat > "$migration_file" << EOL_MIGRATION
class CreateTestConnection < ActiveRecord::Migration[8.0]
  def change
    create_table :test_connections do |t|
      t.string :name
      t.timestamps
    end
  end
end
EOL_MIGRATION

# Run migrations
echo "Running initial migrations..."
bin/rails db:migrate

# Test database connection
echo "Testing database connection..."
cat > test_connection.rb << EOL_TEST
require_relative 'config/environment'

begin
  # Try to execute a simple query
  result = ActiveRecord::Base.connection.execute("SELECT sqlite_version()")
  version = result.first[0]
  puts "Successfully connected to SQLite database (version: \#{version})"
  puts "Database connection test: PASSED"
  exit 0
rescue => e
  puts "Failed to connect to database: \#{e.message}"
  puts "Database connection test: FAILED"
  exit 1
end
EOL_TEST

ruby test_connection.rb
connection_result=$?
rm test_connection.rb

if [ $connection_result -eq 0 ]; then
  echo "Rails application is now configured to use SQLite and connection is verified!"
  
  # Create seed data
  echo "Creating sample data..."
  
  # Create products table migration
  echo "Creating products table..."
  sleep 1
  products_migration_file="db/migrate/$(date +%Y%m%d%H%M%S)_create_products.rb"
  cat > "$products_migration_file" << EOL_PRODUCTS
class CreateProducts < ActiveRecord::Migration[8.0]
  def change
    create_table :products, id: :string, limit: 36, primary_key: :id do |t|
      t.string :name, null: false
      t.text :description
      t.decimal :price, precision: 10, scale: 2, null: false
      t.integer :stock_quantity, null: false, default: 0
      t.timestamps
    end
  end
end
EOL_PRODUCTS

  # Create categories table migration
  echo "Creating categories table..."
  sleep 1
  categories_migration_file="db/migrate/$(date +%Y%m%d%H%M%S)_create_categories.rb"
  cat > "$categories_migration_file" << EOL_CATEGORIES
class CreateCategories < ActiveRecord::Migration[8.0]
  def change
    create_table :categories, id: :string, limit: 36, primary_key: :id do |t|
      t.string :name, null: false
      t.text :description
      t.timestamps
    end
  end
end
EOL_CATEGORIES

  # Create users table migration
  echo "Creating users table..."
  sleep 1
  users_migration_file="db/migrate/$(date +%Y%m%d%H%M%S)_create_users.rb"
  cat > "$users_migration_file" << EOL_USERS
class CreateUsers < ActiveRecord::Migration[8.0]
  def change
    create_table :users, id: :string, limit: 36, primary_key: :id do |t|
      t.string :email, null: false, index: { unique: true }
      t.string :name, null: false
      t.timestamps
    end
  end
end
EOL_USERS

  # Run migrations
  echo "Running migrations..."
  bin/rails db:migrate
  
  # Create seed data file
  echo "Creating seed data..."
  cat > "db/seeds.rb" << EOL_SEEDS
# Categories
categories = [
  { id: SecureRandom.uuid, name: 'Electronics', description: 'Electronic devices and gadgets' },
  { id: SecureRandom.uuid, name: 'Clothing', description: 'Apparel and fashion items' },
  { id: SecureRandom.uuid, name: 'Books', description: 'Books and publications' },
  { id: SecureRandom.uuid, name: 'Home & Kitchen', description: 'Home appliances and kitchen supplies' },
  { id: SecureRandom.uuid, name: 'Sports', description: 'Sports equipment and accessories' }
]

categories.each do |category|
  ActiveRecord::Base.connection.execute(<<~SQL)
    INSERT INTO categories (id, name, description, created_at, updated_at)
    VALUES ('#{category[:id]}', '#{category[:name]}', '#{category[:description]}', datetime('now'), datetime('now'))
  SQL
end

# Products
products = [
  { id: SecureRandom.uuid, name: 'Smartphone X', description: 'Latest smartphone with advanced features', price: 899.99, stock_quantity: 50 },
  { id: SecureRandom.uuid, name: 'Laptop Pro', description: 'High-performance laptop for professionals', price: 1299.99, stock_quantity: 25 },
  { id: SecureRandom.uuid, name: 'Wireless Headphones', description: 'Noise-cancelling wireless headphones', price: 199.99, stock_quantity: 100 },
  { id: SecureRandom.uuid, name: 'Cotton T-shirt', description: 'Comfortable cotton t-shirt', price: 19.99, stock_quantity: 200 },
  { id: SecureRandom.uuid, name: 'Denim Jeans', description: 'Classic denim jeans', price: 49.99, stock_quantity: 150 },
  { id: SecureRandom.uuid, name: 'Programming Guide', description: 'Comprehensive programming guide', price: 29.99, stock_quantity: 75 },
  { id: SecureRandom.uuid, name: 'Coffee Maker', description: 'Automatic coffee maker', price: 89.99, stock_quantity: 30 },
  { id: SecureRandom.uuid, name: 'Blender', description: 'High-speed blender for smoothies', price: 69.99, stock_quantity: 40 },
  { id: SecureRandom.uuid, name: 'Yoga Mat', description: 'Non-slip yoga mat', price: 24.99, stock_quantity: 120 },
  { id: SecureRandom.uuid, name: 'Basketball', description: 'Official size basketball', price: 29.99, stock_quantity: 80 }
]

products.each do |product|
  ActiveRecord::Base.connection.execute(<<~SQL)
    INSERT INTO products (id, name, description, price, stock_quantity, created_at, updated_at)
    VALUES (
      '#{product[:id]}',
      '#{product[:name]}',
      '#{product[:description]}',
      #{product[:price]},
      #{product[:stock_quantity]},
      datetime('now'),
      datetime('now')
    )
  SQL
end

# Users
users = [
  { id: SecureRandom.uuid, email: 'john.doe@example.com', name: 'John Doe' },
  { id: SecureRandom.uuid, email: 'jane.smith@example.com', name: 'Jane Smith' },
  { id: SecureRandom.uuid, email: 'bob.johnson@example.com', name: 'Bob Johnson' },
  { id: SecureRandom.uuid, email: 'alice.williams@example.com', name: 'Alice Williams' },
  { id: SecureRandom.uuid, email: 'charlie.brown@example.com', name: 'Charlie Brown' }
]

users.each do |user|
  ActiveRecord::Base.connection.execute(<<~SQL)
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES ('#{user[:id]}', '#{user[:email]}', '#{user[:name]}', datetime('now'), datetime('now'))
  SQL
end
EOL_SEEDS

  # Run seeds
  echo "Running seeds..."
  bin/rails db:seed
  
  echo "Sample data created successfully!"
else
  echo "Rails application is configured to use SQLite but connection test failed!"
  exit 1
fi
