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
