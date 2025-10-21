#!/bin/bash

# Define allowed branches
allowed_branches=( main dev heads/dev heads/main )

# Helper function to check if current branch is allowed
is_allowed_branch() {
  local branch="$1"
  for allowed in "${allowed_branches[@]}"; do
    if [ "$branch" = "$allowed" ]; then
      return 0
    fi
  done
  return 1
}

# Initialize pre-release flag
PRE_RELEASE=false
AUTO_PRE_RELEASE_FROM_DEV=false

# Parse arguments
for arg in "$@"; do
  if [ "$arg" = "--pre-release" ]; then
    PRE_RELEASE=true
    break
  fi
done

# Define usage message for consistency
USAGE_MSG="Usage: $0 <version> [closes-<issue number> | no-closures] [--pre-release]"

# Check if version argument is provided
if [ -z "$1" ]; then
  echo -e "\x1b[31m$USAGE_MSG"
  echo -e "Allowed branches: ${allowed_branches[*]}."
  exit 1
fi

# Check if the current branch is allowed
current_branch=$(git rev-parse --abbrev-ref HEAD)
current_branch=${current_branch#refs/heads/}

if ! is_allowed_branch "$current_branch"; then
  echo -e "\x1b[31mError: This script must run on one of: ${allowed_branches[*]}. You are on '$current_branch'."
  exit 1
fi

# Automatically enable pre-release if on dev branch
if [ "$current_branch" = "dev" ] && [ "$PRE_RELEASE" = false ]; then
  PRE_RELEASE=true
  AUTO_PRE_RELEASE_FROM_DEV=true
fi

# cd to the dir where this script is located
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
cd "$SCRIPT_DIR" || exit 1
echo "Current working directory:"
pwd

cleanup_test_containers() {
  echo "Cleaning up any orphaned test containers..."
  docker rm -f \
    devdb-test-container-mssql \
    devdb-test-container-mssql-cert \
    devdb-test-container-mysql \
    devdb-test-container-postgres \
    devdb-test-container-for-general-sql-tests \
    2>/dev/null || true
  echo "Cleanup complete."
}

echo "Ensure OK..."
bun run pretest || exit 1
echo "Ok."

cleanup_test_containers

echo "Ensure tests are passing..."
# bun run test-services || exit 1
echo "Ok."

echo "Building UI..."
cd ../devdb-ui || exit 1
./build.sh || exit 1
echo "UI build complete."

echo "Building UI Shell..."
cd "$SCRIPT_DIR" || exit 1
cd ./ui-shell || exit 1
./build.sh || exit 1
echo "UI Shell build complete."

cd "$SCRIPT_DIR" || exit 1
pwd

# Determine commit message based on the second argument
if [ "$2" == "no-closures" ]; then
  commit_body=""  # No closure message
elif [[ "$2" =~ ^closes-[0-9]+$ ]]; then
  issue_number="${2#closes-}"
  commit_body="Closes #$issue_number"  # GitHub auto-close format
else
  echo -e "\x1b[31mInvalid argument for closures. $USAGE_MSG"
  exit 1
fi

# Bump the version using npm version
if [ -n "$commit_body" ]; then
  # Construct the commit message with printf to handle newlines properly
  commit_message=$(printf "%%s\n\n%s" "$commit_body")
  npm version "$1" -m "$commit_message" || exit 1
else
  # Just use npm version without custom commit message body
  npm version "$1" || exit 1
fi

# Comply with VS Code recommended versioning at https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions
# If this is a pre-release, check if we need to bump the minor version
if [ "$PRE_RELEASE" = true ]; then
  # Extract current version from package.json
  current_version=$(grep '"version":' package.json | head -1 | awk -F'"' '{print $4}')

  # Extract minor version number
  minor_version=$(echo "$current_version" | cut -d. -f2)

  # Check if minor version is even
  if [ $((minor_version % 2)) -eq 0 ]; then
    echo "Pre-release detected with even minor version. Bumping minor version..."
    npm version minor --no-git-tag-version || exit 1
    git add . && git commit --amend --no-edit || exit 1
  fi
fi

# Enforce even minor version for standard releases
if [ "$PRE_RELEASE" = false ]; then
  # Extract current version and minor
  current_version=$(grep '"version":' package.json | head -1 | awk -F'"' '{print $4}')
  minor_version=$(echo "$current_version" | cut -d. -f2)
  # Auto-bump to even minor for standard releases if odd is detected
  if [ $((minor_version % 2)) -ne 0 ]; then
    echo -e "\x1b[33mDetected odd minor $minor_version; bumping to next even...\x1b[0m"
    npm version minor --no-git-tag-version || exit 1
    git add package.json && git commit --amend --no-edit || exit 1
    # Re-read the updated version for downstream steps
    current_version=$(grep '"version":' package.json | head -1 | awk -F'"' '{print $4}')
    minor_version=$(echo "$current_version" | cut -d. -f2)
    echo -e "\x1b[32mVersion updated to $current_version (minor: $minor_version)\x1b[0m"
  fi
fi

# For pre-release, push to dev branch first, then push tags
if [ "$PRE_RELEASE" = true ]; then
  if ! git push origin HEAD:refs/heads/dev; then
    echo -e "\x1b[31mError: Failed to push to dev branch. The name 'dev' might be ambiguous."
    echo -e "Try running: git show-ref | grep dev"
    echo -e "To see all references containing 'dev' and resolve the ambiguity.\x1b[0m"
    exit 1
  fi
  # For pre-release, explicitly push the tag to ensure it's associated with dev branch
  LATEST_TAG=$(git describe --tags --abbrev=0)
  git push origin "$LATEST_TAG"
else
  # For regular releases, just push with follow-tags
  git push --follow-tags
fi

# Display a visually distinctive completion message with release type information
if [ "$PRE_RELEASE" = true ]; then
  # Bold, cyan text for pre-release notification with a distinctive border
  echo -e "\n\x1b[1;36m┌────────────────────────────────────────────────────────────────┐"
  echo -e "│                 🚀 PRE-RELEASE PUBLISH COMPLETE                │"
  echo -e "│                                                                │"
  echo -e "│  CD pipeline will now handle publishing to:                    │"
  echo -e "│  • VS Code Marketplace                                         │"
  echo -e "│  • Open VSX Registry                                           │"

  if [ "$AUTO_PRE_RELEASE_FROM_DEV" = true ]; then
    echo -e "│                                                                │"
    echo -e "│  ⚠️  AUTO PRE-RELEASE: Publishing from dev branch              │"
  fi

  echo -e "└────────────────────────────────────────────────────────────────┘\x1b[0m\n"
else
  # Bold, green text for standard release notification with a distinctive border
  echo -e "\n\x1b[1;32m┌────────────────────────────────────────────────────────────────┐"
  echo -e "│             🚀 STANDARD RELEASE PUBLISH COMPLETE               │"
  echo -e "│                                                                │"
  echo -e "│  CD pipeline will now handle publishing to:                    │"
  echo -e "│  • VS Code Marketplace                                         │"
  echo -e "│  • Open VSX Registry                                           │"
  echo -e "└────────────────────────────────────────────────────────────────┘\x1b[0m\n"
fi
