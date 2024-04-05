#!/bin/bash

# Check if version argument is provided
if [ -z "$1" ]; then
  echo -e "\x1b[31mPlease specify the version (major/minor/patch)."
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
cd $SCRIPT_DIR || exit 1
echo "Current working directory:"
pwd

echo "Building UI..."
cd ../devdb-ui || exit 1
./build.sh || exit 1
echo "UI build complete."

echo "Building UI Shell..."
cd $SCRIPT_DIR || exit 1
cd ./ui-shell || exit 1
./build.sh || exit 1
echo "UI Shell build complete."

cd $SCRIPT_DIR || exit 1
pwd

# Bump the version using npm version
npm version "$1" || exit 1

# Push the tags with git push --follow-tags. This ensure that the tags are pushed to the remote repository.
# This works because npm version creates annotated tags, and git push --follow-tags pushes annotated tags.
# CI/CD pipeline handles publishing to VS Code Marketplace (GitHub Actions).
git push --follow-tags
