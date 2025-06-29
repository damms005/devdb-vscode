#!/bin/bash

set -e

# Cleanup function to run on exit
cleanup() {
    if [[ -d "$TODO_APP_DIR" ]]; then
        print_info "Cleaning up ephemeral Rails application..."
        cd "$TODO_APP_DIR"
        # Remove everything except .gitignore
        find . -mindepth 1 -not -name '.gitignore' -exec rm -rf {} + 2>/dev/null || true
        print_success "Cleanup completed. Only .gitignore remains."
    fi
}

# Set trap to run cleanup on script exit
trap cleanup EXIT

# Default database type
DB_TYPE="${1:-sqlite}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validate database type
if [[ ! "$DB_TYPE" =~ ^(mysql|postgres|sqlite)$ ]]; then
    print_error "Invalid database type: $DB_TYPE"
    print_info "Supported types: mysql, postgres, sqlite"
    exit 1
fi

print_info "Setting up Rails application with $DB_TYPE database..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODO_APP_DIR="$SCRIPT_DIR/todo-app"

# Check if database containers are running (skip for SQLite)
if [[ "$DB_TYPE" != "sqlite" ]]; then
    case "$DB_TYPE" in
        "mysql")
            if ! docker ps --format "table {{.Names}}" | grep -q "mysql-devdb-triage"; then
                print_error "MySQL database container 'mysql-devdb-triage' is not running!"
                print_info "Please start the MySQL database container first:"
                print_info "  docker run -d --name mysql-devdb-triage -p 2222:3306 -e MYSQL_ROOT_PASSWORD=mysecretpassword mysql:8.0"
                exit 1
            fi
            print_success "MySQL database container is running"
            ;;
        "postgres")
            if ! docker ps --format "table {{.Names}}" | grep -q "postgres-devdb-triage"; then
                print_error "PostgreSQL database container 'postgres-devdb-triage' is not running!"
                print_info "Please start the PostgreSQL database container first:"
                print_info "  docker run -d --name postgres-devdb-triage -p 3333:5432 -e POSTGRES_PASSWORD=mysecretpassword postgres:16"
                exit 1
            fi
            print_success "PostgreSQL database container is running"
            ;;
    esac
fi

# Check if Rails and Ruby are available
if ! command -v rails &> /dev/null; then
    print_error "Rails is not installed. Please install Rails first:"
    print_info "  gem install rails"
    exit 1
fi

if ! command -v ruby &> /dev/null; then
    print_error "Ruby is not installed. Please install Ruby first."
    exit 1
fi

# Clear the todo-app directory
print_info "Clearing existing Rails application..."
rm -rf "$TODO_APP_DIR"
mkdir -p "$TODO_APP_DIR"

# Create a new Rails application in todo-app directory
print_info "Creating a new Rails application in todo-app..."
case "$DB_TYPE" in
    "mysql")
        rails new "$TODO_APP_DIR" --database=mysql --skip-bundle --force
        ;;
    "postgres")
        rails new "$TODO_APP_DIR" --database=postgresql --skip-bundle --force
        ;;
    "sqlite")
        rails new "$TODO_APP_DIR" --database=sqlite3 --skip-bundle --force
        ;;
esac

# Change to the todo-app directory
cd "$TODO_APP_DIR"

# Remove git-related files and setup gitignore for ephemeral application
print_info "Removing git repository and configuring gitignore for ephemeral app..."
rm -rf .git .github
rm -f .gitattributes

# Overwrite .gitignore to ignore everything except itself
cat > .gitignore << 'EOF'
# Ignore everything in this ephemeral Rails application directory
*
# But don't ignore this .gitignore file itself
!.gitignore
EOF

# Update database configuration
print_info "Configuring database connection..."
case "$DB_TYPE" in
    "mysql")
        cat > config/database.yml << 'EOF'
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
EOF
        ;;
    "postgres")
        cat > config/database.yml << 'EOF'
default: &default
  adapter: postgresql
  encoding: unicode
  host: 127.0.0.1
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
EOF
        ;;
    "sqlite")
        # SQLite config is fine as generated by Rails
        ;;
esac

# Install gems
print_info "Installing gems..."
bundle install

# Create controllers
print_info "Creating controllers..."
cat > app/controllers/home_controller.rb << 'EOF'
class HomeController < ApplicationController
  def index
    @products = execute_query("SELECT * FROM products LIMIT 10")
    @users = execute_query("SELECT * FROM users LIMIT 5")
    @categories = execute_query("SELECT * FROM categories")
  end

  private

  def execute_query(sql)
    result = ActiveRecord::Base.connection.execute(sql)
    case ActiveRecord::Base.connection.adapter_name.downcase
    when 'mysql2'
      result.map { |row| row.is_a?(Hash) ? row : Hash[result.fields.zip(row)] }
    when 'postgresql'
      result.map { |row| row }
    when 'sqlite'
      result.map { |row| row }
    else
      result.map { |row| row }
    end
  rescue => e
    Rails.logger.error "Query failed: #{e.message}"
    []
  end
