# Rails Dynamic Database Boot System

This directory contains a dynamic Rails application boot system that generates and runs Rails applications with different database configurations on-demand.

## Overview

Instead of maintaining a full Rails application codebase, this system uses a single `boot.sh` script that:

1. Validates the requested database type
2. Checks for required database containers (for MySQL/PostgreSQL)
3. Creates a fresh Rails application in the `todo-app` directory
4. Configures the application to connect to the specified database
5. Sets up sample data automatically
6. Starts a local Rails server

**Note**: The Rails application runs locally on your machine, but connects to databases running in Docker containers (for MySQL/PostgreSQL) or uses local SQLite files.

## Usage

### Basic Syntax
```bash
./boot.sh [database_type]
```

### Supported Database Types
- `sqlite` (default) - No external database container required
- `mysql` - Requires MySQL container to be running
- `postgres` - Requires PostgreSQL container to be running

### Examples

#### SQLite (Default)
```bash
./boot.sh
# or explicitly
./boot.sh sqlite
```

#### MySQL
First, ensure MySQL container is running:
```bash
docker run -d --name mysql-devdb-triage -p 2222:3306 -e MYSQL_ROOT_PASSWORD=mysecretpassword mysql:8.0
```

Then run the Rails app:
```bash
./boot.sh mysql
```

#### PostgreSQL
First, ensure PostgreSQL container is running:
```bash
docker run -d --name postgres-devdb-triage -p 3333:5432 -e POSTGRES_PASSWORD=mysecretpassword postgres:16
```

Then run the Rails app:
```bash
./boot.sh postgres
```

## Features

### Automatic Port Detection
The script automatically finds an available port starting from 3000 to avoid conflicts with existing services.

### Sample Data
Each Rails application comes pre-loaded with sample data:
- **Products**: Electronics, clothing, books, etc. with prices and stock quantities
- **Categories**: Organized product categories
- **Users**: Sample user accounts with email addresses

### Database-Specific Configurations
- **MySQL**: Uses UTF8MB4 encoding, custom UUID functions, and proper connection pooling
- **PostgreSQL**: Enables uuid-ossp and pgcrypto extensions, uses native UUID types
- **SQLite**: File-based storage with string-based UUID simulation

### Web Interface
Each application provides a clean web interface displaying:
- Database connection status
- Sample products with pricing
- User listings
- Category information

### Todo App
A fully functional todo application is available at `/todos` that demonstrates database CRUD operations:
- **Add todos**: Simple form to create new todo items
- **Mark as done**: Toggle completion status of todo items
- **Delete todos**: Remove todo items permanently
- **List todos**: View all todos with their current status

The todo app is designed to be ephemeral - all data is lost when the container is stopped, making it perfect for testing database functionality without persistence concerns.

## Generated Files

### Dockerfile
A database-specific Dockerfile is generated in the same directory and contains:
- Ruby 3.2 base image
- Database-specific client tools
- Rails 8.0 application setup
- Database configuration
- Sample data initialization scripts
- Web interface setup

**Note**: The generated Dockerfile is ignored by Git (see `.gitignore`) since it's created dynamically.

### Container Names
Containers are named using the pattern: `devdb-rails-{database_type}`
- `devdb-rails-sqlite`
- `devdb-rails-mysql`
- `devdb-rails-postgres`

## Management Commands

### View Application Logs
```bash
docker logs devdb-rails-{database_type}
```

### Stop Application
```bash
docker stop devdb-rails-{database_type}
```

### Remove Application
```bash
docker rm devdb-rails-{database_type}
```

### Remove Everything (Container + Image)
```bash
docker stop devdb-rails-{database_type}
docker rm devdb-rails-{database_type}
docker rmi devdb-rails-{database_type}
```

## Database Connection Details

### MySQL
- **Host**: host.docker.internal (from container)
- **Port**: 2222
- **Username**: root
- **Password**: mysecretpassword
- **Database**: sample_db

### PostgreSQL
- **Host**: host.docker.internal (from container)
- **Port**: 3333
- **Username**: postgres
- **Password**: mysecretpassword
- **Database**: sample_db

### SQLite
- **File**: storage/development.sqlite3 (inside container)

## Troubleshooting

### Database Container Not Running
If you see an error about database containers not running, start them using the docker commands shown in the examples above.

### Port Conflicts
The script automatically finds available ports, but if you need to use a specific port, you can modify the generated container after it's created.

### Checking Logs
If the application doesn't start properly, check the container logs:
```bash
docker logs devdb-rails-{database_type}
```

## Development

The `boot.sh` script is self-contained and modifiable. Key sections:
- Database validation and dependency checking
- Dockerfile generation (one per database type)
- Port detection and container management
- Sample data setup scripts

## Architecture

This system replaces the traditional approach of maintaining separate Rails applications for each database type with a dynamic generation approach that:
- Reduces code duplication
- Ensures consistency across database types
- Simplifies maintenance and updates
- Provides identical sample data across all database types
- Maintains database-specific optimizations and configurations
