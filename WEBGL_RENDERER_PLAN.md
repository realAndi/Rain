# Rain WebGL2 Terminal Renderer -- Implementation Plan

## Overview

Build a native WebGL2 GPU-accelerated terminal renderer that draws the entire terminal grid in 2 instanced draw calls (backgrounds + glyphs). This replaces Canvas2D as the default renderer when WebGL2 is available, putting Rain ahead of Tabby/xterm.js by using color-as-attribute (not baked into atlas), Rust-side pre-styling, and the existing per-row dirty tracking infrastructure.

---

## Phase 1: Foundation -- Shaders and WebGL2 Context

The base layer: get a WebGL2 context, compile shaders, and draw a solid colored rectangle.

- [x] **1.1** Create `src/lib/webglRenderer.ts` with the `WebGLTerminalRenderer` class skeleton
  - Constructor takes `HTMLCanvasElement` + `CanvasRendererConfig` (reuse existing interface)
  - Initialize WebGL2 context with `{ alpha: false, antialias: false, premultipliedAlpha: false }`
  - Handle context loss (`webglcontextlost` / `webglcontextrestored` events)
  - Store `charWidth`, `charHeight`, `viewportWidth`, `viewportHeight` (same as Canvas2D renderer)
- [x] **1.2** Write the background vertex shader
  - Per-instance attributes: `a_position` (vec2: col, row), `a_size` (vec2: width=1, height=1), `a_color` (vec4: rgba)
  - Uniform: `u_projection` (mat4: orthographic projection mapping grid coords to clip space)
  - Transform: `gl_Position = u_projection * vec4(a_position * cellSize + offset, 0.0, 1.0)`
- [x] **1.3** Write the background fragment shader
  - Simply outputs `v_color` passed from vertex shader
  - Discard fragments with alpha < 0.01 (skip default-bg cells)
- [x] **1.4** Write the glyph vertex shader
  - Per-instance attributes: `a_position` (vec2: col, row), `a_texCoord` (vec4: atlas UV rect), `a_fgColor` (vec4: rgba)
  - Pass UV coordinates and color to fragment shader
- [x] **1.5** Write the glyph fragment shader
  - Sample glyph texture at interpolated UV coordinates
  - Multiply sampled alpha by `v_fgColor` -- the atlas stores only alpha (grayscale mask), color comes from the attribute
  - Discard if alpha < 0.01
- [x] **1.6** Implement shader compilation and program linking
  - `compileShader(type, source)` helper
  - `createProgram(vertexShader, fragmentShader)` helper
  - Cache attribute and uniform locations
  - Error handling with shader compile log on failure
- [x] **1.7** Set up the orthographic projection matrix
  - Maps `(0,0)` to top-left, `(cols * charWidth, rows * charHeight)` to bottom-right
  - Update on resize
- [x] **1.8** Verify: render a solid colored quad covering the full viewport
  - Confirms WebGL2 pipeline works end-to-end

---

## Phase 2: Glyph Texture Atlas

Rasterize characters via Canvas2D, upload to a WebGL2 texture. Unlike xterm.js which bakes fg+bg color into each atlas entry, Rain stores only the alpha mask and applies color as a per-instance attribute. This makes the atlas 10-50x more compact.

- [x] **2.1** Create `WebGLGlyphAtlas` class
  - Internal `OffscreenCanvas` (or `HTMLCanvasElement` fallback) for rasterization
  - WebGL2 texture handle (`gl.createTexture()`)
  - Atlas layout: 64 columns, grows vertically (same pattern as Canvas2D `GlyphCache`)
  - Max height cap (512 rows of cells) with clear-and-rebuild on overflow
- [x] **2.2** Implement glyph rasterization
  - Key: `(char, bold, italic)` -- NOT color (color is applied at render time)
  - Render character to offscreen canvas using `fillText` with white foreground on transparent background
  - Return atlas position `{ x, y, width, height }` in texture coordinates (0.0 - 1.0)
- [x] **2.3** Implement texture upload
  - `gl.texImage2D()` for initial creation
  - `gl.texSubImage2D()` for incremental glyph additions (upload only the new glyph region)
  - `gl.LUMINANCE_ALPHA` or `gl.ALPHA` format for the alpha-only atlas
  - Linear filtering for retina displays, nearest for 1x DPR
- [x] **2.4** Implement atlas growth
  - When atlas is full, create larger texture, copy old via `gl.copyTexSubImage2D()` or re-upload
  - Clear and rebuild when max height reached (same as Canvas2D)