end
EOF

cat > app/controllers/todos_controller.rb << 'EOF'
class TodosController < ApplicationController
  protect_from_forgery with: :null_session

  def index
    @todos = execute_query("SELECT * FROM todos ORDER BY created_at DESC")
  end

  def create
    title = params[:title]&.strip
    if title.present?
      case ActiveRecord::Base.connection.adapter_name.downcase
      when 'mysql2'
        id = SecureRandom.uuid
        execute_query("INSERT INTO todos (id, title) VALUES ('#{id}', '#{ActiveRecord::Base.connection.quote_string(title)}')")
      when 'postgresql'
        execute_query("INSERT INTO todos (title) VALUES ('#{ActiveRecord::Base.connection.quote_string(title)}')")
      when 'sqlite'
        id = SecureRandom.uuid
        execute_query("INSERT INTO todos (id, title) VALUES ('#{id}', '#{ActiveRecord::Base.connection.quote_string(title)}')")
      end
    end
    redirect_to todos_path
  end

  def toggle
    id = params[:id]
    todo = execute_query("SELECT * FROM todos WHERE id = '#{id}' LIMIT 1").first
    if todo
      case ActiveRecord::Base.connection.adapter_name.downcase
      when 'mysql2'
        new_status = todo['completed'] ? 0 : 1
      when 'postgresql'
        new_status = !todo['completed']
      when 'sqlite'
        new_status = todo['completed'] == 1 ? 0 : 1
      end
      execute_query("UPDATE todos SET completed = #{new_status} WHERE id = '#{id}'")
    end
    redirect_to todos_path
  end

  def destroy
    id = params[:id]
    execute_query("DELETE FROM todos WHERE id = '#{id}'")
    redirect_to todos_path
  end

  private

  def execute_query(sql)
    result = ActiveRecord::Base.connection.execute(sql)
    case ActiveRecord::Base.connection.adapter_name.downcase
    when 'mysql2'
      result.map { |row| row.is_a?(Hash) ? row : Hash[result.fields.zip(row)] }
    when 'postgresql'
      result.map { |row| row }
    when 'sqlite'
      result.map { |row| row }
    else
      result.map { |row| row }
    end
  rescue => e
    Rails.logger.error "Query failed: #{e.message}"
    []
  end
end
EOF

# Create views
print_info "Creating views..."
mkdir -p app/views/home
# Create a capitalized version of DB_TYPE
DB_TYPE_CAPITALIZED=$(echo "${DB_TYPE}" | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')

cat > app/views/home/index.html.erb << EOF
<div style="font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; text-align: center;">Rails ${DB_TYPE_CAPITALIZED} Demo Application</h1>
  
  <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
    <h2 style="color: #28a745;">🎉 Success! Rails is connected to ${DB_TYPE_CAPITALIZED}</h2>
    <p>This application is running Rails with a ${DB_TYPE_CAPITALIZED} database backend.</p>
EOF

case "$DB_TYPE" in
    "mysql")
        cat >> app/views/home/index.html.erb << 'EOF'
    <p><strong>Database:</strong> MySQL via Docker container</p>
    <p><strong>Connection:</strong> 127.0.0.1:2222</p>
EOF
        ;;
    "postgres")
        cat >> app/views/home/index.html.erb << 'EOF'
    <p><strong>Database:</strong> PostgreSQL via Docker container</p>
    <p><strong>Connection:</strong> 127.0.0.1:3333</p>
EOF
        ;;
    "sqlite")
        cat >> app/views/home/index.html.erb << 'EOF'
    <p><strong>Database:</strong> SQLite (file-based)</p>
    <p><strong>File:</strong> storage/development.sqlite3</p>
EOF
        ;;
esac

