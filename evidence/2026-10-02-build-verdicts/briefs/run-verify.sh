#!/bin/bash
# usage: run-verify.sh <job-id> <branch> <brief-file> <handover-dir>
export PATH=$HOME/.local/bin:$HOME/.local/opt/node/bin:$HOME/.local/opt/gh/bin:$PATH
JOB=$1 BR=$2 BRIEF=$3 HO=$4
mkdir -p ~/work/verify ~/work/logs /tmp/verify-$JOB
rm -rf ~/work/verify/$JOB; git clone -q -b "$BR" https://github.com/shakur-cmd/remold.git ~/work/verify/$JOB
cd ~/work/verify/$JOB && git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' && pnpm install --frozen-lockfile >/dev/null 2>&1
codex exec -m gpt-6-astra --dangerously-bypass-approvals-and-sandbox -C "$PWD" --json -o ~/work/logs/verify-$JOB.txt \
 "You are the independent verifier for job $JOB. Read ~/work/briefs/VERIFY.md, the job brief ~/work/briefs/$BRIEF, and the builder handover in $HO. The checkout is $PWD on branch $BR. Follow VERIFY.md exactly. Use /tmp/verify-$JOB for scratch." </dev/null > ~/work/logs/verify-$JOB.jsonl 2> ~/work/logs/verify-$JOB.err
echo "exit $?" >> ~/work/logs/verify-$JOB.err
