#!/bin/bash

# Pull the latest MSSQL image
docker pull mcr.microsoft.com/mssql/server:2019-latest

# Check if container exists and start it, or create a new one
if [ "$(docker ps -a --filter 'name=^/mssql-devdb-triage$' --format '{{.Names}}')" == "mssql-devdb-triage" ]; then
    echo "Container exists. Starting mssql-devdb-triage if not already running..."
    docker start mssql-devdb-triage
else
    echo "Container does not exist. Creating a new mssql-devdb-triage container..."
    docker run --name mssql-devdb-triage -e 'ACCEPT_EULA=Y' -e 'SA_PASSWORD=MyS3cretPassw0rd' -p 1433:1433 -d mcr.microsoft.com/mssql/server:2019-latest
fi

# Wait for the database to start
echo "Waiting for MSSQL to start..."
until docker exec mssql-devdb-triage /opt/mssql-tools/bin/sqlcmd -S localhost -U SA -P 'MyS3cretPassw0rd' -Q "SELECT 1" &> /dev/null; do
  sleep 1
done

# Create a sample database and table
docker exec -i mssql-devdb-triage /opt/mssql-tools/bin/sqlcmd -S localhost -U SA -P 'MyS3cretPassw0rd' << EOF
CREATE DATABASE sample_db;
GO
USE sample_db;
GO

CREATE TABLE book (
    id INT IDENTITY(1,1) PRIMARY KEY,
    title NVARCHAR(255) NOT NULL,
    author NVARCHAR(255) NOT NULL,
    published_date DATE,
    isbn NVARCHAR(13),
    pages INT,
    available BIT DEFAULT 1
);
GO
INSERT INTO book (title, author, published_date, isbn, pages, available) VALUES
('The Great Gatsby', 'F. Scott Fitzgerald', '1925-04-10', '9780743273565', 180, 1),
('1984', 'George Orwell', '1949-06-08', '9780451524935', 328, 0),
('To Kill a Mockingbird', 'Harper Lee', '1960-07-11', '9780061120084', 281, 1),
('Pride and Prejudice', 'Jane Austen', '1813-01-28', '9781503290563', 279, 1),
('The Catcher in the Rye', 'J.D. Salinger', '1951-07-16', '9780316769488', 214, 0);
GO

EOF

echo "MSSQL triage setup complete."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
{
    "dbname"   : "sample_db",
    "user"     : "SA",
    "password" : "MyS3cretPassw0rd",
    "host"     : "localhost",
    "port"     : "1433"
}
EXAMPLE_CONNECTION

echo "To stop the MSSQL container, run the following command:"
echo "docker stop mssql-devdb-triage && docker rm mssql-devdb-triage"
