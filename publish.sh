#!/bin/bash

# Check if the current branch is 'main'
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo -e "\x1b[31mError:\x1b[0m The publish script can only be run from the main branch."
  exit 1
fi

# Bump the version using npm version
npm version "$1" || exit 1

# Push the tags with git push --follow-tags
git push --follow-tags
