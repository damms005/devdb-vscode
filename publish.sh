#!/bin/bash

# Initialize variables with default values
VERSION=""
CLOSURE=""
PRE_RELEASE=false

# Display usage function
function show_usage {
  echo -e "\x1b[33mUsage: $0 -v <version> -c [closes-<issue number> | no-closures] [-p]"
  echo -e "\x1b[33mExample: $0 -v patch -c closes-101 -p"
  echo -e "\x1b[33mExample: $0 -v minor -c no-closures"
  echo -e "\x1b[33m  -v: Version (patch, minor, major, etc.)"
  echo -e "\x1b[33m  -c: Closure information (closes-<issue number> or no-closures)"
  echo -e "\x1b[33m  -p: Enable pre-release mode\x1b[0m"
}

# Parse arguments
while getopts "v:c:p" opt; do
  case ${opt} in
    v )
      VERSION=$OPTARG
      ;;
    c )
      CLOSURE=$OPTARG
      ;;
    p )
      PRE_RELEASE=true
      ;;
    \? )
      echo -e "\x1b[31mInvalid option: $OPTARG" 1>&2
      show_usage
      exit 1
      ;;
    : )
      echo -e "\x1b[31mInvalid option: $OPTARG requires an argument" 1>&2
      show_usage
      exit 1
      ;;
  esac
done

# Validate required arguments
if [ -z "$VERSION" ]; then
  echo -e "\x1b[31mError: Version is required (-v)"
  show_usage
  exit 1
fi

if [ -z "$CLOSURE" ]; then
  echo -e "\x1b[31mError: Closure information is required (-c)"
  show_usage
  exit 1
fi

# Validate closure format
if [ "$CLOSURE" != "no-closures" ] && [[ ! "$CLOSURE" =~ ^closes-[0-9]+$ ]]; then
  echo -e "\x1b[31mError: Invalid closure format. Must be 'no-closures' or 'closes-<issue number>'"
  show_usage
  exit 1
fi

# Check if the current branch is 'main' or 'heads/main'
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ] && [ "$current_branch" != "heads/main" ]; then
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

# Determine commit message based on the closure argument
if [ "$CLOSURE" == "no-closures" ]; then
  commit_body=""  # No closure message
elif [[ "$CLOSURE" =~ ^closes-[0-9]+$ ]]; then
  issue_number="${CLOSURE#closes-}"
  commit_body="Closes #$issue_number"  # GitHub auto-close format
fi

# Bump the version using npm version
if [ -n "$commit_body" ]; then
  # Construct the commit message with printf to handle newlines properly
  commit_message=$(printf "%%s\n\n%s" "$commit_body")
  npm version "$VERSION" -m "$commit_message" || exit 1
else
  # Just use npm version without custom commit message body
  npm version "$VERSION" || exit 1
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

# Display a visually distinctive completion message with release type information
if [ "$PRE_RELEASE" = true ]; then
  # Bold, cyan text for pre-release notification with a distinctive border
  echo -e "\n\x1b[1;36m┌────────────────────────────────────────────────────────────────┐"
  echo -e "│                       🚀 PUBLISH COMPLETE                        │"
  echo -e "│                                                                  │"
  echo -e "│  ⚠️  PRE-RELEASE MODE ACTIVATED                                  │"
  echo -e "│  CD pipeline will now handle publishing to:                      │"
  echo -e "│  • VS Code Marketplace                                           │"
  echo -e "│  • Open VSX Registry                                             │"
  echo -e "└────────────────────────────────────────────────────────────────┘\x1b[0m\n"
else
  # Bold, green text for standard release notification with a distinctive border
  echo -e "\n\x1b[1;32m┌────────────────────────────────────────────────────────────────┐"
  echo -e "│                       🚀 PUBLISH COMPLETE                      │"
  echo -e "│                                                                │"
  echo -e "│  ✅ STANDARD RELEASE                                           │"
  echo -e "│  CD pipeline will now handle publishing to:                    │"
  echo -e "│  • VS Code Marketplace                                         │"
  echo -e "│  • Open VSX Registry                                           │"
  echo -e "└────────────────────────────────────────────────────────────────┘\x1b[0m\n"
fi