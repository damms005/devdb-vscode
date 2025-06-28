#!/usr/bin/env ruby
require 'yaml'

# Load the database configuration
db_config_path = File.join(File.dirname(__FILE__), '..', 'config', 'database.yml')
db_config = YAML.load_file(db_config_path, aliases: true)

# Get the development configuration
dev_config = db_config['development']

puts "=== Current Database Configuration ==="
puts "Adapter: #{dev_config['adapter']}"

case dev_config['adapter']
when 'sqlite3'
  puts "SQLite configuration verified!"
  puts "Database path: #{dev_config['database']}"
  expected_path = "storage/development.sqlite3"
  puts "Expected path: #{expected_path}"
  puts "ASSERTION: #{dev_config['database'] == expected_path ? 'PASSED' : 'FAILED'}"

when 'postgresql'
  puts "PostgreSQL configuration verified!"
  puts "Host: #{dev_config['host']}"
  puts "Port: #{dev_config['port']}"
  puts "Username: #{dev_config['username']}"
  puts "Database: #{dev_config['database']}"
  expected = {
    'host' => 'localhost',
    'port' => 3333,
    'username' => 'postgres',
    'database' => 'sample_db'
  }
  
  assertion_passed = expected.all? { |k, v| dev_config[k] == v }
  puts "ASSERTION: #{assertion_passed ? 'PASSED' : 'FAILED'}"

when 'mysql2'
  puts "MySQL configuration verified!"
  puts "Host: #{dev_config['host']}"
  puts "Port: #{dev_config['port']}"
  puts "Username: #{dev_config['username']}"
  puts "Database: #{dev_config['database']}"
  expected = {
    'host' => 'localhost',
    'port' => 2222,
    'username' => 'root',
    'database' => 'sample_db'
  }
  
  assertion_passed = expected.all? { |k, v| dev_config[k] == v }
  puts "ASSERTION: #{assertion_passed ? 'PASSED' : 'FAILED'}"

else
  puts "Unknown database adapter: #{dev_config['adapter']}"
  puts "ASSERTION: FAILED"
end
