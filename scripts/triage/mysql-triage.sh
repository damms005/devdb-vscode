#!/bin/bash

# Pull the latest MySQL image
# Use same as in test https://github.com/damms005/devdb-vscode/blob/84d2bd86595db2ecb21c6ffbe8b27b1459bebd92/src/test/suite/engines/mysql.test.ts#L13
docker pull mysql:8.0.31

# Check if container already exists
if [ "$(docker ps -a --filter 'name=^/mysql-devdb-triage$' --format '{{.Names}}')" == "mysql-devdb-triage" ]; then
    echo "Container exists. Starting mysql-devdb-triage if not already running..."
    docker start mysql-devdb-triage
else
    echo "Container does not exist. Creating a new mysql-devdb-triage container..."
    docker run --name mysql-devdb-triage -e MYSQL_ROOT_PASSWORD=mysecretpassword -p 2222:3306 -d mysql:8.0.31
fi

# Wait for the database to start
echo "Waiting for MySQL to start..."
until docker exec mysql-devdb-triage mysqladmin ping -h "localhost" --silent; do
  sleep 1
done

# Create a sample database and table
docker exec -i mysql-devdb-triage mysql -uroot -pmysecretpassword -P 2222 << EOF
CREATE DATABASE IF NOT EXISTS sample_db;
USE sample_db;

CREATE TABLE IF NOT EXISTS book (
    id INT AUTO_INCREMENT PRIMARY KEY,
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

echo "MySQL triage setup complete."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
{
    "host"     : "localhost",
    "port"     : 2222,
    "username" : "root",
    "password" : "mysecretpassword",
    "database" : "sample_db"
}
EXAMPLE_CONNECTION

echo "To stop the MySQL container, run the following command:"
echo "docker stop mysql-devdb-triage && docker rm mysql-devdb-triage"