- [x] **2.5** Implement cache lookup
  - `Map<string, { u0, v0, u1, v1 }>` mapping glyph key to UV coordinates
  - O(1) lookup per cell
- [x] **2.6** Verify: render a single character "A" at position (0,0) using the atlas
  - Confirms rasterization -> upload -> sampling pipeline works

---

## Phase 3: Instance Buffer Management

Pack per-cell data into typed arrays and upload to the GPU for instanced rendering.

- [x] **3.1** Design the instance data layout
  - Background instances: `[col, row, width, r, g, b, a]` per cell = 7 floats
  - Glyph instances: `[col, row, u0, v0, u1, v1, r, g, b, a]` per cell = 10 floats
  - Pre-allocate `Float32Array(rows * cols * stride)` for each buffer
- [x] **3.2** Implement `rebuildRowInstances(row)` method
  - Iterate grid cells for the given row
  - Write background instance data for cells with non-default bg
  - Write glyph instance data for non-space cells, looking up UV coords from atlas
  - Track instance count per row for offset calculation
- [x] **3.3** Implement GPU buffer management
  - Create `gl.ARRAY_BUFFER` for backgrounds and glyphs
  - `gl.bufferData()` with `gl.DYNAMIC_DRAW` for initial allocation
  - `gl.bufferSubData()` for per-row partial updates (only upload dirty row data)
- [x] **3.4** Set up vertex attribute pointers with instancing
  - `gl.vertexAttribDivisor(location, 1)` for per-instance attributes
  - Shared unit quad geometry (4 vertices, 6 indices) as the base mesh
  - Instance attributes provide position, size, color, UV per cell
- [x] **3.5** Integrate with dirty row tracking
  - On `updateLine(row, spans)`: update grid cells, mark row dirty, call `scheduleRender()`
  - On `render()`: for each dirty row, call `rebuildRowInstances(row)` + `bufferSubData`
  - On `fullDirty`: rebuild all rows + full `bufferData` upload
- [x] **3.6** Verify: render a full grid of characters with colored backgrounds
  - Confirms instance buffer pipeline works end-to-end

---

## Phase 4: Full Render Pipeline

Assemble the complete render cycle with overlays.

- [x] **4.1** Implement the main `render()` method
  - Clear viewport with default bg color
  - Rebuild dirty row instance data
  - Upload dirty row data via `bufferSubData`
  - Draw call 1: `gl.drawArraysInstanced()` for backgrounds
  - Draw call 2: `gl.drawArraysInstanced()` for glyphs
  - Reset dirty tracking
- [x] **4.2** Implement `renderCursor(row, col, shape, color)`
  - Draw a single colored quad at the cursor position
  - Support block (filled), underline (bottom bar), and bar (left edge) shapes
  - Use alpha blending for block cursor
- [x] **4.3** Implement `renderSelection(startRow, startCol, endRow, endCol, color)`
  - Draw semi-transparent quads covering the selected region
  - Handle multi-line selections (first line partial, middle lines full, last line partial)
- [x] **4.4** Implement `renderSearchMatches(matches, matchColor, currentColor)`
  - Draw highlight quads for each search match
  - Different color/opacity for current vs other matches
- [x] **4.5** Implement URL underline rendering
  - Draw thin colored lines under detected URL ranges
  - Reuse `urlRanges` map from `updateLine()` (same as Canvas2D renderer)
- [x] **4.6** Implement underline and strikethrough decorations
  - For cells with `underline: true`, draw a 1px line at the bottom of the cell
  - For cells with `strikethrough: true`, draw a 1px line at the middle
  - Can be done as additional thin quad instances or as separate line draw calls
- [x] **4.7** Verify: render a complete terminal session with colors, cursor, selection, and search

---

## Phase 5: Integration into Terminal.tsx

Wire the WebGL renderer into the existing component with auto-detection and fallback.

- [x] **5.1** Add `canUseWebGLRenderer()` detection function
  - Try `canvas.getContext("webgl2")` -- return true if non-null
  - Export from `webglRenderer.ts`
- [x] **5.2** Update `ensureCanvasRenderer()` in Terminal.tsx
  - If WebGL2 available and renderer is not `"dom"`: create `WebGLTerminalRenderer`
  - Else if Canvas2D available: create `CanvasTerminalRenderer`
  - Else: fall through to DOM rendering
  - Both renderer classes share the same public API -- no other changes needed
