#!/bin/bash
# exits when a job not in the seen list has finished; prints which
SEEN=~/scratch/remold-build/seen.txt; touch $SEEN
while true; do
  for t in "shakur@100.118.3.58" "old-mac-pro@100.127.90.84"; do
    for j in $(ssh -o BatchMode=yes -o ConnectTimeout=10 $t 'grep -l "^exit" ~/work/logs/*.err 2>/dev/null | xargs -n1 basename 2>/dev/null | sed "s/.err//"'); do
      if ! grep -qx "$t:$j" $SEEN; then echo "$t:$j" >> $SEEN; echo "FINISHED $t $j"; exit 0; fi
    done
  done
  sleep 60
done
