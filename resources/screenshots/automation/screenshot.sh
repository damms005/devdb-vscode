#!/bin/bash

# Process all PNG files in the images directory
for file in images/*.png; do
    if [ -f "$file" ]; then
        echo "Processing: $file"
        /Applications/GIMP.app/Contents/MacOS/gimp -i -b "(screenshot-style \"$file\" 12 40 15 -8 8)" -b '(gimp-quit 0)'
    fi
done

echo "Processing complete! Check the images folder for *-processed.png files"