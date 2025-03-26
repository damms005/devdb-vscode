#!/bin/bash

# Pull the latest PostgreSQL image
docker pull postgres:latest

# Check if container exists
if [ "$(docker ps -a --filter 'name=^/postgres-devdb-triage$' --format '{{.Names}}')" == "postgres-devdb-triage" ]; then
    echo "Container exists. Starting postgres-devdb-triage if not already running..."
    docker start postgres-devdb-triage
else
    echo "Container does not exist. Creating a new postgres-devdb-triage container..."
    docker run --name postgres-devdb-triage -e POSTGRES_PASSWORD=mysecretpassword -p 3333:5432 -d postgres
fi

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
    available BOOLEAN DEFAULT TRUE,
    "user" UUID,
    "order" INT
);
INSERT INTO book (title, author, published_date, isbn, pages, available, "user", "order") VALUES
('The Great Gatsby', 'F. Scott Fitzgerald', '1925-04-10', '9780743273565', 180, TRUE, uuid_generate_v4(), 1),
('1984', 'George Orwell', '1949-06-08', '9780451524935', 328, FALSE, uuid_generate_v4(), 2),
('To Kill a Mockingbird', 'Harper Lee', '1960-07-11', '9780061120084', 281, TRUE, uuid_generate_v4(), 3),
('Pride and Prejudice', 'Jane Austen', '1813-01-28', '9781503290563', 279, TRUE, uuid_generate_v4(), 4),
('The Catcher in the Rye', 'J.D. Salinger', '1951-07-16', '9780316769488', 214, FALSE, uuid_generate_v4(), 5);

EOF

echo "PostgreSQL triage setup complete."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
{
    "host"     : "localhost",
    "port"     : 3333,
    "username" : "postgres",
    "password" : "mysecretpassword",
    "database" : "sample_db"
}
EXAMPLE_CONNECTION

echo "You can connect to it from inside the container like: 'psql sample_db postgres'"
echo "To stop the PostgreSQL container, run the following command:"
echo "docker stop postgres-devdb-triage && docker rm postgres-devdb-triage"
