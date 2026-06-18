# Sound asset provenance

Sound effects in this directory are sourced from [freesound.org](https://freesound.org)
under the **Creative Commons 0 (CC0)** license, except where the table notes
otherwise. Under CC0, no attribution is required for use — but it's still
credited here as a courtesy to the authors.

If you replace any of these files, keep this document in sync.

| File              | freesound page                                                          | Author       | License | Notes                                  |
| ----------------- | ----------------------------------------------------------------------- | ------------ | ------- | -------------------------------------- |
| `player_laser.mp3` | https://freesound.org/people/hotpin7/sounds/819682/                    | hotpin7      | CC0     | 0.7s arcade blaster "pew"              |
| `enemy_laser.mp3`  | https://freesound.org/people/xkeril/sounds/702000/                     | xkeril       | CC0     | 1.9s heavy blaster shot — darker tone  |
| `hit.mp3`          | https://freesound.org/people/SeanSecret/sounds/440668/                 | SeanSecret   | CC0     | 1.5s electric impact crackle           |
| `explosion.mp3`    | https://freesound.org/people/OwlStorm/sounds/404755/                   | OwlStorm     | CC0     | 1.46s retro arcade explosion           |
| `engine_hum.mp3`   | https://freesound.org/people/cabled_mess/sounds/338368/                | cabled_mess  | CC0     | 1.9s seamless looping spaceship drone  |
| `missile_warning.mp3` | — (project asset)                                                   | project owner | project asset | 0.2s RWR warning blip for the incoming-missile warning; provided as WAV, converted to MP3 (44.1 kHz mono) |
| `jump-drive-novari.mp3` | — (derived from `jump-drive.mp3`)                                 | project owner | inherits source | Machines/Novari jump-drive timbre. Derived from `jump-drive.mp3` via ffmpeg: `rubberband=pitch=0.72,vibrato=f=2.2:d=0.8` (pitch down ~5½ semitones + slow heavy "seasick" wobble) |

Downloaded `-hq.mp3` previews from freesound's CDN (`cdn.freesound.org/previews/...`).
These are smaller than the original WAVs but plenty of quality for game SFX.
