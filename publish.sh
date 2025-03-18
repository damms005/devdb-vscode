#!/bin/bash

# Initialize pre-release flag
PRE_RELEASE=false

# Parse arguments
for arg in "$@"; do
  if [ "$arg" = "--pre-release" ]; then
    PRE_RELEASE=true
    break
  fi
done

# Check if version argument is provided
if [ -z "$1" ]; then
  echo -e "\x1b[31mUsage: $0 <version> [closes-<issue number> | no-closures] [--pre-release]"
  exit 1
fi

# Check if the current branch is 'main'
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo -e "\x1b[31mThe publish script can only be run from the main branch."
  exit 1
fi

# cd to the dir where this script is located
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
cd "$SCRIPT_DIR" || exit 1
echo "Current working directory:"
pwd

echo "Ensure OK..."
bun run pretest || exit 1
echo "Ok."

echo "Ensure tests are passing..."
bun run test-services || exit 1
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
  echo -e "\x1b[31mInvalid argument for closures. Usage: $0 <version> [closes-<issue number> | no-closures]"
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

# Push the tags and to dev branch if pre-release
if [ "$PRE_RELEASE" = true ]; then
  git push origin HEAD:dev || exit 1
fi

# Push the tags with git push --follow-tags
git push --follow-tags

echo -e "\n\nCD pipeline will now handle publishing to VS Code Marketplace and Open VSX Registry.\n\n"
