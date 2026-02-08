#!/bin/bash

docker pull supabase/postgres:15.6.1.145

if [ "$(docker ps -a --filter 'name=^/supabase-devdb-triage$' --format '{{.Names}}')" == "supabase-devdb-triage" ]; then
    echo "Container exists. Starting supabase-devdb-triage if not already running..."
    docker start supabase-devdb-triage
else
    echo "Container does not exist. Creating a new supabase-devdb-triage container..."
    docker run --name supabase-devdb-triage -e POSTGRES_PASSWORD=mysecretpassword -p 4444:5432 -d supabase/postgres:15.6.1.145
fi

echo "Waiting for PostgreSQL to start..."
until docker exec supabase-devdb-triage pg_isready -U postgres; do
  sleep 1
done

TITLES=(
    "The Great Gatsby"
    "1984"
    "To Kill a Mockingbird"
    "Pride and Prejudice"
    "The Catcher in the Rye"
    "Moby-Dick"
    "War and Peace"
)

AUTHORS=(
    "F. Scott Fitzgerald"
    "George Orwell"
    "Harper Lee"
    "Jane Austen"
    "J.D. Salinger"
    "Herman Melville"
    "Leo Tolstoy"
)

SQL_VALUES=""
COUNT=0

for EDITION in 1 2 3 4 5; do
    for i in "${!TITLES[@]}"; do
        COUNT=$((COUNT + 1))
        if [ $COUNT -gt 35 ]; then
            break 2
        fi

        TITLE="${TITLES[$i]}"
        AUTHOR="${AUTHORS[$i]}"

        if [ $EDITION -gt 1 ]; then
            TITLE="${TITLE} (Edition ${EDITION})"
        fi

        YEAR=$((1800 + RANDOM % 225))
        MONTH=$(printf "%02d" $((RANDOM % 12 + 1)))
        DAY=$(printf "%02d" $((RANDOM % 28 + 1)))
        ISBN=$(printf "978%010d" $((RANDOM * RANDOM % 10000000000)))
        PAGES=$((100 + RANDOM % 900))
        AVAILABLE=$((RANDOM % 2))
        if [ $AVAILABLE -eq 1 ]; then
            AVAIL_STR="TRUE"
        else
            AVAIL_STR="FALSE"
        fi

        ESCAPED_TITLE=$(echo "$TITLE" | sed "s/'/''/g")
        ESCAPED_AUTHOR=$(echo "$AUTHOR" | sed "s/'/''/g")

        if [ -n "$SQL_VALUES" ]; then
            SQL_VALUES="${SQL_VALUES},"
        fi
        SQL_VALUES="${SQL_VALUES}
('${ESCAPED_TITLE}', '${ESCAPED_AUTHOR}', '${YEAR}-${MONTH}-${DAY}', '${ISBN}', ${PAGES}, ${AVAIL_STR}, uuid_generate_v4(), ${COUNT})"
    done
done

docker exec -i supabase-devdb-triage psql -U postgres << EOF
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
INSERT INTO book (title, author, published_date, isbn, pages, available, "user", "order") VALUES${SQL_VALUES};

EOF

echo "Supabase PostgreSQL triage setup complete. ${COUNT} records inserted."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
{
    "host"     : "localhost",
    "port"     : 4444,
    "username" : "postgres",
    "password" : "mysecretpassword",
    "database" : "sample_db"
}
EXAMPLE_CONNECTION

echo "To stop the Supabase container, run the following command:"
echo "docker stop supabase-devdb-triage && docker rm supabase-devdb-triage"
