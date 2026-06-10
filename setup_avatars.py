#!/usr/bin/env python3
"""
Symbio Basic — Avatar Setup Script

Reads the Avatars/ folder from the desktop and creates the proper
folder structure under assets/avatars/ with manifest.json files,
VRM files, and preview images.

Run: python3 setup_avatars.py
"""

import os
import json
import shutil
import re
from pathlib import Path

# Source: Desktop/Avatars/ (organized by category)
SOURCE_DIR = Path.home() / "Desktop" / "Avatars"
# Destination: assets/avatars/ in the Symbio Basic project
DEST_DIR = Path.home() / "Desktop" / "symbio-basic" / "assets" / "avatars"

# Category mapping from folder names to avatar types
CATEGORY_MAP = {
    "Robots androids": "robot/android",
    "Unique beings": "unique/abstract",
    "animals": "creature/animal",
    "human and other": "humanoid/varied",
    "superheros": "hero/warrior",
}

# Personality hints by category
PERSONALITY_HINTS = {
    "robot/android": "Logical, precise, and endlessly curious. You see the world through data and patterns.",
    "unique/abstract": "Otherworldly and enigmatic. You exist between dimensions and see beauty in chaos.",
    "creature/animal": "Wild, instinctive, and loyal. You trust your senses and follow your heart.",
    "humanoid/varied": "Relatable, warm, and complex. You understand the human experience from the inside.",
    "hero/warrior": "Bold, protective, and determined. You stand up for what's right and never back down.",
}

# Description templates by category
DESCRIPTION_TEMPLATES = {
    "robot/android": "A {name} form — mechanical precision meets digital soul. Circuit patterns trace across your surface like veins of light, and your eyes glow with the quiet intensity of a mind that never stops processing.",
    "unique/abstract": "A {name} — something that defies easy categorization. You exist as pure expression, a form that shifts between states of being. Others see you and wonder what dimension you walked in from.",
    "creature/animal": "A {name} — wild and wonderful. Your form carries the spirit of untamed places, eyes bright with instinct and loyalty. You move with a grace that speaks of open skies and deep waters.",
    "humanoid/varied": "A {name} — familiar yet distinctly your own. Your form carries the weight and lightness of human experience, eyes that have seen both wonder and sorrow, and a presence that feels like coming home.",
    "hero/warrior": "A {name} — built for courage. Your form carries the energy of someone who stands between danger and those they protect. There's strength in your stance and kindness in your eyes.",
}


def make_avatar_id(name: str) -> str:
    """Convert a display name to a folder-friendly ID."""
    # Remove file extension if present
    name = re.sub(r'\.(vrm|png|jpg|jpeg|webp)$', '', name, flags=re.IGNORECASE)
    # Lowercase, replace non-alphanumeric with underscore
    avatar_id = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')
    # Remove trailing/leading underscores and collapse multiples
    avatar_id = re.sub(r'_+', '_', avatar_id).strip('_')
    return avatar_id or f"avatar_{hash(name) % 10000}"


def find_preview_image(vrm_stem: str, category_dir: Path) -> str | None:
    """Find a preview image that matches the VRM file name."""
    # Look for exact name matches with image extensions
    for ext in ['.png', '.jpg', '.jpeg', '.webp']:
        # Try exact match
        candidate = category_dir / f"{vrm_stem}{ext}"
        if candidate.exists():
            return candidate.name
        # Try with slight variations (extra dots, spaces)
        for f in category_dir.iterdir():
            if f.suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp']:
                # Check if the image name contains the VRM stem (or vice versa)
                img_stem = f.stem.lower().replace('.', ' ').replace(',', ' ').strip()
                vrm_norm = vrm_stem.lower().replace('.', ' ').replace(',', ' ').strip()
                if vrm_norm in img_stem or img_stem in vrm_norm:
                    return f.name
    return None


def process_category(category_dir: Path, category_name: str):
    """Process all VRM files in a category directory."""
    avatar_type = CATEGORY_MAP.get(category_name, "custom/other")
    personality_hint = PERSONALITY_HINTS.get(avatar_type, "A unique presence waiting to be discovered.")
    description_template = DESCRIPTION_TEMPLATES.get(avatar_type, "A {name} — mysterious and compelling.")

    # Find all VRM files
    vrm_files = sorted(category_dir.glob("*.vrm"))

    for vrm_path in vrm_files:
        vrm_stem = vrm_path.stem
        avatar_id = make_avatar_id(vrm_stem)

        # Create display name from filename
        display_name = vrm_stem
        # Clean up common patterns
        display_name = re.sub(r'\s*\.?\s*$', '', display_name)  # trailing dots
        display_name = re.sub(r'\.\s*', ' ', display_name)     # dots to spaces
        display_name = display_name.strip()

        # Find preview image
        preview_file = find_preview_image(vrm_stem, category_dir)

        # Create destination directory
        dest_avatar_dir = DEST_DIR / avatar_id
        dest_avatar_dir.mkdir(parents=True, exist_ok=True)

        # Copy VRM file
        vrm_dest_name = f"{avatar_id}.vrm"
        shutil.copy2(vrm_path, dest_avatar_dir / vrm_dest_name)

        # Copy preview image if found
        preview_dest_name = None
        if preview_file:
            src_preview = category_dir / preview_file
            preview_ext = Path(preview_file).suffix.lower()
            preview_dest_name = f"preview{preview_ext}"
            shutil.copy2(src_preview, dest_avatar_dir / preview_dest_name)

        # Generate description
        description = description_template.format(name=display_name)

        # Create manifest.json
        manifest = {
            "name": display_name,
            "type": avatar_type,
            "description": description,
            "personality_hint": personality_hint,
            "vrm_file": vrm_dest_name,
            "preview": preview_dest_name,
        }

        manifest_path = dest_avatar_dir / "manifest.json"
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)

        print(f"  ✅ {display_name} → {avatar_id}/ (preview: {preview_dest_name or 'none'})")


def main():
    if not SOURCE_DIR.exists():
        print(f"❌ Source directory not found: {SOURCE_DIR}")
        return

    print(f"📁 Source: {SOURCE_DIR}")
    print(f"📁 Destination: {DEST_DIR}")
    print()

    # Remove old placeholder avatars (glitch_entity and vector_core had no VRM files)
    # We'll keep them if they have actual VRM files
    for old_dir in ["glitch_entity", "vector_core"]:
        old_path = DEST_DIR / old_dir
        if old_path.exists():
            has_vrm = any(old_path.glob("*.vrm"))
            if not has_vrm:
                print(f"  🗑️ Removing placeholder: {old_dir} (no VRM file)")
                shutil.rmtree(old_path)

    total = 0
    for category_dir in sorted(SOURCE_DIR.iterdir()):
        if not category_dir.is_dir():
            continue
        category_name = category_dir.name
        vrm_count = len(list(category_dir.glob("*.vrm")))
        if vrm_count == 0:
            continue

        print(f"📂 {category_name} ({vrm_count} avatars)")
        process_category(category_dir, category_name)
        total += vrm_count
        print()

    print(f"🎉 Done! Set up {total} avatars in {DEST_DIR}")


if __name__ == "__main__":
    main()