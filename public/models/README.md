# Tank Model Override

Drop your editable tank model here with this exact name:

- `player-tank.glb`

The game will auto-load it at runtime from `/models/player-tank.glb`.
If the file is missing or fails to load, the built-in procedural tank is used as fallback.

## Recommended Blender export

1. Apply transforms (Ctrl+A -> Rotation & Scale).
2. Keep forward axis consistent (model nose pointing forward in your authoring scene).
3. Export as glTF Binary (`.glb`).
4. Use low-poly + baked textures for performance.

## Optional named empties for accurate muzzle points

If you include these object names, projectile spawn points will use them:

- `MuzzleCannon`
- `MuzzleMG`

Without these names, the game uses default muzzle offsets.
