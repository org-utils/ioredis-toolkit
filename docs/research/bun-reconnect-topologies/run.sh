#!/bin/bash
# Usage: run.sh <label> <compose> <where: host|ns> <runtime: bun|node> <trigger> <client args...>
# One fresh stack, one client, one trigger. host: the client runs on macOS behind Docker Desktop's port proxy;
# ns: it runs in a Linux container inside the stack's network namespace, where a dead port refuses.
D=$(cd "$(dirname "$0")" && pwd); label=$1 compose=$2 where=$3 rt=$4 trigger=$5; shift 5; P=rsk-t106
docker compose -p $P -f $D/$compose down -v >/dev/null 2>&1
docker compose -p $P -f $D/$compose up -d --wait >/dev/null 2>&1
CID=$(docker compose -p $P -f $D/$compose ps -q | head -1); OUT=$(mktemp)
if [ $where = host ]; then
  bin=$([ $rt = bun ] && echo /Users/macbookpro/.nvm/versions/node/v24.14.0/bin/bun || echo node)
  $bin $D/client.mjs "$@" > $OUT 2>&1 & PID=$!
else
  img=$([ $rt = bun ] && echo oven/bun:1.3.10 || echo node:24-alpine)
  docker run --rm --network container:$CID -v /Users/macbookpro/work/web/packages/redis-session-kit:/Users/macbookpro/work/web/packages/redis-session-kit:ro -v $D:/w:ro $img $rt /w/client.mjs "$@" > $OUT 2>&1 & PID=$!
fi
until grep -q READY $OUT 2>/dev/null; do sleep 0.2; done
case $trigger in
  kill-7101) docker exec $CID sh -c 'kill -9 $(pgrep -f "redis-server.*:7101")' ;;
  shutdown) docker exec $CID redis-cli -p 6390 shutdown nosave >/dev/null 2>&1 ;;
  restart) docker compose -p $P -f $D/$compose stop -t 1 >/dev/null 2>&1; (sleep 3; docker compose -p $P -f $D/$compose start >/dev/null 2>&1) & ;;
esac
wait $PID
echo "== $label"; grep -E '^(READY|RESULT|EVENTS)' $OUT | sed -E 's/^READY (.*)/   \1/; s/^RESULT [^:]*: /   result: /; s/^EVENTS /   events: /'
docker compose -p $P -f $D/$compose down -v >/dev/null 2>&1; rm -f $OUT
