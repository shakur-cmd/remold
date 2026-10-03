# Compares two stdio tool listings (stdio-tools.mjs output): instructions, tool names, and each tool apart from the SDK's execution field.
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
print("instructions equal", a["instructions"] == b["instructions"])
print("names equal", [t["name"] for t in a["tools"]] == [t["name"] for t in b["tools"]], len(a["tools"]), len(b["tools"]))
diffs = 0
for x, y in zip(a["tools"], b["tools"]):
    x = {k: v for k, v in x.items() if k != "execution"}
    if x != y: diffs += 1; print("DIFF", x["name"])
print("tool diffs", diffs)
