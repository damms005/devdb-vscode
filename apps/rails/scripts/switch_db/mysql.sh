#!/bin/bash

echo "Configuring Rails application to use MySQL..."

# Comment out other database gems in Gemfile
sed -i '' 's/^gem "pg"$/# gem "pg"/' Gemfile 2>/dev/null || sed -i 's/^gem "pg"$/# gem "pg"/' Gemfile
sed -i '' 's/^gem "sqlite3"$/# gem "sqlite3"/' Gemfile 2>/dev/null || sed -i 's/^gem "sqlite3"$/# gem "sqlite3"/' Gemfile

# Check if MySQL client is installed
if ! command -v mysql >/dev/null 2>&1; then
  echo "MySQL client not found. Installing..."
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS
    brew install mysql-client
    echo 'export PATH="/usr/local/opt/mysql-client/bin:$PATH"' >> ~/.zshrc
    export PATH="/usr/local/opt/mysql-client/bin:$PATH"
  elif [[ "$(uname)" == "Linux" ]]; then
    # Linux
    sudo apt-get update
    sudo apt-get install -y mysql-client
  else
    echo "Unsupported OS. Please install MySQL client manually."
    exit 1
  fi
fi

# Check if zstd is installed (needed for mysql2 gem)
if ! brew list zstd &>/dev/null; then
  echo "Installing zstd (required for mysql2 gem)..."
  brew install zstd
fi

# Ensure mysql2 gem is properly configured in Gemfile
if grep -q "^gem \"mysql2\"" Gemfile; then
  echo "mysql2 gem is already in Gemfile"
else
  if grep -q "^# gem \"mysql2\"" Gemfile; then
    # Uncomment mysql2 gem if it's commented out
    sed -i '' 's/^# gem "mysql2".*$/gem "mysql2"/' Gemfile 2>/dev/null || sed -i 's/^# gem "mysql2".*$/gem "mysql2"/' Gemfile
    echo "Uncommented mysql2 gem in Gemfile"
  else
    # Add mysql2 gem if it doesn't exist
    sed -i '' '/gem "pg"/a\
gem "mysql2"' Gemfile 2>/dev/null || sed -i '/gem "pg"/a\
gem "mysql2"' Gemfile
    echo "Added mysql2 gem to Gemfile"
  fi
fi

# Install the mysql2 gem
echo "Installing mysql2 gem..."

# Get the correct path for mysql-client
MYSQL_CLIENT_PATH=$(brew --prefix mysql-client)
echo "MySQL client path: $MYSQL_CLIENT_PATH"

# Set up environment for mysql2 gem compilation
export LIBRARY_PATH=$LIBRARY_PATH:$(brew --prefix zstd)/lib
export LDFLAGS="-L$(brew --prefix zstd)/lib -L$MYSQL_CLIENT_PATH/lib"
export CPPFLAGS="-I$(brew --prefix zstd)/include -I$MYSQL_CLIENT_PATH/include"
export PKG_CONFIG_PATH="$MYSQL_CLIENT_PATH/lib/pkgconfig:$(brew --prefix zstd)/lib/pkgconfig"

# Configure bundle to use the correct mysql_config path
bundle config --local build.mysql2 --with-mysql-config=$MYSQL_CLIENT_PATH/bin/mysql_config

# Create MySQL database configuration
cat > config/database.yml << EOL_CONFIG
default: &default
  adapter: mysql2
  encoding: utf8mb4
  host: 127.0.0.1
  port: 2222
  username: root
  password: mysecretpassword
  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>

development:
  <<: *default
  database: sample_db

test:
  <<: *default
  database: sample_db_test

production:
  <<: *default
  database: sample_db_production
  username: sample_db
  password: <%= ENV["SAMPLE_DB_DATABASE_PASSWORD"] %>
EOL_CONFIG

# Check if a MySQL UUID support migration already exists
if ! find db/migrate -name "*_setup_mysql_uuid_support.rb" | grep -q .; then
  # Create a migration for MySQL UUID support
  timestamp=$(date +%Y%m%d%H%M%S)
  migration_file="db/migrate/${timestamp}_setup_mysql_uuid_support.rb"
  mkdir -p db/migrate
  cat > "$migration_file" << 'EOL_MIGRATION'
class SetupMysqlUuidSupport < ActiveRecord::Migration[8.0]
  def up
    # Create helper function to generate UUIDs in MySQL
    execute <<-SQL
      CREATE FUNCTION IF NOT EXISTS uuid_to_bin(_uuid CHAR(36))
        RETURNS BINARY(16)
        DETERMINISTIC
        RETURN UNHEX(CONCAT(
          SUBSTR(_uuid, 1, 8),
          SUBSTR(_uuid, 10, 4),
          SUBSTR(_uuid, 15, 4),
          SUBSTR(_uuid, 20, 4),
          SUBSTR(_uuid, 25)
        ));
    SQL

    execute <<-SQL
      CREATE FUNCTION IF NOT EXISTS bin_to_uuid(_bin BINARY(16))
        RETURNS CHAR(36)
        DETERMINISTIC
        RETURN LCASE(CONCAT_WS('-',
          HEX(SUBSTR(_bin, 1, 4)),
          HEX(SUBSTR(_bin, 5, 2)),
          HEX(SUBSTR(_bin, 7, 2)),
          HEX(SUBSTR(_bin, 9, 2)),
          HEX(SUBSTR(_bin, 11))
        ));
    SQL
  end

  def down
    execute "DROP FUNCTION IF EXISTS uuid_to_bin;"
    execute "DROP FUNCTION IF EXISTS bin_to_uuid;"
  end
end
EOL_MIGRATION
  echo "Created MySQL UUID support migration: $migration_file"
