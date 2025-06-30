# Rails Dynamic Database Boot System

A script that generates and runs Rails applications with different database configurations on-demand.

## Quick Start

```bash
# Run with SQLite (default)
./boot.sh

# Run with MySQL
./boot.sh mysql

# Run with PostgreSQL
./boot.sh postgres
```

## Prerequisites

- Ruby 3.0+
- Rails 8.0+
- Docker (for MySQL/PostgreSQL)

## Features

- Supports SQLite, MySQL, and PostgreSQL
- Automatically creates a sample todo application
- Loads demo data for testing
- Finds available ports automatically (starting from 3000)
- Cleans up when stopped (Ctrl+C)

## Database Setup

### MySQL
```bash
docker run -d --name mysql-devdb-triage -p 2222:3306 -e MYSQL_ROOT_PASSWORD=mysecretpassword mysql:8.0
```

### PostgreSQL
```bash
docker run -d --name postgres-devdb-triage -p 3333:5432 -e POSTGRES_PASSWORD=mysecretpassword postgres:16
```

## Note

- Connection details are printed when the script runs
- The application is ephemeral - all data is lost when stopped
- The generated application is ignored by Git

## Troubleshooting

- For database errors: Check if containers are running
- For port conflicts: The script will find an available port
- If Rails is missing: Run `gem install rails`
