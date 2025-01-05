# This script processes images in a specified input folder, applying rounded corners and shadows.
# Usage: python script.py <input_folder> [output_folder]
# Note that the output folder is optional.
#
# Example: python3 screenshot.py images

from PIL import Image, ImageOps, ImageDraw, ImageFilter
import os
import shutil
from pathlib import Path

def clear_folder(folder_path):
    """Clear all contents of the specified folder."""
    folder_path = Path(folder_path)
    if folder_path.exists():
        shutil.rmtree(folder_path)
    folder_path.mkdir(parents=True)

def create_rounded_rectangle(size, radius):
    """Create a rounded rectangle mask."""
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [(0, 0), (size[0] - 1, size[1] - 1)],
        radius=radius,
        fill=255
    )
    return mask

def create_inner_shadow(size, radius, shadow_width=3, shadow_intensity=30):
    """Create an inner shadow effect."""
    # Create base mask with rounded corners
    base_mask = create_rounded_rectangle(size, radius)

    # Create a slightly smaller mask for the inner part
    smaller_size = (size[0] - shadow_width * 2, size[1] - shadow_width * 2)
    inner_mask = create_rounded_rectangle(smaller_size, max(radius - shadow_width, 0))

    # Create the shadow image
    shadow = Image.new('RGBA', size, (0, 0, 0, 0))
    shadow.paste(Image.new('RGBA', size, (0, 0, 0, shadow_intensity)), mask=base_mask)

    # Paste the inner mask to create the cutout
    inner_shadow = Image.new('RGBA', smaller_size, (0, 0, 0, 0))
    shadow.paste(inner_shadow, (shadow_width, shadow_width), mask=inner_mask)

    # Apply gaussian blur
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=shadow_width))

    return shadow

def process_image(input_path, output_folder):
    # Handle input and output paths
    input_path = Path(input_path)
    output_path = output_folder / f"{input_path.stem}.png"

    # Open and convert image
    img = Image.open(input_path).convert('RGBA')

    # Create rounded corner mask
    radius = 15
    mask = create_rounded_rectangle(img.size, radius)

    # Apply the mask for rounded corners
    output = Image.new('RGBA', img.size, (0, 0, 0, 0))
    output.paste(img, mask=mask)

    # Create and apply inner shadow
    inner_shadow = create_inner_shadow(img.size, radius)
    output = Image.alpha_composite(output, inner_shadow)

    # Create outer shadow
    shadow_expansion = 60
    shadow_size = (img.size[0] + shadow_expansion * 2,
                  img.size[1] + shadow_expansion * 2)

    shadow = Image.new('RGBA', shadow_size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        [(shadow_expansion, shadow_expansion),
         (shadow_size[0] - shadow_expansion, shadow_size[1] - shadow_expansion)],
        radius=radius,
        fill=(0, 0, 0, 60)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=25))

    # Create final composition
    padding = 60
    final_size = (img.size[0] + padding * 2, img.size[1] + padding * 2)
    final_image = Image.new('RGBA', final_size, (0, 0, 0, 0))

    # Paste shadow with offset
    shadow_offset = 15
    final_image.paste(shadow,
                     (padding - shadow_expansion + shadow_offset,
                      padding - shadow_expansion + shadow_offset),
                     shadow)

    # Paste main image with inner shadow
    final_image.paste(output, (padding, padding), output)

    # Save the result
    final_image.save(output_path, 'PNG')
    return output_path

def process_folder(input_folder, output_folder=None):
    supported_formats = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}

    input_folder = Path(input_folder)
    if not input_folder.is_dir():
        raise ValueError("The input path is not a directory")

    if output_folder is None:
        output_folder = input_folder.parent / f"{input_folder.name}-processed"
    else:
        output_folder = Path(output_folder)

    clear_folder(output_folder)

    processed_files = []
    for file_path in input_folder.iterdir():
        if file_path.suffix.lower() in supported_formats:
            try:
                output_path = process_image(file_path, output_folder)
                processed_files.append(output_path)
                print(f"Processed: {file_path.name} -> {output_path.name}")
            except Exception as e:
                print(f"Error processing {file_path.name}: {str(e)}")

    return processed_files

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2 or len(sys.argv) > 3:
        print("Usage: python script.py <input_folder> [output_folder]")
        sys.exit(1)

    input_folder = sys.argv[1]
    output_folder = sys.argv[2] if len(sys.argv) == 3 else None

    try:
        processed_files = process_folder(input_folder, output_folder)
        print(f"\nSuccessfully processed {len(processed_files)} images")
    except Exception as e:
        print(f"Error: {str(e)}")
        sys.exit(1)