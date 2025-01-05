(define (screenshot-style filename
                        border-radius
                        shadow-opacity
                        shadow-blur
                        shadow-offset-x
                        shadow-offset-y)
  (let* ((image (car (gimp-file-load RUN-NONINTERACTIVE filename filename)))
         (drawable (car (gimp-image-get-active-layer image)))
         (width (car (gimp-image-width image)))
         (height (car (gimp-image-height image)))
         ; Create output path with -processed suffix
         (output-path (string-append
                       (substring filename 0 (- (string-length filename) 4))
                       "-processed.png"))
         ; Add padding for shadow
         (new-width (+ width (* shadow-blur 2) (abs shadow-offset-x) 10))
         (new-height (+ height (* shadow-blur 2) (abs shadow-offset-y) 10))
         (offset-x (- shadow-blur shadow-offset-x))
         (offset-y (- shadow-blur shadow-offset-y)))

    ; Start undo group
    (gimp-undo-push-group-start image)

    ; Ensure image has alpha channel
    (gimp-layer-add-alpha drawable)

    ; Resize the image to accommodate shadow
    (gimp-image-resize image new-width new-height offset-x offset-y)

    ; Create rounded corners
    (when (> border-radius 0)
      (let ((mask (car (gimp-layer-create-mask drawable ADD-MASK-WHITE))))
        (gimp-layer-add-mask drawable mask)
        (gimp-image-select-round-rectangle
          image
          CHANNEL-OP-REPLACE
          offset-x
          offset-y
          width
          height
          border-radius
          border-radius)
        (gimp-selection-invert image)
        (gimp-context-set-foreground '(0 0 0))
        (gimp-edit-fill mask FILL-FOREGROUND)
        (gimp-selection-none image)))

    ; Add drop shadow
    (gimp-message "Applying shadow...")
    (script-fu-drop-shadow
      image
      drawable
      shadow-offset-x
      shadow-offset-y
      shadow-blur
      '(0 0 0)    ; Shadow color (black)
      shadow-opacity
      FALSE)      ; Do not resize after applying shadow
    (gimp-message "Shadow applied.")

    ; End undo group
    (gimp-undo-push-group-end image)

    ; Save the image with transparency
    (gimp-message "Saving processed image...")
    (file-png-save2
      RUN-NONINTERACTIVE
      image
      drawable
      output-path
      output-path
      0  ; Interlace
      9  ; Compression
      1  ; Save alpha channel (transparency)
      0  ; Save gamma
      0  ; Save layer offset
      0  ; Save resolution
      0  ; Save creation time
      0  ; Save comment
      0)  ; Save color space
    (gimp-message "Image saved to: ")
    (gimp-message output-path)

    ; Clean up
    (gimp-image-delete image)))

; Register the script
(script-fu-register
  "screenshot-style"                 ; Function name
  "Screenshot Styling"              ; Menu label
  "Apply consistent styling to screenshots with rounded corners and shadow"  ; Description
  "Your Name"                       ; Author
  "Copyright 2025"                  ; Copyright
  "2025-01-04"                     ; Date
  ""                               ; Image type that the script works on
  SF-FILENAME "Image file"         "images/example.png"    ; Input image
  SF-VALUE    "Border Radius"      "12"                    ; Border radius
  SF-VALUE    "Shadow Opacity"     "40"                    ; Shadow opacity (0-100)
  SF-VALUE    "Shadow Blur"        "15"                    ; Shadow blur radius
  SF-VALUE    "Shadow Offset X"    "-8"                    ; Shadow X offset
  SF-VALUE    "Shadow Offset Y"    "8")                    ; Shadow Y offset

; Add menu item
(script-fu-menu-register "screenshot-style" "<Image>/Filters")