else
  echo "MySQL UUID support migration already exists, skipping creation"
fi

# Reset database using Docker directly
echo "Setting up database..."
docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword -e "DROP DATABASE IF EXISTS sample_db;"
docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword -e "CREATE DATABASE IF NOT EXISTS sample_db;"

# Apply the migration directly using Docker
echo "Applying UUID support migration..."
MIGRATION_SQL=$(cat << 'SQL'
CREATE FUNCTION IF NOT EXISTS uuid_to_bin(_uuid CHAR(36))
  RETURNS BINARY(16)
  DETERMINISTIC
  RETURN UNHEX(CONCAT(
    SUBSTR(_uuid, 1, 8),
    SUBSTR(_uuid, 10, 4),
    SUBSTR(_uuid, 15, 4),
    SUBSTR(_uuid, 20, 4),
    SUBSTR(_uuid, 25)
  ));

CREATE FUNCTION IF NOT EXISTS bin_to_uuid(_bin BINARY(16))
  RETURNS CHAR(36)
  DETERMINISTIC
  RETURN LCASE(CONCAT_WS('-',
    HEX(SUBSTR(_bin, 1, 4)),
    HEX(SUBSTR(_bin, 5, 2)),
    HEX(SUBSTR(_bin, 7, 2)),
    HEX(SUBSTR(_bin, 9, 2)),
    HEX(SUBSTR(_bin, 11))
  ));
SQL
)

docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$MIGRATION_SQL"

# Test database connection
echo "Testing database connection..."
CONNECTION_TEST=$(docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "SELECT VERSION();" -N)
connection_result=$?

if [ $connection_result -eq 0 ]; then
  echo "Successfully connected to MySQL database (version: $CONNECTION_TEST)"
  echo "Database connection test: PASSED"
  
  # Install required gems
  echo "Installing required gems..."
  bundle install
  
  echo "Rails application is now configured to use MySQL!"
  
  # Create seed data
  echo "Creating sample data..."
  
  # Create products table
  echo "Creating products table..."
  PRODUCTS_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS products (
    id BINARY(16) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$PRODUCTS_TABLE_SQL"
  
  # Create categories table
  echo "Creating categories table..."
  CATEGORIES_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS categories (
    id BINARY(16) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$CATEGORIES_TABLE_SQL"
  
  # Create users table
  echo "Creating users table..."
  USERS_TABLE_SQL=$(cat << 'SQL'
  CREATE TABLE IF NOT EXISTS users (
    id BINARY(16) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$USERS_TABLE_SQL"
  
  # Insert sample categories
  echo "Inserting sample categories..."
  CATEGORIES_DATA_SQL=$(cat << 'SQL'
  INSERT INTO categories (id, name, description) VALUES
  (uuid_to_bin(UUID()), 'Electronics', 'Electronic devices and gadgets'),
  (uuid_to_bin(UUID()), 'Clothing', 'Apparel and fashion items'),
  (uuid_to_bin(UUID()), 'Books', 'Books and publications'),
  (uuid_to_bin(UUID()), 'Home & Kitchen', 'Home appliances and kitchen supplies'),
  (uuid_to_bin(UUID()), 'Sports', 'Sports equipment and accessories');
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$CATEGORIES_DATA_SQL"
  
  # Insert sample products
  echo "Inserting sample products..."
  PRODUCTS_DATA_SQL=$(cat << 'SQL'
  INSERT INTO products (id, name, description, price, stock_quantity) VALUES
  (uuid_to_bin(UUID()), 'Smartphone X', 'Latest smartphone with advanced features', 899.99, 50),
  (uuid_to_bin(UUID()), 'Laptop Pro', 'High-performance laptop for professionals', 1299.99, 25),
  (uuid_to_bin(UUID()), 'Wireless Headphones', 'Noise-cancelling wireless headphones', 199.99, 100),
  (uuid_to_bin(UUID()), 'Cotton T-shirt', 'Comfortable cotton t-shirt', 19.99, 200),
  (uuid_to_bin(UUID()), 'Denim Jeans', 'Classic denim jeans', 49.99, 150),
  (uuid_to_bin(UUID()), 'Programming Guide', 'Comprehensive programming guide', 29.99, 75),
  (uuid_to_bin(UUID()), 'Coffee Maker', 'Automatic coffee maker', 89.99, 30),
  (uuid_to_bin(UUID()), 'Blender', 'High-speed blender for smoothies', 69.99, 40),
  (uuid_to_bin(UUID()), 'Yoga Mat', 'Non-slip yoga mat', 24.99, 120),
  (uuid_to_bin(UUID()), 'Basketball', 'Official size basketball', 29.99, 80);
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$PRODUCTS_DATA_SQL"
  
  # Insert sample users
  echo "Inserting sample users..."
  USERS_DATA_SQL=$(cat << 'SQL'
  INSERT INTO users (id, email, name) VALUES
  (uuid_to_bin(UUID()), 'john.doe@example.com', 'John Doe'),
  (uuid_to_bin(UUID()), 'jane.smith@example.com', 'Jane Smith'),
  (uuid_to_bin(UUID()), 'bob.johnson@example.com', 'Bob Johnson'),
  (uuid_to_bin(UUID()), 'alice.williams@example.com', 'Alice Williams'),
  (uuid_to_bin(UUID()), 'charlie.brown@example.com', 'Charlie Brown');
SQL
  )
  
  docker exec mysql-devdb-triage mysql -h127.0.0.1 -uroot -pmysecretpassword sample_db -e "$USERS_DATA_SQL"
  
  echo "Sample data created successfully!"
else
  echo "Failed to connect to database"
  echo "Database connection test: FAILED"
  echo "Rails application is configured to use MySQL but connection test failed!"
  exit 1
fi
