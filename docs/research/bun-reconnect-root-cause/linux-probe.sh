#!/bin/sh
# Inside a container: start a local server that closes on accept, then run the raw reproduction 3 times.
node_or_bun=$1
$node_or_bun /w/dropper.mjs 6521 destroy & sleep 0.5
for i in 1 2 3; do timeout 10 $node_or_bun /w/raw.mjs 6521 sync 2 | sed -E 's/ \| .*//'; done
