# Space backdrops

The three additional 1536 × 1024 PNG textures were generated with the built-in image generation tool. The original purple JPEG remains available. Backgrounds are assigned by the map catalog in `shared/src/Maps.ts`, and the same image supplies ship reflections in solo and multiplayer:

| Map | Background |
| --- | --- |
| The Void | Icy blue |
| The Belt | Amber |
| The Veil | Original purple |
| The Wreck | Amber |
| The Tempest | Teal green |
| The Eye | Teal green |
| The Canyon | Planet terrain (no space backdrop) |

`applyMapConfig` sets `GameConfig.scenery.backdrop.variant` on every launch. Older editor drafts without a `backdrop` field fall back to purple. Random map selection still chooses a map, but its backdrop is fixed.

All backgrounds use the existing two-axis WRAP addressing and parallax. New textures were inspected in 2 × 2 repeat previews, including the four-corner junction. Mean RGB differences across the horizontal/vertical boundaries (0–255 scale) were teal 2.78/3.54, amber 2.49/2.71, and ice 3.26/4.07; interior neighboring-pixel differences were 2.99–3.34. These measurements support the visual inspection, rather than claiming exact edge-pixel equality.

## Generation prompts

### teal

Asset: `client/public/textures/space-backdrop-teal.png`

Use case: stylized-concept. Asset type: seamless repeating space background texture for a scrolling space combat game. Generate a single landscape 1536x1024 image, no collage. Deep nearly black space with extremely fine scattered stars, faint wisps of detailed nebula gas, tiny remote galaxies, photographic astronomical texture. Keep overall luminance low, plenty of dark negative space so gameplay remains readable. CRITICAL: truly seamless periodic tiling on BOTH axes: left edge matches right, top matches bottom, cloud shapes and brightness continue smoothly through boundaries, corners match. No border, vignette, edge darkening, central focal object, planets, spacecraft, text or watermark. Asymmetric organic distribution without obvious repeated motifs. Theme: Veil of teal. Wispy emerald and cyan filaments wind loosely through black space, faint turquoise emission clouds with occasional delicate pale aqua stars. Subtle, airy, mysterious.

### amber

Asset: `client/public/textures/space-backdrop-amber.png`

Use case: stylized-concept. Asset type: seamless repeating space background texture for a scrolling space combat game. Generate a single landscape 1536x1024 image, no collage. Deep nearly black space with extremely fine scattered stars, faint wisps of detailed nebula gas, tiny remote galaxies, photographic astronomical texture. Keep overall luminance low, plenty of dark negative space so gameplay remains readable. CRITICAL: truly seamless periodic tiling on BOTH axes: left edge matches right, top matches bottom, cloud shapes and brightness continue smoothly through boundaries, corners match. No border, vignette, edge darkening, central focal object, planets, spacecraft, text or watermark. Asymmetric organic distribution without obvious repeated motifs. Theme: Amber rift. Rust-red and muted copper emission clouds with delicate amber dust filaments separated by broad dark dust lanes, small warm stars mixed with cool white pinpoints. Subtle warm cosmic atmosphere, no giant bright fireball.

### ice

Asset: `client/public/textures/space-backdrop-ice.png`

Use case: stylized-concept. Asset type: seamless repeating space background texture for a scrolling space combat game. Generate a single landscape 1536x1024 image, no collage. Deep nearly black space with extremely fine scattered stars, faint wisps of detailed nebula gas, tiny remote galaxies, photographic astronomical texture. Keep overall luminance low, plenty of dark negative space so gameplay remains readable. CRITICAL: truly seamless periodic tiling on BOTH axes: left edge matches right, top matches bottom, cloud shapes and brightness continue smoothly through boundaries, corners match. No border, vignette, edge darkening, central focal object, planets, spacecraft, text or watermark. Asymmetric organic distribution without obvious repeated motifs. Theme: Frozen deep field. Sparse silver-blue stars with faint smoky cobalt and glacial blue nebula tendrils, a handful of tiny distant galaxies, extensive midnight navy voids. Crisp cold deep-space atmosphere, no large bright objects.

