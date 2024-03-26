#!/bin/bash
clear
echo 'Building Vue assets'
pwd
npm run build
cd ..
pwd
echo 'Compiling extension code'
npm run compile
cd -
echo 'Back to Vue project folder'
pwd
echo "Completed at $(date +"%Y-%m-%d %I:%M:%S%p")"
