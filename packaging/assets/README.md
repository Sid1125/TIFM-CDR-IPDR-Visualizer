# Installer branding assets

Generated from the canonical logo files in `backend/static/` — regenerate here if those change,
don't hand-edit the binaries below.

| File | Used by | Source |
|------|---------|--------|
| `logo.ico` | `argus.spec` (EXE icon) + `argus_installer.iss` (`SetupIconFile`) | `backend/static/logo-mark.png` (256×256 square mark) |
| `wizard_large.bmp` | `argus_installer.iss` (`WizardImageFile` — Welcome/Finished page banner) | `backend/static/logo-readme.png` (full lockup), centered on navy `#0d1b2a` |
| `wizard_small.bmp` | `argus_installer.iss` (`WizardSmallImageFile` — top-right mark on inner pages) | `backend/static/logo-mark.png`, centered on white |

Inno Setup requires `.ico`/`.bmp` specifically — PNGs aren't accepted directly, hence the conversion
step. Regenerate with (run from `backend/`, needs Pillow — `pip install Pillow`):

```python
from PIL import Image

mark = Image.open("static/logo-mark.png").convert("RGBA")
full = Image.open("static/logo-readme.png").convert("RGBA")
NAVY = (13, 27, 42, 255)  # #0d1b2a

def paste_centered(canvas, img, max_w, max_h):
    scale = min(max_w / img.width, max_h / img.height)
    w, h = max(1, int(img.width * scale)), max(1, int(img.height * scale))
    resized = img.resize((w, h), Image.LANCZOS)
    canvas.paste(resized, ((canvas.width - w) // 2, (canvas.height - h) // 2), resized)
    return canvas

mark.save("../packaging/assets/logo.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])

large = Image.new("RGBA", (192, 386), NAVY)
paste_centered(large, full, 150, 320)
large.convert("RGB").save("../packaging/assets/wizard_large.bmp", format="BMP")

small = Image.new("RGBA", (55, 58), (255, 255, 255, 255))
paste_centered(small, mark, 44, 44)
small.convert("RGB").save("../packaging/assets/wizard_small.bmp", format="BMP")
```

Then rebuild: `./build.ps1` (picks up the new `.ico` for the exe) followed by
`iscc argus_installer.iss` (picks up all three for the installer).