cat >> app/views/home/index.html.erb << 'EOF'
    <p style="margin-top: 15px;"><a href="/todos" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">📝 Try the Todo App</a></p>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px;">
    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #007bff; margin-top: 0;">📦 Products (<%= @products.length %>)</h3>
      <% @products.each do |product| %>
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong><%= product['name'] %></strong><br>
          <small style="color: #666;"><%= product['description'] %></small><br>
          <span style="color: #28a745; font-weight: bold;">$<%= product['price'] %></span>
        </div>
      <% end %>
    </div>

    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #28a745; margin-top: 0;">👥 Users (<%= @users.length %>)</h3>
      <% @users.each do |user| %>
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong><%= user['name'] %></strong><br>
          <small style="color: #666;"><%= user['email'] %></small>
        </div>
      <% end %>
    </div>

    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #ffc107; margin-top: 0;">🏷️ Categories (<%= @categories.length %>)</h3>
      <% @categories.each do |category| %>
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong><%= category['name'] %></strong><br>
          <small style="color: #666;"><%= category['description'] %></small>
        </div>
      <% end %>
    </div>
  </div>
</div>
EOF

mkdir -p app/views/todos
cat > app/views/todos/index.html.erb << EOF
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; text-align: center;">📝 Todo App - ${DB_TYPE_CAPITALIZED} Backend</h1>
  
  <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
    <h3>Add New Todo</h3>
    <form action="/todos" method="post" style="display: flex; gap: 10px;">
      <input type="text" name="title" placeholder="Enter todo item..." 
             style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" required>
      <button type="submit" 
              style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer;">Add Todo</button>
    </form>
  </div>

  <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h3 style="margin-top: 0;">Your Todos (<%= @todos.length %>)</h3>
    
    <% if @todos.empty? %>
      <p style="color: #666; text-align: center; padding: 40px;">No todos yet. Add one above to get started!</p>
    <% else %>
      <% @todos.each do |todo| %>
EOF

case "$DB_TYPE" in
    "sqlite")
        cat >> app/views/todos/index.html.erb << 'EOF'
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 15px; border-bottom: 1px solid #eee; <%= 'background: #f8f9fa;' if todo['completed'] == 1 %>">
          <div style="flex: 1;">
            <span style="<%= 'text-decoration: line-through; color: #666;' if todo['completed'] == 1 %>">
              <%= todo['title'] %>
            </span>
            <% if todo['completed'] == 1 %>
              <span style="color: #28a745; font-size: 12px; margin-left: 10px;">✓ Completed</span>
            <% end %>
          </div>
          
          <div style="display: flex; gap: 10px;">
            <form action="/todos/<%= todo['id'] %>/toggle" method="post" style="display: inline;">
              <button type="submit" 
                      style="background: <%= todo['completed'] == 1 ? '#ffc107' : '#28a745' %>; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                <%= todo['completed'] == 1 ? 'Undo' : 'Done' %>
              </button>
            </form>
            
            <form action="/todos/<%= todo['id'] %>" method="post" style="display: inline;">
              <input type="hidden" name="_method" value="delete">
              <button type="submit" 
                      style="background: #dc3545; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;"
                      onclick="return confirm('Are you sure you want to delete this todo?')">
                Delete
              </button>
            </form>
          </div>
        </div>
EOF
        ;;
    *)
        cat >> app/views/todos/index.html.erb << 'EOF'
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 15px; border-bottom: 1px solid #eee; <%= 'background: #f8f9fa;' if todo['completed'] %>">
          <div style="flex: 1;">
            <span style="<%= 'text-decoration: line-through; color: #666;' if todo['completed'] %>">
              <%= todo['title'] %>
            </span>
            <% if todo['completed'] %>
              <span style="color: #28a745; font-size: 12px; margin-left: 10px;">✓ Completed</span>
            <% end %>
          </div>
          
          <div style="display: flex; gap: 10px;">
            <form action="/todos/<%= todo['id'] %>/toggle" method="post" style="display: inline;">
              <button type="submit" 
                      style="background: <%= todo['completed'] ? '#ffc107' : '#28a745' %>; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                <%= todo['completed'] ? 'Undo' : 'Done' %>
              </button>
            </form>
            
            <form action="/todos/<%= todo['id'] %>" method="post" style="display: inline;">
              <input type="hidden" name="_method" value="delete">
              <button type="submit" 
                      style="background: #dc3545; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;"
                      onclick="return confirm('Are you sure you want to delete this todo?')">
                Delete
              </button>
            </form>
          </div>
        </div>
EOF
        ;;
esac

cat >> app/views/todos/index.html.erb << 'EOF'
      <% end %>
    <% end %>
  </div>
  
  <div style="text-align: center; margin-top: 30px;">
    <a href="/" style="color: #007bff; text-decoration: none;">← Back to Home</a>
  </div>
</div>
EOF

# Add routes
print_info "Adding routes..."
sed -i.bak '3i\
  root "home#index"\
  resources :todos, only: [:index, :create, :destroy] do\
    member do\
      post :toggle\
    end\
  end
' config/routes.rb

