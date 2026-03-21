#!/bin/sh
set -e

echo "=========================================="
echo "Database Migration"
echo "=========================================="

if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL environment variable is required"
    echo "Example: postgres://user:pass@host:5432/dbname?sslmode=disable"
    exit 1
fi

echo "Target database: ${DATABASE_URL%%@*}@..."

echo "Normalizing migration filenames for golang-migrate..."
for file in /migrations/*.sql; do
    if [ -f "$file" ]; then
        case "$file" in
            *.up.sql|*.down.sql) ;;
            *) mv "$file" "${file%.sql}.up.sql" ;;
        esac
    fi
done

echo ""
echo "Pending migrations:"
migrate -path=/migrations -database="$DATABASE_URL" version 2>/dev/null || echo "(no migrations applied yet)"

echo ""
echo "Applying migrations..."
migrate -path=/migrations -database="$DATABASE_URL" up

echo ""
echo "=========================================="
echo "Migration completed successfully!"
echo "=========================================="

echo "Current version:"
migrate -path=/migrations -database="$DATABASE_URL" version
