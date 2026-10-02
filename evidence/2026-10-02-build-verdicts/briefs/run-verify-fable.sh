#!/bin/bash
# usage: run-verify-fable.sh <job-id> <branch> <brief-file> <handover-dir>
# Fallback verifier while Codex (Astra) is over its usage limit. Read-only on the repo by instruction.
export PATH=$HOME/.local/bin:$HOME/.local/opt/node/bin:$HOME/.local/opt/gh/bin:$PATH
JOB=$1 BR=$2 BRIEF=$3 HO=$4
mkdir -p ~/work/verify ~/work/logs /tmp/verify-$JOB
rm -rf ~/work/verify/$JOB; git clone -q -b "$BR" https://github.com/shakur-cmd/remold.git ~/work/verify/$JOB
cd ~/work/verify/$JOB && git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' && pnpm install --frozen-lockfile >/dev/null 2>&1
claude -p "You are the independent verifier for job $JOB (you did not build it). Read ~/work/briefs/VERIFY.md and follow it exactly, except: state that you are Claude Fable 5.1 (claude-fable-5-1) instead of Astra. Then read the job brief ~/work/briefs/$BRIEF and the builder handover and any earlier verdicts in $HO. The checkout is $PWD on branch $BR. Use /tmp/verify-$JOB for scratch. Never edit tracked files or commit. Write /tmp/verify-$JOB/verdict.md and print the full verdict as your final message." \
  --model claude-fable-5-1 --dangerously-skip-permissions --output-format json > ~/work/logs/verify-$JOB.json 2> ~/work/logs/verify-$JOB.err
python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('result',''))" ~/work/logs/verify-$JOB.json > ~/work/logs/verify-$JOB.txt 2>/dev/null
echo "exit $?" >> ~/work/logs/verify-$JOB.err
