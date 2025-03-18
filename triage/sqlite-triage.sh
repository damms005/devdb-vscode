#!/bin/bash

# Create a SQLite database file
sqlite3 devdb-triage.sqlite << EOF
CREATE TABLE book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    published_date DATE,
    isbn TEXT,
    pages INTEGER,
    available BOOLEAN DEFAULT 1
);
INSERT INTO book (title, author, published_date, isbn, pages, available) VALUES
('The Great Gatsby', 'F. Scott Fitzgerald', '1925-04-10', '9780743273565', 180, 1),
('1984', 'George Orwell', '1949-06-08', '9780451524935', 328, 0),
('To Kill a Mockingbird', 'Harper Lee', '1960-07-11', '9780061120084', 281, 1),
('Pride and Prejudice', 'Jane Austen', '1813-01-28', '9781503290563', 279, 1),
('The Catcher in the Rye', 'J.D. Salinger', '1951-07-16', '9780316769488', 214, 0);

EOF

echo "SQLite triage setup complete."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
connect(
    database="devdb-triage.sqlite"
)
EXAMPLE_CONNECTION

echo "To remove the SQLite database file, run the following command:"
echo "rm devdb-triage.sqlite"
