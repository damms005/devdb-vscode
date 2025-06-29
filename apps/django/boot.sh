#!/bin/bash

set -e

# Cleanup function to run on exit
cleanup() {
    if [[ -d "$TODO_APP_DIR" ]]; then
        print_info "Cleaning up ephemeral Django application..."
        cd "$TODO_APP_DIR"
        # Remove everything except .gitignore
        find . -mindepth 1 -not -name '.gitignore' -exec rm -rf {} + 2>/dev/null || true
        print_success "Cleanup completed. Only .gitignore remains."
    fi
}

# Set trap to run cleanup on script exit
trap cleanup EXIT

# Default database type
DB_TYPE="${1:-sqlite}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validate database type
if [[ ! "$DB_TYPE" =~ ^(mysql|postgres|sqlite)$ ]]; then
    print_error "Invalid database type: $DB_TYPE"
    print_info "Supported types: mysql, postgres, sqlite"
    exit 1
fi

print_info "Setting up Django application with $DB_TYPE database..."

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODO_APP_DIR="$SCRIPT_DIR/todo-app"

# Check if database containers are running (skip for SQLite)
if [[ "$DB_TYPE" != "sqlite" ]]; then
    case "$DB_TYPE" in
        "mysql")
            if ! docker ps --format "table {{.Names}}" | grep -q "mysql-devdb-triage"; then
                print_error "MySQL database container 'mysql-devdb-triage' is not running!"
                print_info "Please start the MySQL database container first:"
                print_info "  docker run -d --name mysql-devdb-triage -p 2222:3306 -e MYSQL_ROOT_PASSWORD=mysecretpassword mysql:8.0"
                exit 1
            fi
            print_success "MySQL database container is running"
            ;;
        "postgres")
            if ! docker ps --format "table {{.Names}}" | grep -q "postgres-devdb-triage"; then
                print_error "PostgreSQL database container 'postgres-devdb-triage' is not running!"
                print_info "Please start the PostgreSQL database container first:"
                print_info "  docker run -d --name postgres-devdb-triage -p 3333:5432 -e POSTGRES_PASSWORD=mysecretpassword postgres:16"
                exit 1
            fi
            print_success "PostgreSQL database container is running"
            ;;
    esac
fi

# Check if Django and Python are available
if ! command -v django-admin &> /dev/null; then
    print_error "Django is not installed. Please install Django first:"
    print_info "  pip install django"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    print_error "Python3 is not installed. Please install Python3 first."
    exit 1
fi

# Clear the todo-app directory
print_info "Clearing existing Django application..."
rm -rf "$TODO_APP_DIR"
mkdir -p "$TODO_APP_DIR"

# Create a new Django project in todo-app directory
print_info "Creating a new Django project in todo-app..."
cd "$(dirname "$TODO_APP_DIR")"
django-admin startproject todoapp "$(basename "$TODO_APP_DIR")"

# Change to the todo-app directory
cd "$TODO_APP_DIR"

# Remove git-related files and setup gitignore for ephemeral application
print_info "Configuring gitignore for ephemeral app..."

# Overwrite .gitignore to ignore everything except itself
cat > .gitignore << 'EOF'
# Ignore everything in this ephemeral Django application directory
*
# But don't ignore this .gitignore file itself
!.gitignore
EOF

# Create and activate virtual environment
print_info "Creating virtual environment..."
python3 -m venv venv
source venv/bin/activate

# Install Django and required database packages
print_info "Installing required packages..."
pip install django
case "$DB_TYPE" in
    "mysql")
        pip install mysqlclient
        ;;
    "postgres")
        pip install psycopg2-binary
        ;;
    "sqlite")
        # SQLite support is built into Python
        ;;
esac

# Create todos app first
print_info "Creating todos Django app..."
python3 manage.py startapp todos

# Update database configuration
print_info "Configuring database connection..."
case "$DB_TYPE" in
    "mysql")
        cat > todoapp/settings.py << 'EOF'
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-ephemeral-key-for-demo-only'
DEBUG = True
ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'todos',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'todoapp.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'todoapp.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': 'sample_db',
        'USER': 'root',
        'PASSWORD': 'mysecretpassword',
        'HOST': '127.0.0.1',
        'PORT': '2222',
        'OPTIONS': {
            'charset': 'utf8mb4',
        },
    }
}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
EOF
        ;;
    "postgres")
        cat > todoapp/settings.py << 'EOF'
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-ephemeral-key-for-demo-only'
DEBUG = True
ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'todos',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'todoapp.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'todoapp.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'sample_db',
        'USER': 'postgres',
        'PASSWORD': 'mysecretpassword',
        'HOST': '127.0.0.1',
        'PORT': '3333',
    }
}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
EOF
        ;;
    "sqlite")
        cat > todoapp/settings.py << 'EOF'
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-ephemeral-key-for-demo-only'
DEBUG = True
ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'todos',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'todoapp.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'todoapp.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
EOF
        ;;
esac

