#!/bin/sh
# Startup script for Azure Web App
# Generate Prisma Client then start the server

echo "=====Generating Prisma Client...====="
node /node_modules/.bin/prisma generate

echo "!!!!!!!!Prisma Client generated successfully!!!!!!!!!"
echo "Starting server..."
node dist/server.js
