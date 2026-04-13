#!/bin/zsh -l

PROJECT_DIR="/Users/makram/dev/sauron"
PORT=7777
URL="http://127.0.0.1:$PORT"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN > /dev/null 2>&1; then
    echo "Sauron already running"
else
    echo "Starting Sauron..."
    cd "$PROJECT_DIR"
    npm start >> /tmp/sauron.log 2>&1 &

    for i in $(seq 1 20); do
        sleep 0.5
        if lsof -nP -iTCP:$PORT -sTCP:LISTEN > /dev/null 2>&1; then
            echo "Ready"
            break
        fi
    done
fi

open -a Firefox "$URL"