- [x] **5.3** Handle WebGL2 context loss gracefully
  - On `webglcontextlost`: pause rendering, show a brief overlay message
  - On `webglcontextrestored`: recreate shaders, textures, buffers, mark full dirty
  - If context cannot be restored: fall back to Canvas2D renderer
- [x] **5.4** Verify: Terminal.tsx renders via WebGL2 when available, Canvas2D when not

---

## Phase 6: Config and Settings UI

- [x] **6.1** Update `RainConfig.renderer` type in config.ts
  - Change from `"dom" | "canvas"` to `"dom" | "canvas" | "webgl" | "auto"`
  - Default: `"auto"` (tries WebGL2 -> Canvas2D -> DOM)
- [x] **6.2** Update `useCanvasViewport()` logic in Terminal.tsx
  - `"auto"`: try WebGL2 first, then Canvas2D
  - `"webgl"`: WebGL2 only, fall back to Canvas2D if unavailable
  - `"canvas"`: Canvas2D only
  - `"dom"`: DOM only
- [x] **6.3** Update Settings.tsx renderer selector
  - Four options: Auto (recommended) / WebGL / Canvas / DOM
  - Show which renderer is actually active (e.g. "Auto (using WebGL)")
  - Updated hint text explaining the performance tradeoffs

---

## Phase 7: Testing and Polish

- [ ] **7.1** Stress test with `cat /dev/urandom | head -c 10000000 | base64`
  - Measure frame rate, CPU usage, memory consumption
  - Compare WebGL vs Canvas2D vs DOM
- [ ] **7.2** Test with TUI applications
  - vim, htop, tmux -- verify alt-screen rendering
  - Wide characters (CJK) -- verify positioning
- [ ] **7.3** Test edge cases
  - Very small terminal (3x3)
  - Very large terminal (400x100)
  - Font size changes while rendering
  - DPR changes (retina <-> non-retina display)
  - Theme switching while active
- [ ] **7.4** Test fallback chain
  - Force WebGL2 unavailable -- verify Canvas2D takes over
  - Force Canvas2D unavailable -- verify DOM takes over
  - WebGL2 context loss during rendering -- verify recovery
- [ ] **7.5** Performance profiling
  - Measure time per render frame at various grid sizes
  - Measure GPU memory consumption
  - Measure glyph atlas texture size vs Canvas2D atlas size
  - Target: < 1ms per frame for 80x24, < 4ms for 200x50
- [x] **7.6** Clean up and finalize
  - Remove any debug logging (none found)
  - Ensure all resources are freed on `destroy()` (verified)
  - Added 25 automated unit tests for pure helper functions
  - Items 7.1-7.5 require manual testing in the running Tauri app

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/lib/webglRenderer.ts` | **New** | WebGL2 renderer (~1320 lines) |
| `src/lib/__tests__/webglRenderer.test.ts` | **New** | 25 unit tests for renderer helpers |
| `src/lib/canvasRenderer.ts` | Unchanged | Stays as Canvas2D fallback |
| `src/stores/config.ts` | Modified | Added `"webgl"` and `"auto"` to renderer type, default `"auto"` |
| `src/components/Terminal.tsx` | Modified | Auto-detect WebGL2 in `ensureCanvasRenderer()`, union type |
| `src/components/Settings.tsx` | Modified | Four-button renderer selector (Auto/WebGL/Canvas/DOM) |

## Key Design Decisions

1. **Color-as-attribute, not in atlas**: One atlas entry per `(char, bold, italic)`. Color applied via per-instance vec4. xterm.js bakes `(char, bold, italic, fg, bg)` into each entry, requiring 10-50x more atlas space.

2. **Alpha-only atlas texture**: Store glyph shapes as grayscale masks. Multiply by fg color in the fragment shader. Smaller texture, fewer cache misses.

3. **Same public API as Canvas2D**: `WebGLTerminalRenderer` and `CanvasTerminalRenderer` are interchangeable. Terminal.tsx doesn't need to know which one is active.

4. **Per-row buffer updates**: Only rebuild and upload instance data for dirty rows. A single-line change uploads ~10 floats per cell x ~80 cols = ~3.2KB via `bufferSubData`. Full grid rebuild for 200x50 = ~700KB, done only on resize.

5. **Fallback chain**: WebGL2 -> Canvas2D -> DOM. Each level is a complete implementation. No partial states.