# Create database setup script
print_info "Creating database setup script..."
cat > setup_database.rb << 'EOF'
require_relative 'config/environment'

def setup_database
  adapter = ActiveRecord::Base.connection.adapter_name.downcase
  
  case adapter
  when 'mysql2'
    setup_mysql
  when 'postgresql'
    setup_postgresql
  when 'sqlite'
    setup_sqlite
  end
end

def setup_mysql
  print "Waiting for MySQL connection..."
  max_attempts = 30
  attempts = 0

  begin
    ActiveRecord::Base.connection.execute("SELECT 1")
    puts " Connected!"
  rescue => e
    attempts += 1
    if attempts < max_attempts
      print "."
      sleep 1
      retry
    else
      puts " Failed to connect after #{max_attempts} attempts"
      puts "Error: #{e.message}"
      exit 1
    end
  end

  # Create database if it doesn't exist
  ActiveRecord::Base.connection.execute("CREATE DATABASE IF NOT EXISTS sample_db")
  ActiveRecord::Base.connection.execute("USE sample_db")

  create_mysql_tables
  insert_mysql_data
end

def setup_postgresql
  print "Waiting for PostgreSQL connection..."
  max_attempts = 30
  attempts = 0

  begin
    ActiveRecord::Base.connection.execute("SELECT 1")
    puts " Connected!"
  rescue => e
    attempts += 1
    if attempts < max_attempts
      print "."
      sleep 1
      retry
    else
      puts " Failed to connect after #{max_attempts} attempts"
      puts "Error: #{e.message}"
      exit 1
    end
  end

  # Create database if it doesn't exist
  begin
    ActiveRecord::Base.connection.execute("CREATE DATABASE sample_db")
  rescue ActiveRecord::StatementInvalid => e
    if e.message.include?("already exists")
      puts "Database already exists, continuing..."
    else
      raise e
    end
  end

  # Reconnect to sample_db
  config = ActiveRecord::Base.configurations.configs_for(env_name: Rails.env).first.configuration_hash.dup
  config[:database] = 'sample_db'
  ActiveRecord::Base.establish_connection(config)

  # Enable extensions
  ActiveRecord::Base.connection.execute("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"")
  ActiveRecord::Base.connection.execute("CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"")

  create_postgresql_tables
  insert_postgresql_data
end

def setup_sqlite
  print "Setting up SQLite database..."
  create_sqlite_tables
  insert_sqlite_data
end

def create_mysql_tables
  print "Creating MySQL tables..."
  
  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS todos (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      stock_quantity INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  SQL

  puts " Done!"
end

def create_postgresql_tables
  print "Creating PostgreSQL tables..."
  
  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255) NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      stock_quantity INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  puts " Done!"
end

def create_sqlite_tables
  print "Creating SQLite tables..."
  
  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  ActiveRecord::Base.connection.execute(<<~SQL)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  SQL

  puts " Done!"
end

def insert_mysql_data
  print "Inserting MySQL sample data..."

  categories = [
    { id: SecureRandom.uuid, name: 'Electronics', description: 'Electronic devices and gadgets' },
    { id: SecureRandom.uuid, name: 'Clothing', description: 'Apparel and fashion items' },
    { id: SecureRandom.uuid, name: 'Books', description: 'Books and publications' }
  ]

  categories.each do |category|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT IGNORE INTO categories (id, name, description) VALUES
      ('#{category[:id]}', '#{category[:name]}', '#{category[:description]}')
    SQL
  end

  products = [
    { id: SecureRandom.uuid, name: 'Smartphone X', description: 'Latest smartphone with advanced features', price: 899.99, stock_quantity: 50 },
    { id: SecureRandom.uuid, name: 'Laptop Pro', description: 'High-performance laptop for professionals', price: 1299.99, stock_quantity: 25 },
    { id: SecureRandom.uuid, name: 'Cotton T-shirt', description: 'Comfortable cotton t-shirt', price: 19.99, stock_quantity: 200 }
  ]

  products.each do |product|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT IGNORE INTO products (id, name, description, price, stock_quantity) VALUES
      ('#{product[:id]}', '#{product[:name]}', '#{product[:description]}', #{product[:price]}, #{product[:stock_quantity]})
    SQL
  end

  users = [
    { id: SecureRandom.uuid, email: 'john.doe@example.com', name: 'John Doe' },
    { id: SecureRandom.uuid, email: 'jane.smith@example.com', name: 'Jane Smith' }
  ]

  users.each do |user|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT IGNORE INTO users (id, email, name) VALUES
      ('#{user[:id]}', '#{user[:email]}', '#{user[:name]}')
    SQL
  end

  puts " Done!"
end

def insert_postgresql_data
  print "Inserting PostgreSQL sample data..."

  categories = [
    { name: 'Electronics', description: 'Electronic devices and gadgets' },
    { name: 'Clothing', description: 'Apparel and fashion items' },
    { name: 'Books', description: 'Books and publications' }
  ]

  categories.each do |category|
    begin
      ActiveRecord::Base.connection.execute(<<~SQL)
        INSERT INTO categories (name, description) VALUES
        ('#{category[:name]}', '#{category[:description]}')
      SQL
    rescue ActiveRecord::RecordNotUnique, PG::UniqueViolation
      # Category already exists, skip
    end
  end

  products = [
    { name: 'Smartphone X', description: 'Latest smartphone with advanced features', price: 899.99, stock_quantity: 50 },
    { name: 'Laptop Pro', description: 'High-performance laptop for professionals', price: 1299.99, stock_quantity: 25 },
    { name: 'Cotton T-shirt', description: 'Comfortable cotton t-shirt', price: 19.99, stock_quantity: 200 }
  ]

  products.each do |product|
    begin
      ActiveRecord::Base.connection.execute(<<~SQL)
        INSERT INTO products (name, description, price, stock_quantity) VALUES
        ('#{product[:name]}', '#{product[:description]}', #{product[:price]}, #{product[:stock_quantity]})
      SQL
    rescue ActiveRecord::RecordNotUnique, PG::UniqueViolation
      # Product already exists, skip
    end
  end

  users = [
    { email: 'john.doe@example.com', name: 'John Doe' },
    { email: 'jane.smith@example.com', name: 'Jane Smith' }
  ]

  users.each do |user|
    begin
      ActiveRecord::Base.connection.execute(<<~SQL)
        INSERT INTO users (email, name) VALUES
        ('#{user[:email]}', '#{user[:name]}')
      SQL
    rescue ActiveRecord::RecordNotUnique, PG::UniqueViolation
      # User already exists, skip
    end
  end

  puts " Done!"
end

def insert_sqlite_data
  print "Inserting SQLite sample data..."

  categories = [
    { id: SecureRandom.uuid, name: 'Electronics', description: 'Electronic devices and gadgets' },
    { id: SecureRandom.uuid, name: 'Clothing', description: 'Apparel and fashion items' },
    { id: SecureRandom.uuid, name: 'Books', description: 'Books and publications' }
  ]

  categories.each do |category|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT OR IGNORE INTO categories (id, name, description) VALUES
      ('#{category[:id]}', '#{category[:name]}', '#{category[:description]}')
    SQL
  end

  products = [
    { id: SecureRandom.uuid, name: 'Smartphone X', description: 'Latest smartphone with advanced features', price: 899.99, stock_quantity: 50 },
    { id: SecureRandom.uuid, name: 'Laptop Pro', description: 'High-performance laptop for professionals', price: 1299.99, stock_quantity: 25 },
    { id: SecureRandom.uuid, name: 'Cotton T-shirt', description: 'Comfortable cotton t-shirt', price: 19.99, stock_quantity: 200 }
  ]

  products.each do |product|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT OR IGNORE INTO products (id, name, description, price, stock_quantity) VALUES
      ('#{product[:id]}', '#{product[:name]}', '#{product[:description]}', #{product[:price]}, #{product[:stock_quantity]})
    SQL
  end

  users = [
    { id: SecureRandom.uuid, email: 'john.doe@example.com', name: 'John Doe' },
    { id: SecureRandom.uuid, email: 'jane.smith@example.com', name: 'Jane Smith' }
  ]

  users.each do |user|
    ActiveRecord::Base.connection.execute(<<~SQL)
      INSERT OR IGNORE INTO users (id, email, name) VALUES
      ('#{user[:id]}', '#{user[:email]}', '#{user[:name]}')
    SQL
  end

  puts " Done!"
end

# Run the setup
setup_database
puts "Database setup completed successfully!"
EOF

# Setup database and sample data
print_info "Setting up database and sample data..."
ruby setup_database.rb

# Find an available port
print_info "Finding available port..."
PORT=3000
while lsof -i :$PORT > /dev/null 2>&1; do
    PORT=$((PORT + 1))
done
print_success "Using port: $PORT"

# Start the Rails server
print_info "Starting Rails server on port $PORT..."
print_success "Rails application is now running!"
print_success "🚀 Open your browser and go to: http://localhost:$PORT"
print_info "Application location: $TODO_APP_DIR"
print_info "To stop the server: Press Ctrl+C"
print_info ""
print_info "Starting server..."

# Start the server
rails server -b 0.0.0.0 -p $PORT
