#!/bin/bash

# Check if version argument is provided
if [ -z "$1" ]; then
  echo -e "\x1b[31mUsage: $0 <version> [closes-<issue number> | no-closures]"
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
  commit_message=""  # Let npm version use its default message
elif [[ "$2" =~ ^closes-[0-9]+$ ]]; then
  issue_number="${2#closes-}"
  commit_message="closes issue #$issue_number"
else
  echo -e "\x1b[31mInvalid argument for closures. Usage: $0 <version> [closes-<issue number> | no-closures]"
  exit 1
fi

# Bump the version using npm version with custom commit message if provided
if [ -n "$commit_message" ]; then
  npm version "$1" -m "$commit_message" || exit 1
else
  npm version "$1" || exit 1
fi

# Push the tags with git push --follow-tags
git push --follow-tags

echo -e "\n\nCD pipeline will now handle publishing to VS Code Marketplace.\n\n"