# Create todos models
print_info "Creating models..."
cat > todos/models.py << 'EOF'
import uuid
from django.db import models

class Category(models.Model):
    id = models.CharField(max_length=36, primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

class Product(models.Model):
    id = models.CharField(max_length=36, primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    stock_quantity = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

class User(models.Model):
    id = models.CharField(max_length=36, primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

class Todo(models.Model):
    id = models.CharField(max_length=36, primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=255)
    completed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.title

    class Meta:
        ordering = ['-created_at']
EOF

# Create todos views
print_info "Creating views..."
cat > todos/views.py << 'EOF'
from django.shortcuts import render, redirect, get_object_or_404
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from .models import Todo, Product, User, Category
import json

def home(request):
    products = Product.objects.all()[:10]
    users = User.objects.all()[:5]
    categories = Category.objects.all()
    
    context = {
        'products': products,
        'users': users,
        'categories': categories,
    }
    return render(request, 'home.html', context)

def todo_list(request):
    todos = Todo.objects.all()
    return render(request, 'todos.html', {'todos': todos})

@csrf_exempt
@require_http_methods(["POST"])
def add_todo(request):
    title = request.POST.get('title', '').strip()
    if title:
        Todo.objects.create(title=title)
    return redirect('todo_list')

@csrf_exempt
@require_http_methods(["POST"])
def toggle_todo(request, todo_id):
    todo = get_object_or_404(Todo, id=todo_id)
    todo.completed = not todo.completed
    todo.save()
    return redirect('todo_list')

@csrf_exempt
@require_http_methods(["POST"])
def delete_todo(request, todo_id):
    todo = get_object_or_404(Todo, id=todo_id)
    todo.delete()
    return redirect('todo_list')
EOF

# Create URL patterns
print_info "Creating URL patterns..."
cat > todos/urls.py << 'EOF'
from django.urls import path
from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('todos/', views.todo_list, name='todo_list'),
    path('todos/add/', views.add_todo, name='add_todo'),
    path('todos/<str:todo_id>/toggle/', views.toggle_todo, name='toggle_todo'),
    path('todos/<str:todo_id>/delete/', views.delete_todo, name='delete_todo'),
]
EOF

# Update main URLs
cat > todoapp/urls.py << 'EOF'
from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('todos.urls')),
]
EOF

# Create templates directory and templates
print_info "Creating templates..."
mkdir -p templates
mkdir -p static

# Create a capitalized version of DB_TYPE
DB_TYPE_CAPITALIZED=$(echo "${DB_TYPE}" | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')

cat > templates/base.html << EOF
<!DOCTYPE html>
<html>
<head>
    <title>Django ${DB_TYPE_CAPITALIZED} Demo</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
    {% block content %}
    {% endblock %}
</body>
</html>
EOF

cat > templates/home.html << EOF
{% extends 'base.html' %}

{% block content %}
<div style="font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; text-align: center;">Django ${DB_TYPE_CAPITALIZED} Demo Application</h1>
  
  <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
    <h2 style="color: #28a745;">🎉 Success! Django is connected to ${DB_TYPE_CAPITALIZED}</h2>
    <p>This application is running Django with a ${DB_TYPE_CAPITALIZED} database backend.</p>
EOF

case "$DB_TYPE" in
    "mysql")
        cat >> templates/home.html << 'EOF'
    <p><strong>Database:</strong> MySQL via Docker container</p>
    <p><strong>Connection:</strong> 127.0.0.1:2222</p>
EOF
        ;;
    "postgres")
        cat >> templates/home.html << 'EOF'
    <p><strong>Database:</strong> PostgreSQL via Docker container</p>
    <p><strong>Connection:</strong> 127.0.0.1:3333</p>
EOF
        ;;
    "sqlite")
        cat >> templates/home.html << 'EOF'
    <p><strong>Database:</strong> SQLite (file-based)</p>
    <p><strong>File:</strong> db.sqlite3</p>
EOF
        ;;
esac

cat >> templates/home.html << 'EOF'
    <p style="margin-top: 15px;"><a href="/todos/" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">📝 Try the Todo App</a></p>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px;">
    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #007bff; margin-top: 0;">📦 Products ({{ products|length }})</h3>
      {% for product in products %}
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong>{{ product.name }}</strong><br>
          <small style="color: #666;">{{ product.description }}</small><br>
          <span style="color: #28a745; font-weight: bold;">${{ product.price }}</span>
        </div>
      {% endfor %}
    </div>

    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #28a745; margin-top: 0;">👥 Users ({{ users|length }})</h3>
      {% for user in users %}
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong>{{ user.name }}</strong><br>
          <small style="color: #666;">{{ user.email }}</small>
        </div>
      {% endfor %}
    </div>

    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <h3 style="color: #ffc107; margin-top: 0;">🏷️ Categories ({{ categories|length }})</h3>
      {% for category in categories %}
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong>{{ category.name }}</strong><br>
          <small style="color: #666;">{{ category.description }}</small>
        </div>
      {% endfor %}
    </div>
  </div>
