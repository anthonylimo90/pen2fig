# Translation rules

Each rule below fixed a real frame that came out wrong. The pure ones are unit-tested in `packages/core/test`.

## Layout

- **A frame with no `layout` key is a horizontal row.** Pencil's default is auto layout in a row, not free positioning. Getting this wrong scrambles almost every screen.
- **`fill_container` only fills inside auto layout.** Elsewhere it is a fixed size: the fallback in parentheses, then the measured bounds, then the parent's size.
- **An auto-layout frame with no size hugs its children.** Figma would give it a fixed 100.
- **Sizes are applied after a node is in its parent,** and a frame is sized before its children are built, so their `fill_container` has something to resolve against.
- **A top-level frame takes its size from the bounds measured in Pencil** when it has no fixed size, so screens come out the same size as the source.
- **`space_around` becomes `SPACE_BETWEEN`.** Figma has no equivalent.
- **Absolutely positioned children keep their `x`/`y`,** inside auto layout too.

## Strokes and paints

- **A stroke without a width draws nothing in Pencil.** The engine sets the weight to 0. Figma's default of 1 would add borders everywhere.
- **Per-side stroke widths** map to per-side weights on frames. Other nodes take the largest side.
- **Paints bound to a variable also store the resolved colour.** Otherwise Figma shows black until the file is reopened. `repairPaints` fixes drift after a build.
- **Text with no fill is invisible in Pencil,** and stays invisible.
- **Gradients:** Pencil's 0° points up. The transform is the inverse of the matrix that maps the gradient onto the node (see `gradientTransform`).

## Fonts

- **Weights are matched by name across foundries:** "SemiBold" vs "Semi Bold", "ExtraBold" vs "Extra Bold".
- **When a style isn't installed, the nearest weight is used,** then italic is dropped, and a warning is recorded. A missing style never stops a build.

## Components and instances

- **Reusable nodes become components,** registered by Pencil id. Build components before the screens that use them; `--components` in the snippet orders them dependencies first.
- **Every built node is tagged with its Pencil id** in shared plugin data. `descendants` paths (`a/b/c`) are resolved by walking those tags.
- **Figma silently ignores some overrides on instance children:** nested sizes and auto-layout direction. The engine checks the result and detaches the instance only when an override didn't take.
- **A replacement subtree that matches the instance's existing children** (same icons, texts and refs, in order) is applied as overrides, so the instance survives. Anything else detaches.
- **Instances can't gain children,** so replacements always detach.

## Images and shaders

- **Image fills build as placeholders** tagged with their source. The plugin uploads each distinct source once and copies the hash to every node that uses it.
- **Local image paths are relative to the `.pen` file.** Pass `--pen-dir` when bundling.
- **Shader fills can't run in Figma.** The engine uses the shader's `u_base` colour. For the real look, render the shader to a PNG at twice the node size and use it as an image fill.

## Variables

- **Variables are imported before the engine starts.** The engine reads local variables once, when it is created, so a variable created afterwards would not bind.
- **The first theme axis becomes the collection's modes** (`mode: [light, dark]` → modes *light* and *dark*). Figma has one set of modes per collection; values that vary on a second axis use their default, with a warning.
- **Later themed entries win,** as in Pencil. An entry with no theme is the default for every mode.
- **`$name` values become aliases,** created after every variable exists so the order in the file doesn't matter.
- **A variable that already exists in another collection is kept** and used as it is. Only the *Pencil* collection is updated on a re-run.
- **A mode the Figma plan doesn't allow** is skipped with a warning. Its values are dropped and the default mode still binds.

## Checks after a build

- **Text overflow:** visible text that runs past its parent or the screen. The walk skips hidden subtrees, because `findAll(n => n.visible)` still returns text inside a hidden parent with stale bounds. It also skips layers that clip on purpose, such as horizontal scroll rows.
- **Size against Pencil:** each screen reports `ok` or `Δw,h`.
- **Missing components:** placeholders left where a `ref` pointed at a component that wasn't built.
- **Overlapping top-level frames,** which usually means a bad position.

## Gaps

- Mesh gradients use their first colour, and shaders use `u_base`.
- `flipX`/`flipY` are ignored, with a warning.
- Rich text runs (mixed styles inside one text node) aren't extracted yet.
- Icons must already exist in Figma as components named `Icon/<name>` and be registered (`engine.register("icon", name, id)`). A built-in Lucide importer is planned.
- Only the first theme axis becomes Figma modes (see [Variables](#variables)).
