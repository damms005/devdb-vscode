#!/bin/bash

# Pull the latest PostgreSQL image
docker pull postgres:latest

# Run a PostgreSQL container
docker run --name postgres-devdb-triage -e POSTGRES_PASSWORD=mysecretpassword -p 5432:5432 -d postgres

# Wait for the database to start
echo "Waiting for PostgreSQL to start..."
until docker exec postgres-devdb-triage pg_isready -U postgres; do
  sleep 1
done

# Create a sample database and table
docker exec -i postgres-devdb-triage psql -U postgres << EOF
CREATE DATABASE sample_db;
\c sample_db
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE book (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    published_date DATE,
    isbn VARCHAR(13),
    pages INT,
    available BOOLEAN DEFAULT TRUE
);
INSERT INTO book (title, author, published_date, isbn, pages, available) VALUES
('The Great Gatsby', 'F. Scott Fitzgerald', '1925-04-10', '9780743273565', 180, TRUE),
('1984', 'George Orwell', '1949-06-08', '9780451524935', 328, FALSE),
('To Kill a Mockingbird', 'Harper Lee', '1960-07-11', '9780061120084', 281, TRUE),
('Pride and Prejudice', 'Jane Austen', '1813-01-28', '9781503290563', 279, TRUE),
('The Catcher in the Rye', 'J.D. Salinger', '1951-07-16', '9780316769488', 214, FALSE);

EOF

echo "PostgreSQL triage setup complete."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
connect(
    dbname="sample_db",
    user="postgres",
    password="mysecretpassword",
    host="localhost",
    port="5432"
)
EXAMPLE_CONNECTION

echo "To stop the PostgreSQL container, run the following command:"
echo "docker stop postgres-devdb-triage && docker rm postgres-devdb-triage"
