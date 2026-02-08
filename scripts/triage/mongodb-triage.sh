#!/bin/bash

docker pull mongo:7.0

if [ "$(docker ps -a --filter 'name=^/mongodb-devdb-triage$' --format '{{.Names}}')" == "mongodb-devdb-triage" ]; then
    echo "Container exists. Starting mongodb-devdb-triage if not already running..."
    docker start mongodb-devdb-triage
else
    echo "Container does not exist. Creating a new mongodb-devdb-triage container..."
    docker run --name mongodb-devdb-triage -p 5555:27017 -d mongo:7.0
fi

echo "Waiting for MongoDB to start..."
until docker exec mongodb-devdb-triage mongosh --eval "db.adminCommand('ping')" --quiet; do
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

DOCS="["
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
            AVAIL_STR="true"
        else
            AVAIL_STR="false"
        fi

        ESCAPED_TITLE=$(echo "$TITLE" | sed 's/"/\\"/g')
        ESCAPED_AUTHOR=$(echo "$AUTHOR" | sed 's/"/\\"/g')

        if [ $COUNT -gt 1 ]; then
            DOCS="${DOCS},"
        fi

        DOCS="${DOCS}{\"title\":\"${ESCAPED_TITLE}\",\"author\":\"${ESCAPED_AUTHOR}\",\"published_date\":\"${YEAR}-${MONTH}-${DAY}\",\"isbn\":\"${ISBN}\",\"pages\":${PAGES},\"available\":${AVAIL_STR}}"
    done
done

DOCS="${DOCS}]"

docker exec -i mongodb-devdb-triage mongosh sample_db --quiet << EOF
db.book.drop();
db.book.insertMany(${DOCS});
print("Inserted " + db.book.countDocuments() + " documents into book collection");
EOF

echo "MongoDB triage setup complete. ${COUNT} records inserted."

echo "Example connection details:"

cat << EXAMPLE_CONNECTION
{
    "name"     : "Triage MongoDB",
    "type"     : "mongodb",
    "host"     : "localhost",
    "port"     : 5555,
    "database" : "sample_db"
}
EXAMPLE_CONNECTION

echo "To stop the MongoDB container, run the following command:"
echo "docker stop mongodb-devdb-triage && docker rm mongodb-devdb-triage"
