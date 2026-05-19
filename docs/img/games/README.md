# Deck skin images

Drop a per-game image file here named after the directory under `docs/midi-files/`. When a track loads, the deck shows a low-opacity (~14%) background using whichever extension is found first: `webp` → `jpg` → `png`.

Examples:

- `contra.webp`
- `donkey-kong.jpg`
- `street-fighter.png`

If no file matches the loaded track's game, the deck stays plain. The loader caches misses, so adding a file requires a page reload to pick it up.

Recommended: 1280×720 or larger, dark / high-contrast images work best at the low opacity.
