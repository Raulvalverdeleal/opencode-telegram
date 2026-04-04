#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
while true; do
  node "$DIR/index.mjs"
  [ $? -ne 0 ] && break
  echo "Restarting telegram bot..."
done
