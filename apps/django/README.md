# Django Dynamic Database Boot System

This directory contains a dynamic Django application boot system that generates and runs Django applications with different database configurations on-demand.

## Overview

Instead of maintaining a full Django application codebase, this system uses a single `boot.sh` script that:

1. Validates the requested database type
2. Checks for required database containers (for MySQL/PostgreSQL)
3. Creates a fresh Django application in the `todo-app` directory
4. Configures the application to connect to the specified database
5. Sets up sample data automatically
6. Starts a local Django server

**Note**: The Django application runs locally on your machine in a virtual environment, but connects to databases running in Docker containers (for MySQL/PostgreSQL) or uses local SQLite files.

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

Then run the Django app:
```bash
./boot.sh mysql
```

#### PostgreSQL
First, ensure PostgreSQL container is running:
```bash
docker run -d --name postgres-devdb-triage -p 3333:5432 -e POSTGRES_PASSWORD=mysecretpassword postgres:16
```

Then run the Django app:
```bash
./boot.sh postgres
```

## Features

### Automatic Port Detection
The script automatically finds an available port starting from 8000 to avoid conflicts with existing services.

### Virtual Environment
Each Django application runs in its own isolated virtual environment with all required dependencies installed automatically.

### Sample Data
Each Django application comes pre-loaded with sample data:
- **Products**: Electronics, clothing, books, etc. with prices and stock quantities
- **Categories**: Organized product categories
- **Users**: Sample user accounts with email addresses

### Database-Specific Configurations
- **MySQL**: Uses UTF8MB4 encoding and proper connection settings
- **PostgreSQL**: Uses native Django PostgreSQL backend with optimized settings
- **SQLite**: File-based storage with Django's built-in SQLite support

### Web Interface
Each application provides a clean web interface displaying:
- Database connection status
- Sample products with pricing
- User listings
- Category information

### Todo App
A fully functional todo application is available at `/todos/` that demonstrates database CRUD operations:
- **Add todos**: Simple form to create new todo items
- **Mark as done**: Toggle completion status of todo items
- **Delete todos**: Remove todo items permanently
- **List todos**: View all todos with their current status

The todo app is designed to be ephemeral - all data is lost when the application is stopped, making it perfect for testing database functionality without persistence concerns.

## Generated Files

### Virtual Environment
A Python virtual environment is created in the `todo-app/venv` directory containing:
- Django 5.2.3
- Database-specific drivers (mysqlclient, psycopg2-binary)
- All required dependencies

### Django Project Structure
The generated Django project includes:
- Main project (`todoapp/`)
- Todo application (`todos/`)
- Models for Categories, Products, Users, and Todos
- Views with full CRUD functionality
- Templates with responsive design
- URL routing configuration

**Note**: The entire generated application is ignored by Git (see `.gitignore`) since it's created dynamically and is ephemeral.

## Management Commands

### View Application Logs
The Django development server logs are displayed in the terminal where the script is running.

### Stop Application
```bash
# Press Ctrl+C in the terminal running the script
```

### Manual Cleanup
The script automatically cleans up on exit, but you can also manually clean up:
```bash
# The cleanup happens automatically when the script exits
```

## Database Connection Details

### MySQL
- **Host**: 127.0.0.1
- **Port**: 2222
- **Username**: root
- **Password**: mysecretpassword
- **Database**: sample_db

### PostgreSQL
- **Host**: 127.0.0.1
- **Port**: 3333
- **Username**: postgres
- **Password**: mysecretpassword
- **Database**: sample_db

### SQLite
- **File**: db.sqlite3 (inside todo-app directory)

## Troubleshooting

### Database Container Not Running
If you see an error about database containers not running, start them using the docker commands shown in the examples above.

### Port Conflicts
The script automatically finds available ports starting from 8000. If port 8000 is in use, it will try 8001, 8002, etc.

### Django Not Found
If you get a "Django not found" error, install it using:
```bash
pipx install django
```

### Virtual Environment Issues
If there are issues with the virtual environment, the script will recreate it automatically on each run.

### Checking Application Status
If the application doesn't start properly, check the output in the terminal where you ran the script for detailed error messages.

## Development

The `boot.sh` script is self-contained and modifiable. Key sections:
- Database validation and dependency checking
- Virtual environment creation and management
- Django project and app generation
- Database configuration for each type
- Sample data setup scripts
- Port detection and server management

## Architecture

This system replaces the traditional approach of maintaining separate Django applications for each database type with a dynamic generation approach that:
- Reduces code duplication
- Ensures consistency across database types
- Simplifies maintenance and updates
- Provides identical sample data across all database types
- Maintains database-specific optimizations and configurations
- Uses virtual environments for proper dependency isolation

## Requirements

- Python 3.7+
- Django (installed via pipx)
- Docker (for MySQL/PostgreSQL containers)
- lsof (for port detection)

## Cleanup Behavior

When the script exits (either normally with Ctrl+C or when killed), it automatically:
- Removes all generated files and directories
- Preserves only the `.gitignore` file
- Ensures no leftover files clutter the repository

This ephemeral approach ensures that:
- The repository stays clean
- No generated code gets committed
- Each run starts with a fresh application
- Database switching is seamless and reliable
