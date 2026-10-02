#!/bin/bash
# usage: run-job.sh <job-id> <branch> <brief-file>

export PATH=$HOME/.local/bin:$HOME/.local/opt/node/bin:$HOME/.local/opt/gh/bin:$PATH
JOB=$1 BR=$2 BRIEF=$3
cd ~/work/remold && git fetch -q origin && git worktree add -q -B "$BR" ~/work/jobs/$JOB origin/${BASE:-build/unified-remold-2026-09-24} 2>/dev/null || true
cd ~/work/jobs/$JOB && pnpm install --frozen-lockfile >/dev/null 2>&1
mkdir -p ~/work/handover/$JOB ~/work/logs
claude -p "You are the builder for job $JOB. Read ~/work/briefs/COMMON.md, then ~/work/briefs/$BRIEF, and carry out the job in this directory ($PWD) on branch $BR until its Done-when list passes. Write the handover as instructed." \
  --model claude-opus-5-5 --dangerously-skip-permissions --output-format json > ~/work/logs/$JOB.json 2> ~/work/logs/$JOB.err
echo "exit $?" >> ~/work/logs/$JOB.err
