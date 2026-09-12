#!/bin/sh
# install-autodeploy.sh -- have the Mac notice a merge and redeploy itself.
#
#   sh server/tools/install-autodeploy.sh            # install and load
#   sh server/tools/install-autodeploy.sh --uninstall
#   sh server/tools/install-autodeploy.sh --status
#
# THE SHAPE OF THIS, and why it is a poll rather than a webhook. The desk runs
# on one Mac behind a Cloudflare tunnel that publishes exactly one hostname at
# exactly one container port. Opening a second ingress so GitHub can push to it
# would be a second way in to reason about, protect and revoke -- against a
# machine whose whole security story is "one hostname, one port, token-gated".
# A poll needs no ingress at all: the Mac asks GitHub, GitHub answers, and
# nothing new is reachable from the internet. Fifteen minutes is well inside
# how long it takes anybody to notice a newspaper is stale.
#
# WHAT IT DOES. Every interval it fetches origin/main. If the remote tip differs
# from the commit currently deployed, it runs `server/deploy.sh`, which brings
# its own test gate and its own rollback. If nothing moved it exits without
# touching Docker, so the ordinary case costs one HTTPS request.
#
# WHAT IT DOES NOT DO. It never deploys a branch, never deploys a dirty tree
# (the deploy directory is hard-reset, so there is nothing to be dirty), and
# never skips the gate. A deploy it cannot verify rolls itself back and the
# next tick finds the same remote tip and tries again -- which is the right
# behaviour for a transient failure and a loud one for a real regression,
# because the log fills with the same error every fifteen minutes.
#
# The log is $HOME/.claudepost/autodeploy.log. Read it before believing the
# desk is current: launchd swallows a failure that this file does not.
set -eu

LABEL="com.claudepost.autodeploy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${AUTODEPLOY_INTERVAL:-900}"
LOG="$HOME/.claudepost/autodeploy.log"
RUNNER="$HOME/.claudepost/autodeploy.sh"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/.claudepost/deploy}"

case "${1:---install}" in
    --status)
        launchctl list | grep -F "$LABEL" || echo "not loaded"
        echo "--- last 20 log lines ---"
        tail -20 "$LOG" 2>/dev/null || echo "(no log yet)"
        exit 0
        ;;
    --uninstall)
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
        rm -f "$PLIST" "$RUNNER"
        echo "autodeploy removed"
        exit 0
        ;;
    --install) ;;
    *) echo "usage: $0 [--install|--uninstall|--status]" >&2; exit 2 ;;
esac

if [ ! -d "$DEPLOY_DIR/.git" ]; then
    echo "install-autodeploy: no deployment checkout at $DEPLOY_DIR." >&2
    echo "  Run server/deploy.sh once first; it creates one." >&2
    exit 1
fi

mkdir -p "$(dirname "$LOG")" "$HOME/Library/LaunchAgents"

# The runner lives outside the repository on purpose: a launchd job that points
# into a working tree is a job that breaks when somebody checks out a branch,
# which is the failure this whole file exists to stop repeating.
cat > "$RUNNER" <<RUNNER_EOF
#!/bin/sh
# Written by server/tools/install-autodeploy.sh. Edit that, not this.
set -eu
DEPLOY_DIR="$DEPLOY_DIR"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

stamp() { date "+%Y-%m-%d %H:%M:%S"; }

git -C "\$DEPLOY_DIR" fetch --quiet --prune origin || {
    echo "\$(stamp) fetch failed"; exit 0; }

remote=\$(git -C "\$DEPLOY_DIR" rev-parse origin/main)
local=\$(git -C "\$DEPLOY_DIR" rev-parse HEAD)

if [ "\$remote" = "\$local" ]; then
    exit 0
fi

echo "\$(stamp) main moved \${local%\${local#???????}} -> \${remote%\${remote#???????}}, deploying"
if sh "\$DEPLOY_DIR/server/deploy.sh" 2>&1; then
    echo "\$(stamp) deployed \$remote"
else
    echo "\$(stamp) DEPLOY FAILED (rolled back if it had somewhere to roll back to)"
fi
RUNNER_EOF
chmod +x "$RUNNER"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$RUNNER</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <!-- Not RunAtLoad: installing this should not deploy. The first tick is one
       interval away, which gives whoever ran the installer time to think. -->
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "autodeploy installed: every ${INTERVAL}s, log at $LOG"
echo "it will NOT deploy now — the first check is one interval away."
echo "check it with: sh server/tools/install-autodeploy.sh --status"
