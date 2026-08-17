#!/bin/sh
# mint-token.sh -- add a bearer token to ~/.wpnews/tokens.json.
#
#   server/tools/mint-token.sh operator me
#   server/tools/mint-token.sh producer agent
#
# Two scopes, and the difference is what each one is trusted with:
#
#   producer   push editions, claim commands. What an agent gets.
#   operator   all of that, plus the schedule and forcing a publish. What the
#              owner's own tooling gets.
#
# The file is created 0600 and lives OUTSIDE the repository and OUTSIDE the
# vault. Outside the repository because the repository is public; outside the
# vault because the vault is a git repository and git history is permanent, and
# a private repository is one setting away from a public one.
#
# The token is printed once. It is not recoverable from anywhere else in a
# convenient form, which is deliberate -- if it were, the convenient form would
# be the thing that leaked.
set -eu

scope="${1:-}"
name="${2:-}"

case "$scope" in
    producer|operator) ;;
    *)
        echo "usage: $0 <producer|operator> <name>" >&2
        exit 2
        ;;
esac

if [ -z "$name" ]; then
    echo "usage: $0 <producer|operator> <name>" >&2
    exit 2
fi

dir="$HOME/.wpnews"
file="$dir/tokens.json"

mkdir -p "$dir"
chmod 700 "$dir"
[ -f "$file" ] || { umask 077; printf '{"tokens": []}\n' > "$file"; }

token=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')

python3 - "$file" "$scope" "$name" "$token" <<'PY'
import json
import os
import sys
import tempfile

path, scope, name, token = sys.argv[1:5]

with open(path, encoding="utf-8") as f:
    doc = json.load(f)

entries = doc.setdefault("tokens", [])
# A name is an identity, not a label: re-minting for the same name replaces the
# old token rather than leaving two live credentials with one name on them.
entries = [e for e in entries if e.get("name") != name]
entries.append({"name": name, "scope": scope, "token": token})
doc["tokens"] = entries

# Write through a temporary file in the same directory so that a desk reading
# the file mid-write sees the old one or the new one and never half of either.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
except BaseException:
    os.unlink(tmp)
    raise
PY

chmod 600 "$file"

echo "minted a $scope token named '$name' in $file"
echo
echo "  $token"
echo
echo "It is printed once. Use it as:  Authorization: Bearer <token>"
