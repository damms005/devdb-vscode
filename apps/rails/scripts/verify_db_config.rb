#!/usr/bin/env ruby
require_relative '../config/environment'

# Get the current database configuration
db_config = ActiveRecord::Base.connection_db_config.configuration_hash

puts "=== Current Database Configuration ==="
puts "Adapter: #{db_config[:adapter]}"
puts "Database: #{db_config[:database]}"

case db_config[:adapter]
when 'sqlite3'
  puts "SQLite configuration verified!"
  puts "Database path: #{db_config[:database]}"
  expected_path = Rails.env.development? ? "storage/development.sqlite3" : Rails.env.test? ? "storage/test.sqlite3" : "storage/production.sqlite3"
  puts "Expected path: #{expected_path}"
  puts "ASSERTION: #{db_config[:database].end_with?(expected_path) ? 'PASSED' : 'FAILED'}"

when 'postgresql'
  puts "PostgreSQL configuration verified!"
  puts "Host: #{db_config[:host]}"
  puts "Port: #{db_config[:port]}"
  puts "Username: #{db_config[:username]}"
  puts "Database: #{db_config[:database]}"
  puts "ASSERTION: #{db_config[:host] == 'localhost' && db_config[:port] == 3333 && db_config[:username] == 'postgres' ? 'PASSED' : 'FAILED'}"

when 'mysql2'
  puts "MySQL configuration verified!"
  puts "Host: #{db_config[:host]}"
  puts "Port: #{db_config[:port]}"
  puts "Username: #{db_config[:username]}"
  puts "Database: #{db_config[:database]}"
  puts "ASSERTION: #{db_config[:host] == 'localhost' && db_config[:port] == 2222 && db_config[:username] == 'root' ? 'PASSED' : 'FAILED'}"

else
  puts "Unknown database adapter: #{db_config[:adapter]}"
  puts "ASSERTION: FAILED"
end

# Additional verification: Check if we can connect to the database
begin
  ActiveRecord::Base.connection.execute("SELECT 1")
  puts "Database connection: SUCCESSFUL"
rescue => e
  puts "Database connection: FAILED"
  puts "Error: #{e.message}"
end
