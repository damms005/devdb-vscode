#!/bin/bash

# Pull the latest MSSQL image
# Use same as in test https://github.com/damms005/devdb-vscode/blob/5f3b507836d93b90fb1624a1008b6415ff66704b/src/test/suite/engines/mssql.test.ts#L13
docker pull mcr.microsoft.com/mssql/server:2019-latest

# Check if container exists and start it, or create a new one
if [ "$(docker ps -a --filter 'name=^/mssql-devdb-triage$' --format '{{.Names}}')" == "mssql-devdb-triage" ]; then
    echo "Container exists. Starting mssql-devdb-triage if not already running..."
    docker start mssql-devdb-triage
else
    echo "Container does not exist. Creating a new mssql-devdb-triage container..."
    docker run --name mssql-devdb-triage -e 'ACCEPT_EULA=Y' -e 'SA_PASSWORD=MyS3cretPassw0rd' -p 1111:1433 -d mcr.microsoft.com/mssql/server:2019-latest
fi

# Install the SQL tools if not present
echo "Installing mssql-tools and dependencies..."
docker exec --user root mssql-devdb-triage bash -c "apt-get update && apt-get install -y curl gnupg"
docker exec --user root mssql-devdb-triage bash -c "curl https://packages.microsoft.com/keys/microsoft.asc | apt-key add -"
docker exec --user root mssql-devdb-triage bash -c "curl https://packages.microsoft.com/config/debian/10/prod.list > /etc/apt/sources.list.d/mssql-release.list"
docker exec --user root mssql-devdb-triage bash -c "apt-get update && ACCEPT_EULA=Y apt-get install -y mssql-tools unixodbc-dev"

# Dynamically locate the sqlcmd binary using find
echo "Locating sqlcmd binary..."
SQLCMD_PATH=$(docker exec mssql-devdb-triage bash -c 'find /opt -name sqlcmd 2>/dev/null | head -1 || echo ""')

# If sqlcmd is not found, try to reinstall and check again
if [ -z "$SQLCMD_PATH" ]; then
  echo "sqlcmd not found. Attempting to reinstall mssql-tools..."
  docker exec --user root mssql-devdb-triage bash -c "ACCEPT_EULA=Y apt-get install -y mssql-tools unixodbc-dev"

  # Check again after reinstall
  SQLCMD_PATH=$(docker exec mssql-devdb-triage bash -c 'find /opt -name sqlcmd 2>/dev/null | head -1 || echo ""')

  # Check common locations as fallback
  if [ -z "$SQLCMD_PATH" ]; then
    for path in "/opt/mssql-tools/bin/sqlcmd" "/opt/mssql-tools18/bin/sqlcmd"; do
      if docker exec mssql-devdb-triage bash -c "[ -f $path ]"; then
        SQLCMD_PATH=$path
        break
      fi
    done
  fi

  # Exit if still not found
  if [ -z "$SQLCMD_PATH" ]; then
    echo "ERROR: Could not locate sqlcmd binary after installation attempts. Exiting."
    exit 1
  fi
fi

echo "Using sqlcmd at: $SQLCMD_PATH"

# Wait for the database to start using the detected sqlcmd path
echo "Waiting for MSSQL to start..."
until docker exec mssql-devdb-triage bash -c "[ -f \"$SQLCMD_PATH\" ] && \"$SQLCMD_PATH\" -S localhost -U SA -P 'MyS3cretPassw0rd' -Q 'SELECT 1'" &> /dev/null; do
  echo "Waiting for SQL Server to be ready or for sqlcmd to be available..."
  sleep 2
done

# Create a sample database and table
# Using the dynamically detected sqlcmd path
docker exec -i mssql-devdb-triage "$SQLCMD_PATH" -S localhost -U SA -P 'MyS3cretPassw0rd' << EOF
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
    "host"     : "localhost",
    "port"     : 1111,
    "username" : "SA",
    "password" : "MyS3cretPassw0rd",
    "database" : "sample_db"
}
EXAMPLE_CONNECTION

echo "To stop the MSSQL container, run the following command:"
echo "docker stop mssql-devdb-triage && docker rm mssql-devdb-triage"
