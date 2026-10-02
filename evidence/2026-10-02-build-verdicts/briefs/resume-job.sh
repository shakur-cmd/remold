#!/bin/bash
# usage: resume-job.sh <job-id> <prev-json-name> <round-tag> <prompt-file>
export PATH=$HOME/.local/bin:$HOME/.local/opt/node/bin:$HOME/.local/opt/gh/bin:$PATH
JOB=$1 PREV=$2 TAG=$3 PROMPT=$4
cd ~/work/jobs/$JOB
SID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['session_id'])" ~/work/logs/$PREV.json)
claude -p "$(cat $PROMPT)" --resume "$SID" --model claude-opus-5-5 --dangerously-skip-permissions --output-format json > ~/work/logs/$JOB-$TAG.json 2> ~/work/logs/$JOB-$TAG.err
echo "exit $?" >> ~/work/logs/$JOB-$TAG.err
