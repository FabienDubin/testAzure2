#!/bin/bash
# Startup script for Azure Web App
# Generate Prisma Client then start the server

echo "Generating Prisma Client..."
npx prisma generate

echo "Starting server..."
node dist/server.js