</div>
{% endblock %}
EOF

cat > templates/todos.html << EOF
{% extends 'base.html' %}

{% block content %}
<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #333; text-align: center;">📝 Todo App - ${DB_TYPE_CAPITALIZED} Backend</h1>
  
  <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
    <h3>Add New Todo</h3>
    <form action="/todos/add/" method="post" style="display: flex; gap: 10px;">
      <input type="text" name="title" placeholder="Enter todo item..." 
             style="flex: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" required>
      <button type="submit" 
              style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer;">Add Todo</button>
    </form>
  </div>

  <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <h3 style="margin-top: 0;">Your Todos ({{ todos|length }})</h3>
    
    {% if not todos %}
      <p style="color: #666; text-align: center; padding: 40px;">No todos yet. Add one above to get started!</p>
    {% else %}
      {% for todo in todos %}
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 15px; border-bottom: 1px solid #eee; {% if todo.completed %}background: #f8f9fa;{% endif %}">
          <div style="flex: 1;">
            <span style="{% if todo.completed %}text-decoration: line-through; color: #666;{% endif %}">
              {{ todo.title }}
            </span>
            {% if todo.completed %}
              <span style="color: #28a745; font-size: 12px; margin-left: 10px;">✓ Completed</span>
            {% endif %}
          </div>
          
          <div style="display: flex; gap: 10px;">
            <form action="/todos/{{ todo.id }}/toggle/" method="post" style="display: inline;">
              <button type="submit" 
                      style="background: {% if todo.completed %}#ffc107{% else %}#28a745{% endif %}; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                {% if todo.completed %}Undo{% else %}Done{% endif %}
              </button>
            </form>
            
            <form action="/todos/{{ todo.id }}/delete/" method="post" style="display: inline;">
              <button type="submit" 
                      style="background: #dc3545; color: white; padding: 5px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;"
                      onclick="return confirm('Are you sure you want to delete this todo?')">
                Delete
              </button>
            </form>
          </div>
        </div>
      {% endfor %}
    {% endif %}
  </div>
  
  <div style="text-align: center; margin-top: 30px;">
    <a href="/" style="color: #007bff; text-decoration: none;">← Back to Home</a>
  </div>
</div>
{% endblock %}
EOF

# Create database setup script
print_info "Creating database setup script..."
cat > setup_database.py << 'EOF'
import os
import sys
import django
from django.conf import settings

# Setup Django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'todoapp.settings')
django.setup()

from django.db import connection
from todos.models import Category, Product, User, Todo
import uuid

def setup_database():
    print("Setting up database and sample data...")
    
    # Create tables
    from django.core.management import execute_from_command_line
    execute_from_command_line(['manage.py', 'makemigrations', 'todos'])
    execute_from_command_line(['manage.py', 'migrate'])
    
    # Clear existing data
    Todo.objects.all().delete()
    Product.objects.all().delete()
    User.objects.all().delete()
    Category.objects.all().delete()
    
    # Create sample categories
    categories_data = [
        {'name': 'Electronics', 'description': 'Electronic devices and gadgets'},
        {'name': 'Clothing', 'description': 'Apparel and fashion items'},
        {'name': 'Books', 'description': 'Books and publications'}
    ]
    
    for cat_data in categories_data:
        Category.objects.create(**cat_data)
    
    # Create sample products
    products_data = [
        {'name': 'Smartphone X', 'description': 'Latest smartphone with advanced features', 'price': 899.99, 'stock_quantity': 50},
        {'name': 'Laptop Pro', 'description': 'High-performance laptop for professionals', 'price': 1299.99, 'stock_quantity': 25},
        {'name': 'Cotton T-shirt', 'description': 'Comfortable cotton t-shirt', 'price': 19.99, 'stock_quantity': 200}
    ]
    
    for prod_data in products_data:
        Product.objects.create(**prod_data)
    
    # Create sample users
    users_data = [
        {'email': 'john.doe@example.com', 'name': 'John Doe'},
        {'email': 'jane.smith@example.com', 'name': 'Jane Smith'}
    ]
    
    for user_data in users_data:
        User.objects.create(**user_data)
    
    print("Database setup completed successfully!")

if __name__ == '__main__':
    setup_database()
EOF

# Setup database and sample data
print_info "Setting up database and sample data..."
python3 setup_database.py

# Find an available port
print_info "Finding available port..."
PORT=8000
while lsof -i :$PORT > /dev/null 2>&1; do
    PORT=$((PORT + 1))
done
print_success "Using port: $PORT"

# Start the Django server
print_info "Starting Django server on port $PORT..."
print_success "Django application is now running!"
print_success "🚀 Open your browser and go to: http://localhost:$PORT"
print_info "Application location: $TODO_APP_DIR"
print_info "To stop the server: Press Ctrl+C"
print_info ""
print_info "Starting server..."

# Start the server
python3 manage.py runserver 0.0.0.0:$PORT
